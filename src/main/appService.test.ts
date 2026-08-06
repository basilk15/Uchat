import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, Peer } from '@shared/types';
import {
  CHAT_ACK_CONTENT_TYPE,
  CHAT_MESSAGE_CONTENT_TYPE,
  createChatAckFrame,
  createChatMessageFrame,
  serializeChatFrame
} from './chatProtocol';
import {
  createUchatAppService,
  type DiscoveryRuntime,
  type DiscoveryServiceFactory,
  type TcpSessionManagerFactory,
  type TcpSessionRuntime,
  type UchatAppServiceOptions
} from './appService';
import type { UdpDiscoveryServiceConfig, UdpDiscoveryServiceEvents } from './discovery';
import { createSqliteStorage } from './storage/sqliteStorage';
import type { TcpConnectOptions, TcpEncryptedMessage, TcpSession, TcpSessionManagerConfig, TcpSessionManagerEvents } from './tcp/session';

class FakeDiscoveryRuntime implements DiscoveryRuntime {
  readonly peers = new Map<string, Peer>();
  startCalls = 0;
  stopCalls = 0;

  constructor(
    readonly config: UdpDiscoveryServiceConfig,
    private readonly events: UdpDiscoveryServiceEvents
  ) {}

  start(): Promise<void> {
    this.startCalls += 1;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopCalls += 1;
    return Promise.resolve();
  }

  listPeers(): Peer[] {
    return Array.from(this.peers.values());
  }

  emitPeerUpdated(peer: Peer): void {
    this.peers.set(peer.id, peer);
    this.events.onPeerUpdated?.(peer);
  }

  emitPeerRemoved(peerId: string): void {
    this.peers.delete(peerId);
    this.events.onPeerRemoved?.(peerId);
  }
}

class FakeTcpSessionRuntime implements TcpSessionRuntime {
  readonly sessions: TcpSession[] = [];
  readonly sent: Array<{ peerId: string; contentType: string; payload: Buffer }> = [];
  startCalls = 0;
  stopCalls = 0;
  failConnect = false;

  constructor(
    readonly config: TcpSessionManagerConfig,
    private readonly events: TcpSessionManagerEvents
  ) {}

  start(): Promise<number> {
    this.startCalls += 1;
    return Promise.resolve(this.config.tcpPort ?? 47476);
  }

  stop(): Promise<void> {
    this.stopCalls += 1;
    return Promise.resolve();
  }

  connectToPeer(options: TcpConnectOptions): Promise<TcpSession> {
    if (this.failConnect) {
      return Promise.reject(new Error('fake connect failure'));
    }

    const session = this.createSession(options.peer);
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  listSessions(): TcpSession[] {
    return [...this.sessions];
  }

  emitEncryptedMessage(message: Omit<TcpEncryptedMessage, 'sentAt'> & { sentAt?: string }): void {
    this.events.onEncryptedMessage?.({
      ...message,
      sentAt: message.sentAt ?? new Date().toISOString()
    });
  }

  private createSession(peer: TcpConnectOptions['peer']): TcpSession {
    const session = {
      remotePeer: peer,
      sendEncrypted: (contentType: string, payload: Uint8Array | string): Promise<void> => {
        this.sent.push({
          peerId: peer.id,
          contentType,
          payload: typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload)
        });
        return Promise.resolve();
      }
    };

    return session as TcpSession;
  }
}

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 500): Promise<void> => {
  const startedAt = Date.now();

  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for app service test condition.');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const createPeer = (id: string, overrides: Partial<Peer> = {}): Peer => ({
  id,
  displayName: `Peer ${id}`,
  status: 'available',
  address: '127.0.0.1',
  udpPort: 47475,
  tcpPort: 47476,
  publicKey: `public-key-${id}`,
  roomFingerprint: 'room-fingerprint',
  capabilities: ['discovery', 'tcp-session', 'chat'],
  lastSeenAt: '2026-07-05T12:00:00.000Z',
  ...overrides
});

