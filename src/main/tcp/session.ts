import { Buffer } from 'node:buffer';
import {
  createServer,
  connect as connectSocket,
  type AddressInfo,
  type Server,
  type Socket
} from 'node:net';
import { DEFAULT_TCP_PORT } from '@shared/defaults';
import type { DiscoveryPeerIdentity } from '@shared/discovery';
import {
  decryptFrame,
  derivePeerSessionKey,
  encryptFrame,
  type X25519Identity
} from '../security/crypto';
import { DEFAULT_MAX_TCP_FRAME_BYTES, encodeTcpFrame, TcpFrameDecoder } from './framing';
import {
  createEncryptedSessionEnvelope,
  createSessionErrorMessage,
  createSessionHelloMessage,
  createSessionReadyMessage,
  serializeTcpSessionMessage,
  validateEncryptedSessionEnvelope,
  validateTcpSessionControlMessage
} from './protocol';

export const DEFAULT_TCP_HANDSHAKE_TIMEOUT_MS = 5_000;
export const DEFAULT_TCP_CONNECT_TIMEOUT_MS = 5_000;

export type TcpSessionRole = 'client' | 'server';

export interface TcpSessionIdentity {
  peer: DiscoveryPeerIdentity;
  privateKey: X25519Identity['privateKey'];
  roomKey: Buffer;
}

export interface TcpEncryptedMessage {
  session: TcpSession;
  contentType: string;
  payload: Buffer;
  sentAt: string;
}

export interface TcpSessionErrorEvent {
  code: string;
  message: string;
  remotePeerId?: string;
}

export interface TcpSessionManagerEvents {
  onSessionReady?(session: TcpSession): void;
  onEncryptedMessage?(message: TcpEncryptedMessage): void;
  onSessionError?(error: TcpSessionErrorEvent): void;
}

export interface TcpSessionManagerConfig extends TcpSessionIdentity {
  host?: string;
  tcpPort?: number;
  handshakeTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
}

export interface TcpConnectOptions {
  peer: DiscoveryPeerIdentity;
  address: string;
  port?: number;
  timeoutMs?: number;
}

export class TcpSessionError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'TcpSessionError';
  }
}

export class TcpSession {
  constructor(
    readonly id: string,
    readonly role: TcpSessionRole,
    readonly localPeer: DiscoveryPeerIdentity,
    readonly remotePeer: DiscoveryPeerIdentity,
    private readonly socket: Socket,
    private readonly sessionKey: Buffer,
    private readonly maxFrameBytes: number,
    onClose: (sessionId: string) => void
  ) {
    this.socket.once('close', () => onClose(this.id));
  }

  sendEncrypted(contentType: string, payload: Uint8Array | string): Promise<void> {
    if (this.socket.destroyed) {
      return Promise.reject(new TcpSessionError('TCP session socket is closed.', 'socket-closed'));
    }

    const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
    const encrypted = encryptFrame(this.sessionKey, body, contentType);
    const envelope = createEncryptedSessionEnvelope(contentType, encrypted);
    const wireFrame = encodeTcpFrame(serializeTcpSessionMessage(envelope), this.maxFrameBytes);

    return writeSocket(this.socket, wireFrame);
  }

  close(): void {
    this.socket.end();
  }
}

interface TcpConnectionConfig {
  socket: Socket;
  role: TcpSessionRole;
  local: TcpSessionIdentity;
  events: TcpSessionManagerEvents;
  maxFrameBytes: number;
  handshakeTimeoutMs: number;
  expectedRemotePeer?: DiscoveryPeerIdentity;
  onClose: (sessionId: string) => void;
}

