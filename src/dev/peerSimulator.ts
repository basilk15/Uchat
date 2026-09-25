import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DEFAULT_DISCOVERY_PORT } from '@shared/defaults';
import type { DiscoveryPeerIdentity } from '@shared/discovery';
import type { ChatMessage, Peer } from '@shared/types';
import {
  isRecord,
  normalizePort,
  normalizeText,
  parseJsonPayload,
  parsePeerMessageInput,
  parsePresenceStatus,
  VALIDATION_LIMITS,
  ValidationError
} from '@shared/validation';
import {
  CHAT_ACK_CONTENT_TYPE,
  CHAT_MESSAGE_CONTENT_TYPE,
  createChatAckFrame,
  createChatMessageFrame,
  serializeChatFrame,
  validateChatAckFrame,
  validateChatMessageFrame
} from '../main/chatProtocol';
import { createLocalDiscoveryPeer, UdpDiscoveryService } from '../main/discovery';
import { getUsableLanInterfaces } from '../main/ports';
import { deriveRoomKey, generateX25519Identity, type DerivedRoomKey, type X25519Identity } from '../main/security/crypto';
import {
  TcpSessionManager,
  type TcpEncryptedMessage,
  type TcpSession,
  type TcpSessionManagerEvents
} from '../main/tcp/session';

const DEFAULT_BROWSER_PORT = 8_787;
const MAX_LOG_ENTRIES = 120;
const MAX_BODY_BYTES = 4_096;
const DEFAULT_INITIAL_SEND_WAIT_MS = 30_000;

export type PeerMessageScope = 'direct' | 'broadcast';

export interface PeerSimulatorOptions {
  help?: boolean;
  roomName: string;
  passphrase: string;
  displayName?: string;
  status?: DiscoveryPeerIdentity['status'];
  udpPort?: number;
  tcpPort?: number;
  httpHost?: string;
  httpPort?: number;
  broadcastAddress?: string;
  autoReply?: string;
  send?: string;
  sendScope?: PeerMessageScope;
  targetPeerId?: string;
  initialSendWaitMs?: number;
}

export interface PeerSimulatorState {
  appName: 'Uchat peer simulator';
  roomName: string;
  roomFingerprint: string;
  localPeer: DiscoveryPeerIdentity;
  udpPort: number;
  tcpPort: number;
  httpPort: number | null;
  lanInterfaces: ReturnType<typeof getUsableLanInterfaces>;
  lanUrls: string[];
  knownPeers: Peer[];
  connectedPeers: Peer[];
  logEntries: PeerSimulatorLogEntry[];
}

export interface PeerSimulatorLogEntry {
  id: string;
  kind: 'system' | 'incoming' | 'outgoing';
  level: 'info' | 'warning' | 'error';
  message: string;
  body?: string;
  peerId?: string;
  peerName?: string;
  scope?: PeerMessageScope;
  deliveryState?: ChatMessage['deliveryState'];
  createdAt: string;
}

export interface PeerSimulator {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(input: {
    body: string;
    scope?: PeerMessageScope;
    targetPeerId?: string;
  }): Promise<void>;
  getState(): PeerSimulatorState;
  getBrowserUrls(): string[];
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const readRequestBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    const nextChunk = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    chunks.push(nextChunk);

    const bytesRead = chunks.reduce((total, current) => total + current.byteLength, 0);
    if (bytesRead > MAX_BODY_BYTES) {
      throw new Error('Request body is too large.');
    }
  }

  return Buffer.concat(chunks).toString('utf8');
};

const normalizeBody = (body: string): string =>
  parsePeerMessageInput({ body }).body;

const createReplyBody = (template: string, inboundBody: string): string =>
  template
    .replaceAll('{body}', inboundBody)
    .replaceAll('{message}', inboundBody);

const createLogEntry = (
  kind: PeerSimulatorLogEntry['kind'],
  message: string,
  level: PeerSimulatorLogEntry['level'] = 'info',
  extras: Partial<PeerSimulatorLogEntry> = {}
): PeerSimulatorLogEntry => ({
  id: randomUUID(),
  kind,
  level,
  message,
  createdAt: new Date().toISOString(),
  ...extras
});

const isDiscoveryPeerIdentity = (peer: Peer): peer is Peer & Required<Pick<Peer, 'publicKey' | 'roomFingerprint' | 'capabilities'>> =>
  Boolean(peer.publicKey && peer.roomFingerprint && peer.capabilities);

