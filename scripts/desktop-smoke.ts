#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createPeerSimulator } from '../src/dev/peerSimulator';

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const availableTcpPort = (): Promise<number> => new Promise((done, fail) => {
  const server = createServer();
  server.once('error', fail);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    assert(address && typeof address !== 'string');
    server.close(() => done(address.port));
  });
});

const availableUdpPort = (): Promise<number> => new Promise((done, fail) => {
  const socket = createSocket('udp4');
  socket.once('error', fail);
  socket.bind(0, () => {
    const address = socket.address();
    socket.close(() => done(address.port));
  });
});

const waitFor = async (label: string, test: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await test()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

interface CdpReply {
  id?: number;
  result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
  error?: { message: string };
}

class CdpPage {
  private nextId = 1;
  private pending = new Map<number, { resolve: (reply: CdpReply) => void; reject: (error: Error) => void }>();

  private constructor(private socket: WebSocket) {
    socket.onmessage = (event) => {
      const reply = JSON.parse(String(event.data)) as CdpReply;
      if (reply.id === undefined) return;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.error) pending.reject(new Error(reply.error.message));
      else pending.resolve(reply);
    };
    socket.onclose = () => {
      for (const pending of this.pending.values()) pending.reject(new Error('Desktop page closed.'));
      this.pending.clear();
    };
  }

  static async connect(port: number): Promise<CdpPage> {
    let pageUrl = '';
    await waitFor('packaged renderer', async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await response.json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
        pageUrl = targets.find((target) => target.type === 'page')?.webSocketDebuggerUrl ?? '';
        return Boolean(pageUrl);
      } catch {
        return false;
      }
    });
    const socket = new WebSocket(pageUrl);
    await new Promise<void>((done, fail) => {
      socket.onopen = () => done();
      socket.onerror = () => fail(new Error('Could not connect to the packaged renderer.'));
    });
    const page = new CdpPage(socket);
    await page.send('Runtime.enable');
    return page;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpReply> {
    const id = this.nextId++;
    return new Promise((done, fail) => {
      this.pending.set(id, { resolve: done, reject: fail });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const reply = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.text ?? 'Renderer evaluation failed.');
    return reply.result?.result?.value;
  }

  async click(selector: string): Promise<void> {
    const clicked = await this.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) return false; element.click(); return true; })()`);
    assert.equal(clicked, true, `Missing UI control: ${selector}`);
  }

  async fill(selector: string, value: string): Promise<void> {
    const filled = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    assert.equal(filled, true, `Missing UI field: ${selector}`);
  }

  async text(): Promise<string> {
    return String(await this.evaluate('document.body.innerText'));
  }

  async closeWindow(): Promise<void> {
    await this.send('Page.close');
    this.socket.close();
  }
}

const run = async (): Promise<void> => {
  const appPath = resolve(process.argv[2] ?? 'release/linux-unpacked/uchat');
  const profileDir = mkdtempSync(resolve(tmpdir(), 'uchat-desktop-smoke-'));
  const [udpPort, tcpPort, debugPort] = await Promise.all([
    availableUdpPort(), availableTcpPort(), availableTcpPort()
  ]);
  const roomName = `Uchat desktop smoke ${Date.now()}`;
  const passphrase = `desktop-smoke-${Date.now()}`;
  const peer = createPeerSimulator({ roomName, passphrase, displayName: 'Smoke peer', udpPort });
  let app: ChildProcess | null = null;
  let appLog = '';

  const launch = async (): Promise<CdpPage> => {
    app = spawn(appPath, [
      '--no-sandbox', '--disable-gpu', '--disable-gpu-compositing',
      `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    app.stdout?.on('data', (chunk: Buffer) => { appLog += chunk.toString(); });
    app.stderr?.on('data', (chunk: Buffer) => { appLog += chunk.toString(); });
    const page = await CdpPage.connect(debugPort);
    await waitFor('Uchat UI', async () => (await page.text()).includes('Private local chat'));
    return page;
  };

  const join = async (page: CdpPage, secret: string): Promise<void> => {
    await page.click('.room-switcher');
    await page.fill('#room-name', roomName);
    await page.fill('#room-passphrase', secret);
    await page.click('.advanced-settings summary');
    await page.fill('#udp-port', String(udpPort));
    await page.fill('#tcp-port', String(tcpPort));
    await page.click('.connection-form button[type="submit"]');
    await waitFor('room join', async () => {
      const text = await page.text();
      if (text.includes('Could not join room')) throw new Error(text.slice(0, 350));
      const settingsClosed = await page.evaluate('document.querySelector(".connection-form") === null');
      return settingsClosed === true && text.includes(roomName) && text.includes('nearby');
    });
  };

  try {
    await peer.start();
    let page = await launch();
    await join(page, passphrase);
    await waitFor('LAN peer discovery', async () => (await page.text()).includes('1 nearby'));
    await waitFor('encrypted peer session', () => peer.getState().connectedPeers.length === 1);

    await page.fill('.composer textarea', 'broadcast desktop smoke');
    await page.click('.composer button[type="submit"]');
    await waitFor('broadcast delivery in UI', async () => (await page.text()).includes('broadcast desktop smoke'));
    await waitFor('broadcast receipt by peer', () => peer.getState().logEntries.some((entry) =>
      entry.kind === 'incoming' && entry.scope === 'broadcast' && entry.body === 'broadcast desktop smoke'));
    await waitFor('broadcast delivery acknowledgment', async () => Boolean(await page.evaluate(`Array.from(document.querySelectorAll('.message.local')).some((element) => element.textContent?.includes('broadcast desktop smoke') && element.textContent?.includes('delivered'))`)));
    await peer.sendMessage({ body: 'broadcast reply smoke', scope: 'broadcast' });
    await waitFor('broadcast reply and attribution', async () => {
      return Boolean(await page.evaluate(`Array.from(document.querySelectorAll('.message.peer')).some((element) => element.textContent?.includes('broadcast reply smoke') && element.querySelector('.message-sender')?.textContent === 'Smoke peer')`));
    });

    await page.click('.conversation-row:not(.broadcast-row)');
    await page.fill('.composer textarea', 'direct desktop smoke');
    await page.click('.composer button[type="submit"]');
    await waitFor('direct receipt by peer', () => peer.getState().logEntries.some((entry) =>
      entry.kind === 'incoming' && entry.scope === 'direct' && entry.body === 'direct desktop smoke'));
    await peer.sendMessage({ body: 'direct reply smoke', scope: 'direct' });
    await waitFor('direct reply and attribution', async () => Boolean(await page.evaluate(`Array.from(document.querySelectorAll('.message.peer')).some((element) => element.textContent?.includes('direct reply smoke') && element.querySelector('.message-sender')?.textContent === 'Smoke peer')`)));
    await waitFor('delivery acknowledgment', async () => Boolean(await page.evaluate(`Array.from(document.querySelectorAll('.message.local')).some((element) => element.textContent?.includes('direct desktop smoke') && element.textContent?.includes('delivered'))`)));

    await page.closeWindow();
    await waitFor('desktop app exit', () => app?.exitCode !== null);
    page = await launch();
    assert((await page.text()).includes('broadcast desktop smoke'), 'Broadcast history did not survive restart.');
    assert((await page.text()).includes('Not connected'), 'Room should require the passphrase after restart.');
    await page.click('.conversation-row:not(.broadcast-row)');
    assert((await page.text()).includes('direct desktop smoke'), 'Direct history did not survive restart.');

    await join(page, `${passphrase}-wrong`);
    await sleep(6_000);
    assert((await page.text()).includes('0 nearby'), 'Wrong passphrase discovered a peer.');
    assert(!(await page.text()).includes('broadcast desktop smoke'), 'Other room history appeared in the active chat.');
    await join(page, passphrase);
    assert((await page.text()).includes('broadcast desktop smoke'), 'Original room history did not return.');
    await waitFor('rejoin discovery', async () => (await page.text()).includes('1 nearby'));

    await page.closeWindow();
    await waitFor('desktop app exit', () => app?.exitCode !== null);
    console.log(`Desktop smoke passed. Profile: ${profileDir}`);
  } catch (error) {
    console.error(`Desktop smoke failed. Profile: ${profileDir}`);
    if (appLog) console.error(appLog.slice(-2_000));
    throw error;
  } finally {
    const runningApp = app as ChildProcess | null;
    if (runningApp && runningApp.exitCode === null) runningApp.kill('SIGTERM');
    await peer.stop();
  }
};

await run();