const createHarness = async (
  overrides: Pick<UchatAppServiceOptions, 'checkConfiguredPorts' | 'deliveryAckTimeoutMs' | 'getLanInterfaces'> = {},
  seedStorage?: (storage: ReturnType<typeof createSqliteStorage>) => Promise<void>
) => {
  const directory = await mkdtemp(join(tmpdir(), 'uchat-app-service-'));
  const storage = createSqliteStorage(join(directory, 'uchat.sqlite3'));
  await seedStorage?.(storage);
  const networkEvents: string[] = [];
  const peerEvents: Peer[] = [];
  const peerRemovedEvents: string[] = [];
  const messageEvents: ChatMessage[] = [];
  const discoveryRuntimes: FakeDiscoveryRuntime[] = [];
  const tcpRuntimes: FakeTcpSessionRuntime[] = [];
  const defaultCheckConfiguredPorts: UchatAppServiceOptions['checkConfiguredPorts'] = async ({
    udpPort,
    tcpPort
  }) => ({
    udp: {
      protocol: 'udp',
      port: udpPort,
      available: true
    },
    tcp: {
      protocol: 'tcp',
      port: tcpPort,
      available: true
    }
  });
  const createDiscoveryService: DiscoveryServiceFactory = (config, events) => {
    const runtime = new FakeDiscoveryRuntime(config, events);
    discoveryRuntimes.push(runtime);
    return runtime;
  };
  const createTcpSessionManager: TcpSessionManagerFactory = (config, events) => {
    const runtime = new FakeTcpSessionRuntime(config, events);
    tcpRuntimes.push(runtime);
    return runtime;
  };
  const service = createUchatAppService(
    storage,
    (event) => {
      networkEvents.push(event.message);
    },
    {
      createDiscoveryService,
      createTcpSessionManager,
      checkConfiguredPorts: defaultCheckConfiguredPorts,
      getLanInterfaces: () => [{ name: 'wlan0', address: '192.168.18.80' }],
      onPeerUpdated: (peer) => peerEvents.push(peer),
      onPeerRemoved: (peerId) => peerRemovedEvents.push(peerId),
      onMessageReceived: (message) => messageEvents.push(message),
      ...overrides
    }
  );

  return {
    service,
    storage,
    networkEvents,
    peerEvents,
    peerRemovedEvents,
    messageEvents,
    discoveryRuntimes,
    tcpRuntimes
  };
};