const toDiscoveryPeer = (peer: Peer): DiscoveryPeerIdentity | null => {
  if (!isDiscoveryPeerIdentity(peer)) {
    return null;
  }

  return {
    id: peer.id,
    displayName: peer.displayName,
    status: peer.status,
    udpPort: peer.udpPort,
    tcpPort: peer.tcpPort,
    publicKey: peer.publicKey,
    roomFingerprint: peer.roomFingerprint,
    capabilities: peer.capabilities
  };
};

const renderShell = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Uchat peer simulator</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f1e8;
        --panel: rgba(255, 255, 255, 0.84);
        --panel-strong: #ffffff;
        --text: #181816;
        --muted: #5d6258;
        --border: rgba(24, 24, 22, 0.12);
        --accent: #335c50;
        --accent-soft: rgba(51, 92, 80, 0.12);
        --good: #1d6b50;
        --warn: #a86f20;
        --bad: #b23b32;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(51, 92, 80, 0.18), transparent 30%),
          radial-gradient(circle at top right, rgba(168, 111, 32, 0.16), transparent 28%),
          var(--bg);
        color: var(--text);
      }
      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 20px;
        display: grid;
        gap: 16px;
      }
      .hero, .panel {
        background: var(--panel);
        backdrop-filter: blur(14px);
        border: 1px solid var(--border);
        border-radius: 18px;
        box-shadow: 0 18px 50px rgba(16, 24, 16, 0.08);
      }
      .hero {
        padding: 20px;
      }
      .hero h1 {
        margin: 0 0 6px;
        font-size: clamp(1.75rem, 4vw, 2.7rem);
        letter-spacing: -0.04em;
      }
      .hero p {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
      }
      .grid {
        display: grid;
        grid-template-columns: 1.15fr 0.85fr;
        gap: 16px;
      }
      @media (max-width: 900px) {
        .grid { grid-template-columns: 1fr; }
      }
      .panel {
        padding: 16px;
      }
      .panel h2 {
        margin: 0 0 12px;
        font-size: 1.02rem;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .stat {
        background: var(--panel-strong);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 12px;
      }
      .label {
        font-size: 0.78rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
        margin-bottom: 4px;
      }
      .value {
        word-break: break-word;
        font-weight: 600;
      }
      form {
        display: grid;
        gap: 12px;
      }
      label {
        display: grid;
        gap: 6px;
        font-weight: 600;
      }
      input, select, textarea, button {
        font: inherit;
      }
      input, select, textarea {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px 13px;
        background: rgba(255, 255, 255, 0.95);
        color: var(--text);
      }
      textarea {
        min-height: 110px;
        resize: vertical;
      }
      button {
        border: 0;
        border-radius: 999px;
        padding: 11px 16px;
        font-weight: 700;
        cursor: pointer;
        background: var(--accent);
        color: white;
      }
      button.secondary {
        background: var(--accent-soft);
        color: var(--accent);
      }
      button:focus-visible,
      input:focus-visible,
      select:focus-visible,
      textarea:focus-visible {
        outline: 3px solid rgba(51, 92, 80, 0.24);
        outline-offset: 2px;
      }
      .button-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .list {
        display: grid;
        gap: 10px;
      }
      .card {
        border: 1px solid var(--border);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.92);
        padding: 12px;
      }
      .card-head {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: start;
        margin-bottom: 6px;
      }
      .pill {
        border-radius: 999px;
        padding: 4px 8px;
        font-size: 0.75rem;
        font-weight: 700;
        background: var(--accent-soft);
        color: var(--accent);
      }
      .pill.good { background: rgba(29, 107, 80, 0.12); color: var(--good); }
      .pill.warn { background: rgba(168, 111, 32, 0.14); color: var(--warn); }
      .pill.bad { background: rgba(178, 59, 50, 0.12); color: var(--bad); }
      .meta {
        color: var(--muted);
        font-size: 0.92rem;
        line-height: 1.45;
      }
      .message-body {
        margin-top: 6px;
        font-size: 0.98rem;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .empty {
        color: var(--muted);
        font-size: 0.95rem;
      }
      .footer {
        color: var(--muted);
        font-size: 0.9rem;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <h1>Uchat peer simulator</h1>
        <p>
          A disposable LAN peer for testing the desktop app from a laptop terminal or a phone browser.
          It speaks the same discovery and encrypted TCP chat protocol, but stays out of the production app.
        </p>
      </section>

      <section class="grid">
        <div class="panel">
          <h2>Compose</h2>
          <form id="compose-form">
            <label>
              Target peer
              <select id="target-peer"></select>
            </label>
            <label>
              Message
              <textarea id="message-body" placeholder="Type a message to the Uchat app"></textarea>
            </label>
            <div class="button-row">
              <button type="submit">Send direct</button>
              <button type="button" class="secondary" id="broadcast-button">Broadcast</button>
            </div>
          </form>
        </div>

        <div class="panel">
          <h2>Status</h2>
          <div class="stats">
            <div class="stat"><div class="label">Room</div><div class="value" id="room-name">-</div></div>
            <div class="stat"><div class="label">Fingerprint</div><div class="value" id="room-fingerprint">-</div></div>
            <div class="stat"><div class="label">UDP port</div><div class="value" id="udp-port">-</div></div>
            <div class="stat"><div class="label">TCP port</div><div class="value" id="tcp-port">-</div></div>
            <div class="stat"><div class="label">Web port</div><div class="value" id="http-port">-</div></div>
            <div class="stat"><div class="label">Connected peers</div><div class="value" id="connected-peers">0</div></div>
          </div>
          <p class="footer" id="lan-urls"></p>
        </div>
      </section>

      <section class="panel">
        <h2>Connected peers</h2>
        <div class="list" id="peer-list"></div>
      </section>

      <section class="panel">
        <h2>Log</h2>
        <div class="list" id="log-list"></div>
      </section>
    </main>

    <script>
      const stateUrl = '/api/state';

      const peerList = document.getElementById('peer-list');
      const logList = document.getElementById('log-list');
      const targetPeer = document.getElementById('target-peer');
      const messageBody = document.getElementById('message-body');
      const form = document.getElementById('compose-form');
      const broadcastButton = document.getElementById('broadcast-button');

      const setText = (id, value) => {
        document.getElementById(id).textContent = value ?? '-';
      };

      const render = (state) => {
        setText('room-name', state.roomName);
        setText('room-fingerprint', state.roomFingerprint);
        setText('udp-port', String(state.udpPort));
        setText('tcp-port', String(state.tcpPort));
        setText('http-port', state.httpPort ? String(state.httpPort) : 'n/a');
        setText('connected-peers', String(state.connectedPeers.length));
        setText('lan-urls', state.lanUrls.length ? 'Open this page on your phone: ' + state.lanUrls.join(' · ') : 'No LAN interface detected.');

        targetPeer.innerHTML = '';
        const peers = state.connectedPeers.length ? state.connectedPeers : state.knownPeers;
        for (const peer of peers) {
          const option = document.createElement('option');
          option.value = peer.id;
          option.textContent = peer.displayName + ' · ' + peer.address + ':' + peer.tcpPort;
          targetPeer.appendChild(option);
        }
        if (!peers.length) {
          const option = document.createElement('option');
          option.value = '';
          option.textContent = 'No peer connected yet';
          targetPeer.appendChild(option);
        }

        peerList.innerHTML = '';
        if (!state.connectedPeers.length) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = 'Waiting for the Uchat app to appear on the LAN...';
          peerList.appendChild(empty);
        } else {
          for (const peer of state.connectedPeers) {
            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = '<div class="card-head"><strong></strong><span class="pill good">connected</span></div><div class="meta"></div>';
            card.querySelector('strong').textContent = peer.displayName;
            card.querySelector('.meta').textContent = peer.address + ':' + peer.tcpPort + ' · ' + peer.id;
            peerList.appendChild(card);
          }
        }

        logList.innerHTML = '';
        if (!state.logEntries.length) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = 'No messages yet.';
          logList.appendChild(empty);
        } else {
          for (const entry of state.logEntries.slice().reverse()) {
            const card = document.createElement('div');
            card.className = 'card';
            const pillClass =
              entry.level === 'error' ? 'pill bad' : entry.level === 'warning' ? 'pill warn' : 'pill';
            const title = entry.kind === 'system' ? 'system' : entry.kind === 'incoming' ? 'incoming' : 'outgoing';
            card.innerHTML =
              '<div class="card-head"><strong></strong><span class="' + pillClass + '"></span></div>' +
              '<div class="meta"></div>' +
              (entry.body ? '<div class="message-body"></div>' : '');
            card.querySelector('strong').textContent = title + (entry.peerName ? ' · ' + entry.peerName : '');
            card.querySelector('.pill').textContent = entry.deliveryState ?? entry.level;
            card.querySelector('.meta').textContent = entry.message;
            if (entry.body) {
              card.querySelector('.message-body').textContent = entry.body;
            }
            logList.appendChild(card);
          }
        }
      };

      const refresh = async () => {
        try {
          const response = await fetch(stateUrl);
          const state = await response.json();
          render(state);
        } catch (error) {
          logList.innerHTML = '<div class="empty">Could not load simulator state: ' + String(error) + '</div>';
        }
      };

      const sendMessage = async (scope) => {
        const body = messageBody.value.trim();
        if (!body) {
          return;
        }

        const payload = {
          body,
          targetPeerId: targetPeer.value || undefined
        };

        const response = await fetch(scope === 'broadcast' ? '/api/broadcast' : '/api/message', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const text = await response.text();
          alert(text);
          return;
        }

        messageBody.value = '';
        await refresh();
      };

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        await sendMessage('direct');
      });

      broadcastButton.addEventListener('click', async () => {
        await sendMessage('broadcast');
      });

      refresh();
      setInterval(refresh, 2000);
    </script>
  </body>