const writeSocket = (socket: Socket, data: Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.write(data, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

const createSessionId = (localPeerId: string, remotePeerId: string): string =>
  [localPeerId, remotePeerId].sort().join(':');

class TcpSessionConnection {
  private readonly decoder: TcpFrameDecoder;
  private remotePeer: DiscoveryPeerIdentity | null = null;
  private sessionKey: Buffer | null = null;
  private session: TcpSession | null = null;
  private sentHello = false;
  private sentReady = false;
  private finished = false;
  private timer: NodeJS.Timeout | null = null;
  private resolveReady: ((session: TcpSession) => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;

  constructor(private readonly config: TcpConnectionConfig) {
    this.decoder = new TcpFrameDecoder(config.maxFrameBytes);
  }

  start(): Promise<TcpSession> {
    const ready = new Promise<TcpSession>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.config.socket.on('data', (chunk) => this.handleData(chunk));
    this.config.socket.once('close', () => this.handleCloseBeforeReady());
    this.config.socket.once('error', (error) => this.fail('socket-error', error.message, false));

    if (this.config.role === 'client') {
      this.sendHello();
    }

    this.timer = setTimeout(() => {
      this.fail('handshake-timeout', 'TCP session handshake timed out.');
    }, this.config.handshakeTimeoutMs);

    return ready;
  }

  private handleData(chunk: Buffer): void {
    let frames: Buffer[];

    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.fail('invalid-frame', error instanceof Error ? error.message : 'Invalid TCP frame.');
      return;
    }

    for (const frame of frames) {
      this.handleFrame(frame);
      if (this.finished) {
        return;
      }
    }
  }

  private handleFrame(frame: Buffer): void {
    if (this.session) {
      this.handleEncryptedFrame(frame);
      return;
    }

    const validation = validateTcpSessionControlMessage(frame, this.config.local.peer.roomFingerprint);

    if (!validation.ok) {
      this.fail('invalid-session-message', `Invalid TCP session message: ${validation.reason}.`);
      return;
    }

    if (validation.message.type === 'session.hello') {
      this.handleHello(validation.message.peer);
      return;
    }

    if (validation.message.type === 'session.ready') {
      this.handleReady(validation.message.peerId);
      return;
    }

    this.fail(validation.message.code, validation.message.message, false);
  }

  private handleHello(peer: DiscoveryPeerIdentity): void {
    const expectedPeer = this.config.expectedRemotePeer;
    if (
      expectedPeer &&
      (expectedPeer.id !== peer.id ||
        expectedPeer.publicKey !== peer.publicKey ||
        expectedPeer.roomFingerprint !== peer.roomFingerprint)
    ) {
      this.fail('unexpected-peer', `Unexpected TCP session peer: ${peer.id}.`);
      return;
    }

    this.remotePeer = peer;

    try {
      this.sessionKey = derivePeerSessionKey({
        roomKey: this.config.local.roomKey,
        privateKey: this.config.local.privateKey,
        localPublicKey: this.config.local.peer.publicKey,
        remotePublicKey: peer.publicKey
      });
    } catch (error) {
      this.fail('session-key-derivation-failed', error instanceof Error ? error.message : 'Session key derivation failed.');
      return;
    }

    if (!this.sentHello) {
      this.sendHello();
    }

    this.sendReady();
  }

  private handleReady(peerId: string): void {
    if (!this.remotePeer || !this.sessionKey) {
      this.fail('ready-before-hello', 'Received session.ready before a valid session.hello.');
      return;
    }

    if (peerId !== this.remotePeer.id) {
      this.fail('unexpected-ready-peer', `Received session.ready for unexpected peer: ${peerId}.`);
      return;
    }

    this.markReady();
  }

  private handleEncryptedFrame(frame: Buffer): void {
    if (!this.session || !this.sessionKey) {
      this.fail('encrypted-before-ready', 'Received encrypted payload before TCP session was ready.');
      return;
    }

    const validation = validateEncryptedSessionEnvelope(frame);
    if (!validation.ok) {
      this.fail('invalid-encrypted-envelope', `Invalid encrypted TCP envelope: ${validation.reason}.`);
      return;
    }

    try {
      const payload = decryptFrame(this.sessionKey, validation.envelope.frame, validation.envelope.contentType);
      this.config.events.onEncryptedMessage?.({
        session: this.session,
        contentType: validation.envelope.contentType,
        payload,
        sentAt: validation.envelope.sentAt
      });
    } catch (error) {
      this.fail('decrypt-failed', error instanceof Error ? error.message : 'Encrypted payload decrypt failed.');
    }
  }

  private sendHello(): void {
    this.sentHello = true;
    this.writeControl(createSessionHelloMessage(this.config.local.peer));
  }

  private sendReady(): void {
    if (this.sentReady) {
      return;
    }

    this.sentReady = true;
    this.writeControl(createSessionReadyMessage(this.config.local.peer.id));
  }

  private writeControl(message: Parameters<typeof serializeTcpSessionMessage>[0]): void {
    const frame = encodeTcpFrame(serializeTcpSessionMessage(message), this.config.maxFrameBytes);
    this.config.socket.write(frame);
  }

  private markReady(): void {
    if (!this.remotePeer || !this.sessionKey || this.session) {
      return;
    }

    this.clearTimer();

    const session = new TcpSession(
      createSessionId(this.config.local.peer.id, this.remotePeer.id),
      this.config.role,
      this.config.local.peer,
      this.remotePeer,
      this.config.socket,
      this.sessionKey,
      this.config.maxFrameBytes,
      this.config.onClose
    );

    this.session = session;
    this.config.events.onSessionReady?.(session);
    this.resolveReady?.(session);
  }

  private fail(code: string, message: string, sendError = true): void {
    if (this.finished) {
      return;
    }

    this.finished = true;
    this.clearTimer();

    if (sendError && !this.config.socket.destroyed && this.config.socket.writable) {
      const errorFrame = encodeTcpFrame(
        serializeTcpSessionMessage(createSessionErrorMessage(code, message)),
        this.config.maxFrameBytes
      );
      this.config.socket.write(errorFrame, () => this.config.socket.destroy());
    } else {
      this.config.socket.destroy();
    }

    this.config.events.onSessionError?.({
      code,
      message,
      remotePeerId: this.remotePeer?.id ?? this.config.expectedRemotePeer?.id
    });
    this.rejectReady?.(new TcpSessionError(message, code));
  }

  private handleCloseBeforeReady(): void {
    if (!this.session && !this.finished) {
      this.fail('socket-closed', 'TCP socket closed before session was ready.', false);
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export class TcpSessionManager {
  private server: Server | null = null;
  private readonly sessions = new Map<string, TcpSession>();
  private readonly config: Required<
    Pick<TcpSessionManagerConfig, 'handshakeTimeoutMs' | 'connectTimeoutMs' | 'maxFrameBytes'>
  > &
    TcpSessionManagerConfig;

  constructor(
    config: TcpSessionManagerConfig,
    private readonly events: TcpSessionManagerEvents = {}
  ) {
    this.config = {
      ...config,
      handshakeTimeoutMs: config.handshakeTimeoutMs ?? DEFAULT_TCP_HANDSHAKE_TIMEOUT_MS,
      connectTimeoutMs: config.connectTimeoutMs ?? DEFAULT_TCP_CONNECT_TIMEOUT_MS,
      maxFrameBytes: config.maxFrameBytes ?? DEFAULT_MAX_TCP_FRAME_BYTES
    };
  }

  start(): Promise<number> {
    if (this.server) {
      return Promise.resolve(this.port);
    }

    this.server = createServer((socket) => {
      const connection = new TcpSessionConnection({
        socket,
        role: 'server',
        local: this.config,
        events: this.wrapEvents(),
        maxFrameBytes: this.config.maxFrameBytes,
        handshakeTimeoutMs: this.config.handshakeTimeoutMs,
        onClose: (sessionId) => this.sessions.delete(sessionId)
      });

      void connection.start().catch(() => undefined);
    });

    return new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new TcpSessionError('TCP server was not created.', 'server-not-created'));
        return;
      }

      this.server.once('error', reject);
      this.server.listen(this.config.tcpPort ?? DEFAULT_TCP_PORT, this.config.host, () => {
        this.server?.off('error', reject);
        resolve(this.port);
      });
    });
  }

  connectToPeer(options: TcpConnectOptions): Promise<TcpSession> {
    const socket = connectSocket({
      host: options.address,
      port: options.port ?? options.peer.tcpPort
    });
    const connectTimeoutMs = options.timeoutMs ?? this.config.connectTimeoutMs;

    return new Promise((resolve, reject) => {
      let settled = false;
      let connectTimer: NodeJS.Timeout | null = null;

      const clearConnectTimer = (): void => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
      };

      const failConnect = (error: Error): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearConnectTimer();
        socket.off('connect', handleConnect);
        socket.off('error', failConnect);
        socket.destroy();
        reject(error);
      };

      const handleConnect = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearConnectTimer();
        socket.off('error', failConnect);

        const connection = new TcpSessionConnection({
          socket,
          role: 'client',
          local: this.config,
          expectedRemotePeer: options.peer,
          events: this.wrapEvents(),
          maxFrameBytes: this.config.maxFrameBytes,
          handshakeTimeoutMs: options.timeoutMs ?? this.config.handshakeTimeoutMs,
          onClose: (sessionId) => this.sessions.delete(sessionId)
        });

        connection.start().then(resolve, reject);
      };

      socket.once('error', failConnect);
      socket.once('connect', handleConnect);
      connectTimer = setTimeout(() => {
        failConnect(
          new TcpSessionError(`TCP connection timed out after ${connectTimeoutMs}ms.`, 'connect-timeout')
        );
      }, connectTimeoutMs);
    });
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();

    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  get port(): number {
    if (!this.server) {
      return this.config.tcpPort ?? DEFAULT_TCP_PORT;
    }

    const address = this.server.address() as AddressInfo | null;
    return address?.port ?? this.config.tcpPort ?? DEFAULT_TCP_PORT;
  }

  listSessions(): TcpSession[] {
    return Array.from(this.sessions.values());
  }

  private wrapEvents(): TcpSessionManagerEvents {
    return {
      ...this.events,
      onSessionReady: (session) => {
        this.sessions.set(session.id, session);
        this.events.onSessionReady?.(session);
      }
    };
  }
}