describe('createUchatAppService discovery integration', () => {
  it('rejects malformed application inputs before persistence or networking', async () => {
    const { service } = await createHarness();

    await expect(service.setProfile(null as never)).rejects.toThrow('expected an object');
    await expect(
      service.joinRoom({ roomName: 'Lab', passphrase: 'secret', tcpPort: 0 })
    ).rejects.toThrow('tcpPort must be an integer from 1 to 65535');
    await expect(
      service.sendMessage({ conversationId: 'broadcast', body: 'x'.repeat(8_193) })
    ).rejects.toThrow('body must be at most 8192 characters');

    await service.cleanup();
  });

  it('marks persisted joined rooms disconnected and clears stale peers on startup', async () => {
    const stalePeer = createPeer('stale-peer');
    const { service, storage, networkEvents, discoveryRuntimes, tcpRuntimes } = await createHarness(
      {},
      async (storage) => {
        await storage.setRoom({
          roomName: 'Persisted room',
          joined: true,
          udpPort: 48_888,
          tcpPort: 48_889
        });
        await storage.upsertPeer(stalePeer);
        await storage.createMessage({
          id: 'persisted-message',
          conversationId: 'broadcast',
          body: 'history stays',
          author: 'local',
          deliveryState: 'sent'
        });
      }
    );

    const state = await service.getAppState();

    expect(state.room).toEqual({
      roomName: 'Persisted room',
      joined: false,
      udpPort: 48_888,
      tcpPort: 48_889
    });
    expect(state.peers).toEqual([]);
    await expect(storage.listPeers()).resolves.toEqual([]);
    await expect(storage.listMessages('broadcast')).resolves.toContainEqual(
      expect.objectContaining({
        id: 'persisted-message',
        body: 'history stays'
      })
    );
    expect(discoveryRuntimes).toHaveLength(0);
    expect(tcpRuntimes).toHaveLength(0);
    expect(networkEvents).toContain(
      'LAN networking is disconnected after restart. Re-enter the room passphrase to resume UDP discovery and TCP chat.'
    );

    await service.cleanup();
  });

  it('derives room identity and starts discovery when joining a room', async () => {
    const { service, storage, discoveryRuntimes, tcpRuntimes, networkEvents } = await createHarness();

    await service.setProfile({ displayName: 'Alice', status: 'away' });
    const state = await service.joinRoom({
      roomName: ' Team Room ',
      passphrase: 'correct horse battery staple',
      udpPort: 48_888,
      tcpPort: 48_889
    });

    expect(discoveryRuntimes).toHaveLength(1);
    expect(tcpRuntimes).toHaveLength(1);
    expect(tcpRuntimes[0].startCalls).toBe(1);
    expect(discoveryRuntimes[0].startCalls).toBe(1);
    expect(discoveryRuntimes[0].config.udpPort).toBe(48_888);
    expect(tcpRuntimes[0].config.tcpPort).toBe(48_889);
    expect(discoveryRuntimes[0].config.localPeer).toEqual(
      expect.objectContaining({
        displayName: 'Alice',
        status: 'away',
        udpPort: 48_888,
        tcpPort: 48_889,
        capabilities: ['discovery', 'tcp-session', 'chat']
      })
    );
    expect(discoveryRuntimes[0].config.localPeer.id).toBe(discoveryRuntimes[0].config.localPeer.publicKey);
    expect(discoveryRuntimes[0].config.localPeer.publicKey.length).toBeGreaterThan(0);
    expect(discoveryRuntimes[0].config.localPeer.roomFingerprint.length).toBeGreaterThan(0);
    expect(state.room).toEqual({
      roomName: 'Team Room',
      joined: true,
      udpPort: 48_888,
      tcpPort: 48_889
    });
    expect(JSON.stringify(await storage.getAppState())).not.toContain('correct horse battery staple');
    expect(networkEvents.at(-1)).toBe('Room "Team Room" joined. UDP discovery and TCP listener started.');

    await service.cleanup();
  });

  it('records port-in-use failures before starting room networking', async () => {
    const { service, storage, networkEvents, discoveryRuntimes, tcpRuntimes } = await createHarness({
      checkConfiguredPorts: async ({ udpPort, tcpPort }) => ({
        udp: {
          protocol: 'udp',
          port: udpPort,
          available: true
        },
        tcp: {
          protocol: 'tcp',
          port: tcpPort,
          available: false,
          code: 'EADDRINUSE',
          message: 'listen EADDRINUSE'
        }
      })
    });

    await expect(
      service.joinRoom({
        roomName: 'Room',
        passphrase: 'secret',
        udpPort: 48_888,
        tcpPort: 48_889
      })
    ).rejects.toThrow('Cannot join room because one or more configured ports are unavailable.');

    expect(discoveryRuntimes).toHaveLength(0);
    expect(tcpRuntimes).toHaveLength(0);
    expect(networkEvents).toContain(
      'TCP port 48889 is unavailable. Close the app using 48889/tcp or choose a different TCP port.'
    );
    await expect(storage.getAppState()).resolves.toEqual(
      expect.objectContaining({
        room: expect.objectContaining({
          joined: false
        })
      })
    );

    await service.cleanup();
  });

  it('restarts discovery on subsequent room joins', async () => {
    const { service, discoveryRuntimes, tcpRuntimes } = await createHarness();

    await service.joinRoom({ roomName: 'First', passphrase: 'one' });
    await service.joinRoom({ roomName: 'Second', passphrase: 'two', udpPort: 49_000 });

    expect(discoveryRuntimes).toHaveLength(2);
    expect(tcpRuntimes).toHaveLength(2);
    expect(discoveryRuntimes[0].stopCalls).toBe(1);
    expect(tcpRuntimes[0].stopCalls).toBe(1);
    expect(discoveryRuntimes[1].startCalls).toBe(1);
    expect(tcpRuntimes[1].startCalls).toBe(1);
    expect(discoveryRuntimes[1].config.udpPort).toBe(49_000);

    await service.cleanup();
  });

  it('stops discovery and TCP sessions once during cleanup', async () => {
    const { service, discoveryRuntimes, tcpRuntimes } = await createHarness();

    await service.joinRoom({ roomName: 'Room', passphrase: 'secret' });
    await service.cleanup();
    await service.cleanup();

    expect(discoveryRuntimes[0].stopCalls).toBe(1);
    expect(tcpRuntimes[0].stopCalls).toBe(1);
  });

  it('reflects live discovery peers in app state and peer callbacks', async () => {
    const { service, storage, peerEvents, discoveryRuntimes } = await createHarness();
    const peer = createPeer('peer-a', { address: '192.168.1.25' });

    await service.joinRoom({ roomName: 'Room', passphrase: 'secret' });
    discoveryRuntimes[0].emitPeerUpdated(peer);
    await nextTick();

    await expect(service.listPeers()).resolves.toEqual([peer]);
    await expect(service.getAppState()).resolves.toEqual(expect.objectContaining({ peers: [peer] }));
    await expect(storage.listPeers()).resolves.toEqual([peer]);
    expect(peerEvents).toEqual([peer]);

    await service.cleanup();
  });

  it('removes departed peers from live and persisted state while keeping direct history offline', async () => {
    const { service, storage, discoveryRuntimes, peerRemovedEvents } = await createHarness();
    const peer = createPeer('peer-a');

    await service.joinRoom({ roomName: 'Room', passphrase: 'secret' });
    discoveryRuntimes[0].emitPeerUpdated(peer);
    await waitFor(async () => (await storage.listPeers()).some((current) => current.id === peer.id));
    await storage.createConversation({
      id: 'direct-peer-a',
      kind: 'direct',
      title: peer.displayName,
      peerId: peer.id
    });

    discoveryRuntimes[0].emitPeerRemoved(peer.id);
    await waitFor(async () => (await storage.listPeers()).every((current) => current.id !== peer.id));

    await expect(service.listPeers()).resolves.toEqual([]);
    await expect(service.getAppState()).resolves.toEqual(expect.objectContaining({ peers: [] }));
    await expect(storage.listConversations()).resolves.toContainEqual(
      expect.objectContaining({
        id: 'direct-peer-a',
        peerId: peer.id
      })
    );
    expect(peerRemovedEvents).toEqual([peer.id]);

    const message = await service.sendMessage({
      conversationId: 'direct-peer-a',
      body: 'are you back?'
    });

    expect(message.deliveryState).toBe('unsent');
    await service.cleanup();
  });

  it('marks broadcast messages unsent when no same-room peers are online', async () => {
    const { service } = await createHarness();

    await service.joinRoom({ roomName: 'Room', passphrase: 'secret' });
    const message = await service.sendMessage({
      conversationId: 'broadcast',
      body: 'hello everyone'
    });

    expect(message.deliveryState).toBe('unsent');

    await service.cleanup();
  });

  it('sends broadcast messages through TCP sessions for online same-room peers', async () => {
    const { service, discoveryRuntimes, tcpRuntimes } = await createHarness();

    await service.joinRoom({ roomName: 'Room', passphrase: 'secret' });
    const roomFingerprint = discoveryRuntimes[0].config.localPeer.roomFingerprint;
    discoveryRuntimes[0].emitPeerUpdated(createPeer('peer-a', { roomFingerprint }));
    discoveryRuntimes[0].emitPeerUpdated(createPeer('peer-b', { roomFingerprint }));
    await nextTick();

    const message = await service.sendMessage({
      conversationId: 'broadcast',
      body: 'hello everyone'
    });

    expect(message.deliveryState).toBe('sent');
    expect(tcpRuntimes[0].sent).toHaveLength(2);
    expect(tcpRuntimes[0].sent.every((sent) => sent.contentType === CHAT_MESSAGE_CONTENT_TYPE)).toBe(true);

    await service.cleanup();
  });

  it('keeps broadcast messages sent until every attempted recipient acknowledges', async () => {
    const { service, storage, discoveryRuntimes, messageEvents, tcpRuntimes } = await createHarness();

    await service.joinRoom({ roomName: 'Room', passphrase: 'secret' });
    const roomFingerprint = discoveryRuntimes[0].config.localPeer.roomFingerprint;
    discoveryRuntimes[0].emitPeerUpdated(createPeer('peer-a', { roomFingerprint }));
    discoveryRuntimes[0].emitPeerUpdated(createPeer('peer-b', { roomFingerprint }));
    await nextTick();

    const message = await service.sendMessage({
      conversationId: 'broadcast',
      body: 'ack carefully'
    });
    const peerASession = tcpRuntimes[0].sessions.find((session) => session.remotePeer.id === 'peer-a');
    const peerBSession = tcpRuntimes[0].sessions.find((session) => session.remotePeer.id === 'peer-b');

    expect(message.deliveryState).toBe('sent');
    expect(peerASession).toBeDefined();
    expect(peerBSession).toBeDefined();

    tcpRuntimes[0].emitEncryptedMessage({
      session: peerASession as TcpSession,
      contentType: CHAT_ACK_CONTENT_TYPE,
      payload: serializeChatFrame(createChatAckFrame(message.id))
    });
    await nextTick();

    await expect(storage.listMessages('broadcast')).resolves.toContainEqual(
      expect.objectContaining({
        id: message.id,
        deliveryState: 'sent'
      })
    );
    expect(messageEvents).not.toContainEqual(
      expect.objectContaining({
        id: message.id,
        deliveryState: 'delivered'
      })
    );

    tcpRuntimes[0].emitEncryptedMessage({
      session: peerBSession as TcpSession,
      contentType: CHAT_ACK_CONTENT_TYPE,
      payload: serializeChatFrame(createChatAckFrame(message.id))
    });
    await waitFor(async () =>
      (await storage.listMessages('broadcast')).some(
        (current) => current.id === message.id && current.deliveryState === 'delivered'
      )
    );

    expect(messageEvents).toContainEqual(
      expect.objectContaining({
        id: message.id,
        deliveryState: 'delivered'
      })
    );

    await service.cleanup();
  });

  it('marks direct messages unsent when the peer is offline', async () => {
    const { service, storage } = await createHarness();

    await service.joinRoom({ roomName: 'Room', passphrase: 'secret' });
    await storage.createConversation({
      id: 'direct-peer-a',
      kind: 'direct',
      title: 'Peer A',
      peerId: 'peer-a'
    });

    const message = await service.sendMessage({
      conversationId: 'direct-peer-a',
      body: 'are you there?'
    });

    expect(message.deliveryState).toBe('unsent');

    await service.cleanup();
  });

  it('fails direct messages when the peer stays silent after receiving them', async () => {
    const { service, storage, discoveryRuntimes, messageEvents } = await createHarness({
      deliveryAckTimeoutMs: 20
    });

    await service.joinRoom({ roomName: 'Room', passphrase: 'secret' });
    const roomFingerprint = discoveryRuntimes[0].config.localPeer.roomFingerprint;
    discoveryRuntimes[0].emitPeerUpdated(createPeer('peer-a', { roomFingerprint }));
    await nextTick();
    await storage.createConversation({
      id: 'direct-peer-a',
      kind: 'direct',
      title: 'Peer A',
      peerId: 'peer-a'
    });

    const message = await service.sendMessage({
      conversationId: 'direct-peer-a',
      body: 'please acknowledge'
    });

    expect(message.deliveryState).toBe('sent');
    await waitFor(async () =>
      (await storage.listMessages('direct-peer-a')).some(
        (current) => current.id === message.id && current.deliveryState === 'failed'
      )
    );
    expect(messageEvents).toContainEqual(
      expect.objectContaining({
        id: message.id,
        deliveryState: 'failed'
      })
    );

    await service.cleanup();
  });

  it('persists inbound chat messages and sends acknowledgements', async () => {
    const { service, storage, messageEvents, tcpRuntimes } = await createHarness();

    await service.joinRoom({ roomName: 'Room', passphrase: 'secret' });
    const remotePeer = tcpRuntimes[0].config.peer;
    const session = await tcpRuntimes[0].connectToPeer({
      peer: {
        ...remotePeer,
        id: 'peer-a',
        displayName: 'Peer A',
        publicKey: 'public-key-peer-a'
      },
      address: '127.0.0.1'
    });
    const frame = createChatMessageFrame({
      messageId: 'remote-message-1',
      body: 'hello local',
      scope: 'direct',
      sentAt: '2026-07-05T12:00:00.000Z'
    });

    tcpRuntimes[0].emitEncryptedMessage({
      session,
      contentType: CHAT_MESSAGE_CONTENT_TYPE,
      payload: serializeChatFrame(frame)
    });
    await waitFor(async () =>
      (await storage.listConversations()).some((conversation) => conversation.peerId === 'peer-a')
    );

    const conversations = await storage.listConversations();
    const directConversation = conversations.find((conversation) => conversation.peerId === 'peer-a');

    expect(directConversation).toBeDefined();
    await expect(storage.listMessages(directConversation?.id)).resolves.toEqual([
      expect.objectContaining({
        id: 'remote-message-1',
        body: 'hello local',
        author: 'peer',
        deliveryState: 'delivered'
      })
    ]);
    expect(messageEvents).toEqual([
      expect.objectContaining({
        id: 'remote-message-1'
      })
    ]);
    expect(tcpRuntimes[0].sent).toContainEqual(
      expect.objectContaining({
        peerId: 'peer-a',
        contentType: CHAT_ACK_CONTENT_TYPE
      })
    );

    await service.cleanup();
  });

  it('updates local message delivery when chat acknowledgements arrive', async () => {
    const { service, storage, messageEvents, discoveryRuntimes, tcpRuntimes } = await createHarness();

    await service.joinRoom({ roomName: 'Room', passphrase: 'secret' });
    const roomFingerprint = discoveryRuntimes[0].config.localPeer.roomFingerprint;
    discoveryRuntimes[0].emitPeerUpdated(createPeer('peer-a', { roomFingerprint }));
    await nextTick();
    await storage.createConversation({
      id: 'direct-peer-a',
      kind: 'direct',
      title: 'Peer A',
      peerId: 'peer-a'
    });
    const message = await service.sendMessage({
      conversationId: 'direct-peer-a',
      body: 'hello'
    });
    const session = tcpRuntimes[0].sessions.find((current) => current.remotePeer.id === 'peer-a');
    expect(session).toBeDefined();

    tcpRuntimes[0].emitEncryptedMessage({
      session: session as TcpSession,
      contentType: CHAT_ACK_CONTENT_TYPE,
      payload: serializeChatFrame(createChatAckFrame(message.id))
    });
    await waitFor(async () =>
      (await storage.listMessages('direct-peer-a')).some(
        (current) => current.id === message.id && current.deliveryState === 'delivered'
      )
    );

    await expect(storage.listMessages('direct-peer-a')).resolves.toContainEqual(
      expect.objectContaining({
        id: message.id,
        deliveryState: 'delivered'
      })
    );
    expect(messageEvents).toContainEqual(
      expect.objectContaining({
        id: message.id,
        deliveryState: 'delivered'
      })
    );

    await service.cleanup();
  });

  it('ignores an acknowledgement from the wrong direct recipient and late acknowledgements', async () => {
    const { service, storage, discoveryRuntimes, messageEvents, tcpRuntimes } = await createHarness({
      deliveryAckTimeoutMs: 20
    });

    await service.joinRoom({ roomName: 'Room', passphrase: 'secret' });
    const roomFingerprint = discoveryRuntimes[0].config.localPeer.roomFingerprint;
    discoveryRuntimes[0].emitPeerUpdated(createPeer('peer-a', { roomFingerprint }));
    discoveryRuntimes[0].emitPeerUpdated(createPeer('peer-b', { roomFingerprint }));
    await nextTick();
    await storage.createConversation({
      id: 'direct-peer-a',
      kind: 'direct',
      title: 'Peer A',
      peerId: 'peer-a'
    });

    const message = await service.sendMessage({
      conversationId: 'direct-peer-a',
      body: 'only peer A should confirm this'
    });
    const peerASession = tcpRuntimes[0].sessions.find((session) => session.remotePeer.id === 'peer-a');
    const peerB = createPeer('peer-b', { roomFingerprint });
    const peerBSession = await tcpRuntimes[0].connectToPeer({
      peer: {
        ...peerB,
        publicKey: peerB.publicKey as string,
        roomFingerprint: peerB.roomFingerprint as string,
        capabilities: peerB.capabilities as string[]
      },
      address: '127.0.0.1'
    });
    expect(peerASession).toBeDefined();
    expect(peerBSession).toBeDefined();

    tcpRuntimes[0].emitEncryptedMessage({
      session: peerBSession as TcpSession,
      contentType: CHAT_ACK_CONTENT_TYPE,
      payload: serializeChatFrame(createChatAckFrame(message.id))
    });
    await nextTick();
    await expect(storage.listMessages('direct-peer-a')).resolves.toContainEqual(
      expect.objectContaining({ id: message.id, deliveryState: 'sent' })
    );

    await waitFor(async () =>
      (await storage.listMessages('direct-peer-a')).some(
        (current) => current.id === message.id && current.deliveryState === 'failed'
      )
    );

    tcpRuntimes[0].emitEncryptedMessage({
      session: peerASession as TcpSession,
      contentType: CHAT_ACK_CONTENT_TYPE,
      payload: serializeChatFrame(createChatAckFrame(message.id))
    });
    await nextTick();

    await expect(storage.listMessages('direct-peer-a')).resolves.toContainEqual(
      expect.objectContaining({ id: message.id, deliveryState: 'failed' })
    );
    expect(messageEvents).not.toContainEqual(
      expect.objectContaining({ id: message.id, deliveryState: 'delivered' })
    );

    await service.cleanup();
  });

  it('fails a broadcast when an expected recipient stays silent', async () => {
    const { service, storage, discoveryRuntimes, tcpRuntimes } = await createHarness({
      deliveryAckTimeoutMs: 20
    });

    await service.joinRoom({ roomName: 'Room', passphrase: 'secret' });
    const roomFingerprint = discoveryRuntimes[0].config.localPeer.roomFingerprint;
    discoveryRuntimes[0].emitPeerUpdated(createPeer('peer-a', { roomFingerprint }));
    discoveryRuntimes[0].emitPeerUpdated(createPeer('peer-b', { roomFingerprint }));
    await nextTick();

    const message = await service.sendMessage({
      conversationId: 'broadcast',
      body: 'both peers must acknowledge'
    });
    const peerASession = tcpRuntimes[0].sessions.find((session) => session.remotePeer.id === 'peer-a');
    expect(peerASession).toBeDefined();

    tcpRuntimes[0].emitEncryptedMessage({
      session: peerASession as TcpSession,
      contentType: CHAT_ACK_CONTENT_TYPE,
      payload: serializeChatFrame(createChatAckFrame(message.id))
    });

    await waitFor(async () =>
      (await storage.listMessages('broadcast')).some(
        (current) => current.id === message.id && current.deliveryState === 'failed'
      )
    );

    await expect(storage.listMessages('broadcast')).resolves.toContainEqual(
      expect.objectContaining({ id: message.id, deliveryState: 'failed' })
    );

    await service.cleanup();
  });
});