</html>`;

export const buildBrowserUrls = (httpPort: number, lanInterfaces = getUsableLanInterfaces()): string[] => {
  const urls = [`http://127.0.0.1:${httpPort}`];

  for (const iface of lanInterfaces) {
    urls.push(`http://${iface.address}:${httpPort}`);
  }

  return urls;
};

export const buildReplyBody = (template: string, inboundBody: string): string =>
  createReplyBody(template, inboundBody);

export const createPeerSimulator = (options: PeerSimulatorOptions): PeerSimulator => {
  const logEntries: PeerSimulatorLogEntry[] = [];
  const knownPeers = new Map<string, Peer>();
  const connectingPeers = new Set<string>();
  const initialSend = options.send ? normalizeBody(options.send) : '';
  const initialSendScope = options.sendScope ?? 'direct';
  const initialSendTargetPeerId = options.targetPeerId;
  const initialSendWaitMs = options.initialSendWaitMs ?? DEFAULT_INITIAL_SEND_WAIT_MS;
  const lanInterfaces = getUsableLanInterfaces();
  const httpHost = options.httpHost ?? '0.0.0.0';
  const httpPort = options.httpPort ?? null;
  let discovery: UdpDiscoveryService | null = null;
  let httpServer: Server | null = null;
  let tcpManager: TcpSessionManager | null = null;
  let localPeer: DiscoveryPeerIdentity | null = null;
  let roomKey: DerivedRoomKey | null = null;
  let identity: X25519Identity | null = null;

  const log = (
    kind: PeerSimulatorLogEntry['kind'],
    message: string,
    level: PeerSimulatorLogEntry['level'] = 'info',
    extras: Partial<PeerSimulatorLogEntry> = {}
  ): PeerSimulatorLogEntry => {
    const entry = createLogEntry(kind, message, level, extras);
    logEntries.push(entry);
    if (logEntries.length > MAX_LOG_ENTRIES) {
      logEntries.splice(0, logEntries.length - MAX_LOG_ENTRIES);
    }
    const prefix = level === 'error' ? '[error]' : level === 'warning' ? '[warn]' : '[info]';
    console.log(`${prefix} ${message}`);
    return entry;
  };

  const getConnectedPeers = (): Peer[] => {
    if (!tcpManager) {
      return [];
    }

    return tcpManager.listSessions().map((session) => {
      const knownPeer = knownPeers.get(session.remotePeer.id);

      return {
        ...session.remotePeer,
        address: knownPeer?.address ?? 'unknown',
        lastSeenAt: knownPeer?.lastSeenAt ?? new Date().toISOString()
      };
    });
  };

  const getSelectedPeer = (targetPeerId?: string): Peer | null => {
    const connectedPeers = getConnectedPeers();
    if (targetPeerId) {
      return connectedPeers.find((peer) => peer.id === targetPeerId) ?? knownPeers.get(targetPeerId) ?? null;
    }

    if (connectedPeers.length > 0) {
      return connectedPeers[0];
    }

    return knownPeers.values().next().value ?? null;
  };

  const getSessionForPeer = async (peer: Peer): Promise<TcpSession> => {
    if (!tcpManager) {
      throw new Error('TCP session manager is not running.');
    }

    const existing = tcpManager.listSessions().find((session) => session.remotePeer.id === peer.id);
    if (existing) {
      return existing;
    }

    const discoveryPeer = toDiscoveryPeer(peer);
    if (!discoveryPeer) {
      throw new Error(`Peer ${peer.displayName} is missing encrypted session identity.`);
    }

    return tcpManager.connectToPeer({
      peer: discoveryPeer,
      address: peer.address,
      port: peer.tcpPort
    });
  };

  const sendPayloadToPeer = async (
    peer: Peer,
    body: string,
    scope: PeerMessageScope
  ): Promise<PeerSimulatorLogEntry> => {
    if (!tcpManager) {
      throw new Error('TCP session manager is not running.');
    }

    const session = await getSessionForPeer(peer);
    const message = createChatMessageFrame({
      messageId: randomUUID(),
      body,
      scope
    });

    await session.sendEncrypted(CHAT_MESSAGE_CONTENT_TYPE, serializeChatFrame(message));

    return log('outgoing', `Sent ${scope} message to ${peer.displayName}.`, 'info', {
      peerId: peer.id,
      peerName: peer.displayName,
      scope,
      body,
      deliveryState: 'sent'
    });
  };

  const sendMessage = async (input: {
    body: string;
    scope?: PeerMessageScope;
    targetPeerId?: string;
  }): Promise<void> => {
    if (!isRecord(input)) {
      throw new ValidationError('Invalid simulator message input: expected an object.');
    }

    const messageInput = parsePeerMessageInput({ body: input.body, targetPeerId: input.targetPeerId });
    const body = messageInput.body;
    const scope = input.scope ?? 'direct';
    if (scope !== 'direct' && scope !== 'broadcast') {
      throw new ValidationError('scope must be either direct or broadcast.', 'scope');
    }

    if (scope === 'broadcast') {
      const peers = getConnectedPeers().length > 0 ? getConnectedPeers() : Array.from(knownPeers.values());
      if (peers.length === 0) {
        throw new Error('No connected peers are available for broadcast.');
      }

      await Promise.all(peers.map((peer) => sendPayloadToPeer(peer, body, scope)));
      return;
    }

    const selectedPeer = getSelectedPeer(input.targetPeerId);
    if (!selectedPeer) {
      throw new Error('No connected peer is available yet. Wait for discovery or pass --peer-id.');
    }

    await sendPayloadToPeer(selectedPeer, body, scope);
  };

  const handleEncryptedMessage = async (message: TcpEncryptedMessage): Promise<void> => {
    const inboundPeer = message.session.remotePeer;
    const savedPeer: Peer = {
      ...inboundPeer,
      address: knownPeers.get(inboundPeer.id)?.address ?? 'unknown',
      lastSeenAt: new Date().toISOString()
    };
    knownPeers.set(savedPeer.id, savedPeer);

    if (message.contentType === CHAT_MESSAGE_CONTENT_TYPE) {
      const validation = validateChatMessageFrame(message.payload);
      if (!validation.ok) {
        log('system', `Ignored invalid chat.message frame from ${inboundPeer.displayName}: ${validation.reason}.`, 'warning', {
          peerId: inboundPeer.id,
          peerName: inboundPeer.displayName
        });
        return;
      }

      log('incoming', `Received ${validation.frame.scope} message from ${inboundPeer.displayName}.`, 'info', {
        peerId: inboundPeer.id,
        peerName: inboundPeer.displayName,
        scope: validation.frame.scope,
        body: validation.frame.body,
        deliveryState: 'delivered'
      });

      await message.session.sendEncrypted(
        CHAT_ACK_CONTENT_TYPE,
        serializeChatFrame(createChatAckFrame(validation.frame.messageId))
      );

      if (options.autoReply) {
        const replyBody = createReplyBody(options.autoReply, validation.frame.body);
        await wait(150);
        await sendMessage({
          body: replyBody,
          scope: 'direct',
          targetPeerId: inboundPeer.id
        });
      }

      return;
    }

    if (message.contentType === CHAT_ACK_CONTENT_TYPE) {
      const validation = validateChatAckFrame(message.payload);
      if (!validation.ok) {
        log('system', `Ignored invalid chat.ack frame from ${inboundPeer.displayName}: ${validation.reason}.`, 'warning', {
          peerId: inboundPeer.id,
          peerName: inboundPeer.displayName
        });
        return;
      }

      log('outgoing', `Delivery acknowledged by ${inboundPeer.displayName}.`, 'info', {
        peerId: inboundPeer.id,
        peerName: inboundPeer.displayName,
        deliveryState: 'delivered'
      });
      return;
    }

    log('system', `Ignored unsupported encrypted content type: ${message.contentType}.`, 'warning', {
      peerId: inboundPeer.id,
      peerName: inboundPeer.displayName
    });
  };

  const ensureTcpConnection = (peer: Peer): void => {
    if (!localPeer || peer.id === localPeer.id || !peer.capabilities?.includes('chat') || !peer.capabilities.includes('tcp-session')) {
      return;
    }

    if (connectingPeers.has(peer.id) || getConnectedPeers().some((sessionPeer) => sessionPeer.id === peer.id)) {
      return;
    }

    connectingPeers.add(peer.id);
    void getSessionForPeer(peer)
      .then((session) => {
        log('system', `Connected to ${session.remotePeer.displayName} at ${peer.address}:${peer.tcpPort}.`);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown TCP connect failure.';
        log('system', `Could not connect to ${peer.displayName}: ${message}`, 'warning', {
          peerId: peer.id,
          peerName: peer.displayName
        });
      })
      .finally(() => {
        connectingPeers.delete(peer.id);
      });
  };

  const handlePeerUpdated = (peer: Peer): void => {
    const previous = knownPeers.get(peer.id);
    knownPeers.set(peer.id, peer);

    if (
      !previous ||
      previous.displayName !== peer.displayName ||
      previous.address !== peer.address ||
      previous.tcpPort !== peer.tcpPort
    ) {
      log('system', `Discovered ${peer.displayName} at ${peer.address}:${peer.tcpPort}.`, 'info', {
        peerId: peer.id,
        peerName: peer.displayName
      });
    }

    ensureTcpConnection(peer);
  };

  const handlePeerRemoved = (peerId: string): void => {
    const peer = knownPeers.get(peerId);
    knownPeers.delete(peerId);
    connectingPeers.delete(peerId);
    if (peer) {
      log('system', `${peer.displayName} left the room.`, 'warning', {
        peerId,
        peerName: peer.displayName
      });
    }
  };

  const handleNetworkEvent = (message: string, level: PeerSimulatorLogEntry['level'] = 'info'): void => {
    log('system', message, level);
  };

  const startHttpServer = async (): Promise<void> => {
    if (!httpPort) {
      return;
    }

    httpServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      try {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderShell());
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/state') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(getState()));
          return;
        }

        if (req.method === 'POST' && (url.pathname === '/api/message' || url.pathname === '/api/broadcast')) {
          const rawBody = await readRequestBody(req);
          const parsed = parseJsonPayload(rawBody, Math.min(MAX_BODY_BYTES, VALIDATION_LIMITS.protocolPayloadBytes));
          if (!parsed.ok) {
            throw new ValidationError(`Invalid request payload: ${parsed.reason}.`);
          }

          const messageInput = parsePeerMessageInput(parsed.value);
          await sendMessage({
            body: messageInput.body,
            targetPeerId: messageInput.targetPeerId,
            scope: url.pathname === '/api/broadcast' ? 'broadcast' : 'direct'
          });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown request error.';
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(message);
      }
    });

    await new Promise<void>((resolve, reject) => {
      if (!httpServer) {
        reject(new Error('HTTP server was not created.'));
        return;
      }

      httpServer.once('error', reject);
      httpServer.listen(httpPort, httpHost, () => {
        httpServer?.off('error', reject);
        resolve();
      });
    });
  };

  const getState = (): PeerSimulatorState => {
    if (!localPeer || !roomKey) {
      throw new Error('Peer simulator has not started yet.');
    }

    const connectedPeers = getConnectedPeers();

    return {
      appName: 'Uchat peer simulator',
      roomName: roomKey.roomName,
      roomFingerprint: roomKey.fingerprint,
      localPeer,
      udpPort: localPeer.udpPort,
      tcpPort: localPeer.tcpPort,
      httpPort,
      lanInterfaces,
      lanUrls: httpPort ? buildBrowserUrls(httpPort, lanInterfaces).slice(1) : [],
      knownPeers: Array.from(knownPeers.values()),
      connectedPeers,
      logEntries: [...logEntries]
    };
  };

  const start = async (): Promise<void> => {
    if (tcpManager || discovery) {
      return;
    }

    roomKey = await deriveRoomKey(options.roomName, options.passphrase);
    identity = generateX25519Identity();
    const localPeerSeed = createLocalDiscoveryPeer({
      id: identity.publicKey,
      displayName: options.displayName ?? 'Uchat peer simulator',
      status: options.status ?? 'available',
      roomFingerprint: roomKey.fingerprint,
      publicKey: identity.publicKey,
      udpPort: options.udpPort ?? DEFAULT_DISCOVERY_PORT,
      tcpPort: options.tcpPort ?? 0,
      capabilities: ['discovery', 'tcp-session', 'chat']
    });
    localPeer = localPeerSeed;

    tcpManager = new TcpSessionManager(
      {
        peer: localPeerSeed,
        privateKey: identity.privateKey,
        roomKey: roomKey.key,
        host: '0.0.0.0',
        tcpPort: options.tcpPort ?? 0
      },
      {
        onEncryptedMessage: (message) => {
          void handleEncryptedMessage(message);
        },
        onSessionError: (error) => {
          log('system', `TCP session error for ${error.remotePeerId ?? 'unknown peer'}: ${error.message}`, 'warning');
        }
      } satisfies TcpSessionManagerEvents
    );

    const actualTcpPort = await tcpManager.start();
    localPeerSeed.tcpPort = actualTcpPort;

    discovery = new UdpDiscoveryService(
      {
        localPeer: localPeerSeed,
        udpPort: options.udpPort ?? DEFAULT_DISCOVERY_PORT,
        broadcastAddress: options.broadcastAddress
      },
      {
        onPeerUpdated: handlePeerUpdated,
        onPeerRemoved: handlePeerRemoved,
        onNetworkEvent: handleNetworkEvent
      }
    );
    await discovery.start();

    log('system', `Peer simulator joined room "${roomKey.roomName}" with TCP ${actualTcpPort} and UDP ${localPeerSeed.udpPort}.`);

    if (httpPort) {
      await startHttpServer();
      const urls = buildBrowserUrls(httpPort, lanInterfaces);
      log('system', `Browser bridge ready: ${urls.join(' | ')}.`);
    }

    if (initialSend) {
      void waitForFirstConnectionAndSend(initialSend, initialSendScope, initialSendTargetPeerId, initialSendWaitMs).catch(
        (error: unknown) => {
          const message = error instanceof Error ? error.message : 'Unknown initial-send error.';
          log('system', `Initial send skipped: ${message}`, 'warning');
        }
      );
    }
  };

  const waitForFirstConnectionAndSend = async (
    body: string,
    scope: PeerMessageScope,
    targetPeerId: string | undefined,
    timeoutMs: number
  ): Promise<void> => {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const selectedPeer =
        scope === 'broadcast'
          ? (getConnectedPeers().length > 0 ? getConnectedPeers()[0] : Array.from(knownPeers.values())[0] ?? null)
          : getSelectedPeer(targetPeerId);

      if (selectedPeer) {
        await sendMessage({ body, scope, targetPeerId });
        return;
      }

      await wait(250);
    }

    throw new Error(`No peer appeared within ${timeoutMs}ms.`);
  };

  const stop = async (): Promise<void> => {
    if (httpServer) {
      const server = httpServer;
      httpServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    if (discovery) {
      const current = discovery;
      discovery = null;
      await current.stop();
    }

    if (tcpManager) {
      const current = tcpManager;
      tcpManager = null;
      await current.stop();
    }
  };

  return {
    start,
    stop,
    sendMessage,
    getState,
    getBrowserUrls: () => {
      if (!httpPort) {
        return [];
      }

      return buildBrowserUrls(httpPort, lanInterfaces);
    }
  };
};

export const parsePeerSimulatorArgs = (argv: string[]): PeerSimulatorOptions => {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const helpRequested =
    normalizedArgv.includes('--help') || normalizedArgv.includes('-h') || normalizedArgv.includes('help');
  const result = parseArgs({
    args: normalizedArgv,
    options: {
      room: { type: 'string' },
      passphrase: { type: 'string' },
      'display-name': { type: 'string' },
      status: { type: 'string' },
      'udp-port': { type: 'string' },
      'tcp-port': { type: 'string' },
      'http-host': { type: 'string' },
      'http-port': { type: 'string' },
      'broadcast-address': { type: 'string' },
      'auto-reply': { type: 'string' },
      send: { type: 'string' },
      'send-scope': { type: 'string' },
      'peer-id': { type: 'string' },
      'initial-send-wait-ms': { type: 'string' },
      web: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: true
  });

  if (helpRequested || result.values.help) {
    return { help: true, roomName: '', passphrase: '' };
  }

  const [positionalRoom, positionalPassphrase] = result.positionals;
  const roomName = result.values.room ?? positionalRoom ?? '';
  const passphrase = result.values.passphrase ?? positionalPassphrase ?? '';
  const rawSendScope = result.values['send-scope'];
  if (rawSendScope !== undefined && rawSendScope !== 'direct' && rawSendScope !== 'broadcast') {
    throw new ValidationError('send-scope must be either direct or broadcast.', 'send-scope');
  }
  const sendScope = rawSendScope === 'broadcast' ? 'broadcast' : 'direct';
  const parseCliPort = (value: string | undefined, field: string, allowZero = false): number | undefined =>
    value === undefined ? undefined : normalizePort(Number(value), field, allowZero);

  return {
    roomName,
    passphrase,
    displayName:
      result.values['display-name'] === undefined
        ? undefined
        : normalizeText(result.values['display-name'], 'displayName', VALIDATION_LIMITS.displayName),
    status: result.values.status === undefined ? 'available' : parsePresenceStatus(result.values.status),
    udpPort: parseCliPort(result.values['udp-port'], 'udpPort'),
    tcpPort: parseCliPort(result.values['tcp-port'], 'tcpPort', true),
    httpHost: result.values['http-host'],
    httpPort: result.values.web
      ? parseCliPort(result.values['http-port'] ?? String(DEFAULT_BROWSER_PORT), 'httpPort')
      : undefined,
    broadcastAddress: result.values['broadcast-address'],
    autoReply: result.values['auto-reply'],
    send: result.values.send,
    sendScope,
    targetPeerId: result.values['peer-id'],
    initialSendWaitMs: result.values['initial-send-wait-ms']
      ? Number.parseInt(result.values['initial-send-wait-ms'], 10)
      : undefined
  };
};

export const printPeerSimulatorHelp = (): void => {
  const lines = [
    'Uchat peer simulator',
    '',
    'Usage:',
    '  pnpm peer:sim --room "Lab" --passphrase "secret" [options]',
    '',
    'Options:',
    '  --room <name>                 Room name to join.',
    '  --passphrase <value>          Room passphrase to derive the LAN key.',
    '  --display-name <name>         Peer name shown to the desktop app.',
    '  --udp-port <port>             Discovery UDP port. Default: 47475.',
    '  --tcp-port <port>             TCP listener port. Default: 0 (ephemeral).',
    '  --web                         Start the browser bridge.',
    '  --http-port <port>            Browser bridge port. Default: 8787.',
    '  --http-host <host>            Browser bridge host. Default: 0.0.0.0.',
    '  --broadcast-address <addr>    UDP broadcast address. Default: 255.255.255.255.',
    '  --send <text>                 Send one message after the peer connects.',
    '  --send-scope direct|broadcast Send as a direct message or broadcast.',
    '  --peer-id <id>                Preferred direct-message target.',
    '  --auto-reply <template>       Reply to inbound app messages. Use {body} placeholder.',
    '  --initial-send-wait-ms <ms>   How long to wait for the first peer before skipping --send.',
    '',
    'Browser bridge:',
    '  Open the printed LAN URL on your phone. The page lets you send direct or broadcast messages to the app.',
    '  The separator form also works: pnpm peer:sim -- --room "Lab" --passphrase "secret" --web',
    '',
    'Examples:',
    '  pnpm peer:sim --room "Uchat Lab" --passphrase "demo" --web',
    '  pnpm peer:sim --room "Uchat Lab" --passphrase "demo" --send "hello from terminal"',
    '  curl -X POST http://127.0.0.1:8787/api/message -H "content-type: application/json" -d \'{"body":"hello"}\''
  ];

  console.log(lines.join('\n'));
};

export const main = async (argv = process.argv.slice(2)): Promise<number> => {
  const options = parsePeerSimulatorArgs(argv);
  if (options.help) {
    printPeerSimulatorHelp();
    return 0;
  }

  if (!options.roomName || !options.passphrase) {
    printPeerSimulatorHelp();
    return 1;
  }

  const simulator = createPeerSimulator(options);
  await simulator.start();

  const state = simulator.getState();
  console.log('');
  console.log(`Room: ${state.roomName}`);
  console.log(`Fingerprint: ${state.roomFingerprint}`);
  console.log(`UDP: ${state.udpPort}`);
  console.log(`TCP: ${state.tcpPort}`);
  if (state.httpPort) {
    console.log(`Browser: ${simulator.getBrowserUrls().join(' | ')}`);
  }

  const cleanup = async (): Promise<void> => {
    await simulator.stop();
  };

  process.once('SIGINT', () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void cleanup().finally(() => process.exit(0));
  });

  return 0;
};
