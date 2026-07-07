#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdtemp } from 'node:fs/promises';
import { createServer as createTcpServer, connect as connectSocket, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DiscoveryPeerIdentity } from '../src/shared/discovery';
import type { NetworkEvent, Peer } from '../src/shared/types';
import {
  CHAT_ACK_CONTENT_TYPE,
  CHAT_MESSAGE_CONTENT_TYPE,
  createChatAckFrame,
  createChatMessageFrame,
  serializeChatFrame,
  validateChatAckFrame,
  validateChatMessageFrame
} from '../src/main/chatProtocol';
import {
  createUchatAppService,
  type DiscoveryRuntime,
  type DiscoveryServiceFactory,
  type UchatAppService
} from '../src/main/appService';
import { createLocalDiscoveryPeer } from '../src/main/discovery';
import { deriveRoomKey, generateX25519Identity, type DerivedRoomKey, type X25519Identity } from '../src/main/security/crypto';
import { createSqliteStorage } from '../src/main/storage/sqliteStorage';
import type { UchatStorage } from '../src/main/storage/types';
import { encodeTcpFrame } from '../src/main/tcp/framing';
import {
  TcpSessionError,
  TcpSessionManager,
  type TcpEncryptedMessage,
  type TcpSession,
  type TcpSessionErrorEvent,
  type TcpSessionManagerEvents
} from '../src/main/tcp/session';

interface TestPeer {
  identity: X25519Identity;
  peer: DiscoveryPeerIdentity;
}

interface ScenarioResult {
  name: string;
  metrics: Record<string, number | string | boolean>;
}

interface EchoPeerHarness {
  manager: TcpSessionManager;
  peer: DiscoveryPeerIdentity;
  receivedMessages: string[];
  ackedMessages: string[];
}

class ControlledDiscoveryRuntime implements DiscoveryRuntime {
  peers: Peer[] = [];

  constructor(private readonly events: { onPeerUpdated?(peer: Peer): void }) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  listPeers(): Peer[] {
    return [...this.peers];
  }

  setPeers(peers: Peer[]): void {
    this.peers = [...peers];
    for (const peer of peers) {
      this.events.onPeerUpdated?.(peer);
    }
  }
}

const DEFAULT_UDP_PORT = 47475;
const LAN_ADDRESS = '127.0.0.1';
let nextEphemeralAdvertisedTcpPort = 40_000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> => {
  const startedAt = Date.now();

  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.`);
    }

    await wait(20);
  }
};

const getFreeTcpPort = async (): Promise<number> => {
  const server = createTcpServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LAN_ADDRESS, () => resolve());
  });

  const port = (server.address() as AddressInfo).port;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  return port;
};

const getFreeUdpPort = async (): Promise<number> => {
  const socket = createSocket('udp4');

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, LAN_ADDRESS, () => resolve());
  });

  const address = socket.address();
  const port = typeof address === 'string' ? 0 : address.port;

  await new Promise<void>((resolve) => {
    socket.close(() => resolve());
  });

  return port;
};

const getAdvertisedTcpPort = (): number => {
  nextEphemeralAdvertisedTcpPort += 1;
  return nextEphemeralAdvertisedTcpPort;
};

const createPeer = (
  label: string,
  room: DerivedRoomKey,
  tcpPort = getAdvertisedTcpPort(),
  capabilities = ['discovery', 'tcp-session', 'chat']
): TestPeer => {
  const identity = generateX25519Identity();

  return {
    identity,
    peer: createLocalDiscoveryPeer({
      id: `${label}-${identity.publicKey.slice(0, 12)}`,
      displayName: label,
      status: 'available',
      roomFingerprint: room.fingerprint,
      publicKey: identity.publicKey,
      udpPort: DEFAULT_UDP_PORT,
      tcpPort,
      capabilities
    })
  };
};

const createManager = (
  local: TestPeer,
  room: DerivedRoomKey,
  events: TcpSessionManagerEvents = {},
  tcpPort = 0
): TcpSessionManager =>
  new TcpSessionManager(
    {
      peer: local.peer,
      privateKey: local.identity.privateKey,
      roomKey: room.key,
      host: LAN_ADDRESS,
      tcpPort,
      handshakeTimeoutMs: 3_000
    },
    events
  );

const startEchoPeer = async (
  label: string,
  room: DerivedRoomKey,
  options: { acknowledgeMessages: boolean }
): Promise<EchoPeerHarness> => {
  const seed = createPeer(label, room);
  const receivedMessages: string[] = [];
  const ackedMessages: string[] = [];
  const manager = createManager(
    seed,
    room,
    {
      onEncryptedMessage: (message) => {
        void handleEchoPeerMessage(message, options.acknowledgeMessages, receivedMessages, ackedMessages);
      }
    },
    0
  );

  seed.peer.tcpPort = await manager.start();

  return {
    manager,
    peer: {
      ...seed.peer
    },
    receivedMessages,
    ackedMessages
  };
};

const handleEchoPeerMessage = async (
  message: TcpEncryptedMessage,
  acknowledgeMessages: boolean,
  receivedMessages: string[],
  ackedMessages: string[]
): Promise<void> => {
  if (message.contentType !== CHAT_MESSAGE_CONTENT_TYPE) {
    return;
  }

  const validation = validateChatMessageFrame(message.payload);
  if (!validation.ok) {
    return;
  }

  receivedMessages.push(validation.frame.messageId);

  if (!acknowledgeMessages) {
    return;
  }

  ackedMessages.push(validation.frame.messageId);
  await message.session.sendEncrypted(
    CHAT_ACK_CONTENT_TYPE,
    serializeChatFrame(createChatAckFrame(validation.frame.messageId))
  );
};

const connectWithRoom = async (
  clientLabel: string,
  hubPeer: DiscoveryPeerIdentity,
  room: DerivedRoomKey
): Promise<{ manager: TcpSessionManager; session: TcpSession }> => {
  const client = createPeer(clientLabel, room);
  const manager = createManager(client, room);
  const session = await manager.connectToPeer({
    peer: hubPeer,
    address: LAN_ADDRESS,
    port: hubPeer.tcpPort,
    timeoutMs: 3_000
  });

  return { manager, session };
};

const runSimulatorSmoke = async (): Promise<ScenarioResult> => {
  const { createPeerSimulator } = await import('../src/dev/peerSimulator');
  const roomName = `Load smoke ${Date.now()}`;
  const passphrase = 'load-smoke-secret';
  const room = await deriveRoomKey(roomName, passphrase);
  const simulatorUdpPort = await getFreeUdpPort();
  const simulator = createPeerSimulator({
    roomName,
    passphrase,
    displayName: 'Load Smoke Simulator',
    udpPort: simulatorUdpPort,
    tcpPort: 0
  });
  const hub = createPeer('smoke-hub', room);
  let receivedFromSimulator = 0;
  let ackedBySimulator = 0;
  const hubManager = createManager(
    hub,
    room,
    {
      onEncryptedMessage: (message) => {
        if (message.contentType === CHAT_ACK_CONTENT_TYPE) {
          const ack = validateChatAckFrame(message.payload);
          if (ack.ok) {
            ackedBySimulator += 1;
          }
          return;
        }

        if (message.contentType === CHAT_MESSAGE_CONTENT_TYPE) {
          const inbound = validateChatMessageFrame(message.payload);
          if (!inbound.ok) {
            return;
          }

          receivedFromSimulator += 1;
          void message.session.sendEncrypted(
            CHAT_ACK_CONTENT_TYPE,
            serializeChatFrame(createChatAckFrame(inbound.frame.messageId))
          );
        }
      }
    },
    0
  );

  try {
    hub.peer.tcpPort = await hubManager.start();
    await simulator.start();

    const simulatorState = simulator.getState();
    const session = await hubManager.connectToPeer({
      peer: simulatorState.localPeer,
      address: LAN_ADDRESS,
      port: simulatorState.tcpPort,
      timeoutMs: 3_000
    });

    await session.sendEncrypted(
      CHAT_MESSAGE_CONTENT_TYPE,
      serializeChatFrame(
        createChatMessageFrame({
          messageId: randomUUID(),
          body: 'hello from validation hub',
          scope: 'direct'
        })
      )
    );

    await waitUntil(() => ackedBySimulator === 1, 3_000, 'simulator acknowledgement');

    await simulator.sendMessage({
      body: 'hello back from simulator',
      scope: 'direct',
      targetPeerId: hub.peer.id
    });

    await waitUntil(() => receivedFromSimulator === 1, 3_000, 'simulator reply');

    return {
      name: 'simulator-smoke',
      metrics: {
        handshake_ok: true,
        acked_by_simulator: ackedBySimulator,
        inbound_from_simulator: receivedFromSimulator,
        simulator_tcp_port: simulatorState.tcpPort
      }
    };
  } finally {
    await simulator.stop().catch(() => undefined);
    await hubManager.stop().catch(() => undefined);
  }
};

const runHandshakeFanout = async (): Promise<ScenarioResult> => {
  const room = await deriveRoomKey('Load fanout room', 'fanout-secret');
  const hub = createPeer('fanout-hub', room);
  const hubManager = createManager(hub, room, {}, 0);
  const clientManagers: TcpSessionManager[] = [];
  const clientCount = 48;

  try {
    hub.peer.tcpPort = await hubManager.start();

    const startedAt = performance.now();
    const sessions = await Promise.all(
      Array.from({ length: clientCount }, async (_, index) => {
        const { manager, session } = await connectWithRoom(`fanout-client-${index + 1}`, hub.peer, room);
        clientManagers.push(manager);
        return session;
      })
    );
    const elapsedMs = performance.now() - startedAt;

    await waitUntil(
      () => hubManager.listSessions().length === clientCount,
      3_000,
      'hub session fanout'
    );

    return {
      name: 'handshake-fanout',
      metrics: {
        concurrent_clients: clientCount,
        client_sessions_ready: sessions.length,
        hub_sessions_ready: hubManager.listSessions().length,
        elapsed_ms: Math.round(elapsedMs)
      }
    };
  } finally {
    await Promise.all(clientManagers.map((manager) => manager.stop().catch(() => undefined)));
    await hubManager.stop().catch(() => undefined);
  }
};

const runBurstScenario = async (): Promise<ScenarioResult> => {
  const room = await deriveRoomKey('Burst room', 'burst-secret');
  const hub = createPeer('burst-hub', room);
  let receivedCount = 0;
  let ackCount = 0;
  const hubManager = createManager(
    hub,
    room,
    {
      onEncryptedMessage: (message) => {
        void (async () => {
          if (message.contentType !== CHAT_MESSAGE_CONTENT_TYPE) {
            return;
          }

          const inbound = validateChatMessageFrame(message.payload);
          if (!inbound.ok) {
            return;
          }

          receivedCount += 1;
          await message.session.sendEncrypted(
            CHAT_ACK_CONTENT_TYPE,
            serializeChatFrame(createChatAckFrame(inbound.frame.messageId))
          );
        })();
      }
    },
    0
  );
  const clientManagers: TcpSessionManager[] = [];
  const clientCount = 12;
  const messagesPerClient = 50;
  const sessions: TcpSession[] = [];

  try {
    hub.peer.tcpPort = await hubManager.start();

    for (let index = 0; index < clientCount; index += 1) {
      const client = createPeer(`burst-client-${index + 1}`, room);
      const manager = createManager(
        client,
        room,
        {
          onEncryptedMessage: (message) => {
            if (message.contentType !== CHAT_ACK_CONTENT_TYPE) {
              return;
            }

            const ack = validateChatAckFrame(message.payload);
            if (ack.ok) {
              ackCount += 1;
            }
          }
        }
      );
      clientManagers.push(manager);
      const session = await manager.connectToPeer({
        peer: hub.peer,
        address: LAN_ADDRESS,
        port: hub.peer.tcpPort,
        timeoutMs: 3_000
      });
      sessions.push(session);
    }

    const totalMessages = clientCount * messagesPerClient;
    const startedAt = performance.now();

    await Promise.all(
      sessions.flatMap((session, clientIndex) =>
        Array.from({ length: messagesPerClient }, (_, messageIndex) =>
          session.sendEncrypted(
            CHAT_MESSAGE_CONTENT_TYPE,
            serializeChatFrame(
              createChatMessageFrame({
                messageId: `burst-${clientIndex + 1}-${messageIndex + 1}-${randomUUID()}`,
                body: `payload ${clientIndex + 1}-${messageIndex + 1}`,
                scope: 'direct'
              })
            )
          )
        )
      )
    );

    await waitUntil(() => receivedCount === totalMessages, 5_000, 'hub burst receive count');
    await waitUntil(() => ackCount === totalMessages, 5_000, 'client burst ack count');

    const elapsedMs = performance.now() - startedAt;

    return {
      name: 'message-burst',
      metrics: {
        clients: clientCount,
        messages_per_client: messagesPerClient,
        total_messages: totalMessages,
        received_count: receivedCount,
        ack_count: ackCount,
        elapsed_ms: Math.round(elapsedMs),
        messages_per_second: Math.round((totalMessages / elapsedMs) * 1000)
      }
    };
  } finally {
    await Promise.all(clientManagers.map((manager) => manager.stop().catch(() => undefined)));
    await hubManager.stop().catch(() => undefined);
  }
};

const writeAndCloseSocket = async (socket: Socket, payload: Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.write(payload, (error) => {
      if (error) {
        reject(error);
        return;
      }

      socket.end(() => resolve());
    });
  });

const runMalformedFrameScenario = async (): Promise<ScenarioResult> => {
  const room = await deriveRoomKey('Malformed room', 'malformed-secret');
  const hub = createPeer('malformed-hub', room);
  const errors: TcpSessionErrorEvent[] = [];
  const hubManager = createManager(
    hub,
    room,
    {
      onSessionError: (error) => {
        errors.push(error);
      }
    },
    0
  );

  try {
    hub.peer.tcpPort = await hubManager.start();

    const invalidJsonFrame = encodeTcpFrame('not json');
    const emptyFrameHeader = Buffer.alloc(4);
    const oversizedFrameHeader = Buffer.alloc(4);
    oversizedFrameHeader.writeUInt32BE(2 * 1024 * 1024, 0);

    for (const payload of [invalidJsonFrame, emptyFrameHeader, oversizedFrameHeader]) {
      const socket = connectSocket({
        host: LAN_ADDRESS,
        port: hub.peer.tcpPort
      });

      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', reject);
      });

      await writeAndCloseSocket(socket, payload);
    }

    await waitUntil(() => errors.length >= 3, 3_000, 'malformed-frame error count');

    const goodClient = createPeer('malformed-good-client', room);
    const goodManager = createManager(goodClient, room);

    try {
      const session = await goodManager.connectToPeer({
        peer: hub.peer,
        address: LAN_ADDRESS,
        port: hub.peer.tcpPort,
        timeoutMs: 3_000
      });

      return {
        name: 'malformed-frames',
        metrics: {
          malformed_attempts: 3,
          session_errors: errors.length,
          invalid_frame_errors: errors.filter((error) => error.code === 'invalid-frame').length,
          invalid_session_message_errors: errors.filter((error) => error.code === 'invalid-session-message').length,
          server_still_accepts_valid_peer: Boolean(session)
        }
      };
    } finally {
      await goodManager.stop().catch(() => undefined);
    }
  } finally {
    await hubManager.stop().catch(() => undefined);
  }
};

const runWrongPassphraseAndRestart = async (): Promise<ScenarioResult> => {
  const goodRoom = await deriveRoomKey('Restart room', 'restart-secret');
  const badRoom = await deriveRoomKey('Restart room', 'restart-secret-wrong');
  const restartPort = await getFreeTcpPort();
  const hub = createPeer('restart-hub', goodRoom, restartPort);
  const errors: string[] = [];
  let hubManager = createManager(
    hub,
    goodRoom,
    {
      onSessionError: (error) => {
        errors.push(error.code);
      }
    },
    restartPort
  );
  let reconnectCycles = 0;

  try {
    hub.peer.tcpPort = await hubManager.start();

    const wrongClient = createPeer('restart-wrong-client', badRoom);
    const wrongManager = createManager(wrongClient, badRoom);

    try {
      await wrongManager.connectToPeer({
        peer: hub.peer,
        address: LAN_ADDRESS,
        port: restartPort,
        timeoutMs: 2_000
      });
    } catch (error) {
      if (!(error instanceof TcpSessionError)) {
        throw error;
      }
    } finally {
      await wrongManager.stop().catch(() => undefined);
    }

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const client = createPeer(`restart-client-${cycle + 1}`, goodRoom);
      const clientManager = createManager(client, goodRoom);

      try {
        const session = await clientManager.connectToPeer({
          peer: hub.peer,
          address: LAN_ADDRESS,
          port: restartPort,
          timeoutMs: 3_000
        });
        session.close();
      } finally {
        await clientManager.stop().catch(() => undefined);
      }

      reconnectCycles += 1;
    }

    await hubManager.stop();
    hubManager = createManager(hub, goodRoom, {}, restartPort);
    hub.peer.tcpPort = await hubManager.start();

    const postRestartClient = createPeer('restart-after-rebind', goodRoom);
    const postRestartManager = createManager(postRestartClient, goodRoom);

    try {
      const postRestartSession = await postRestartManager.connectToPeer({
        peer: hub.peer,
        address: LAN_ADDRESS,
        port: restartPort,
        timeoutMs: 3_000
      });

      return {
        name: 'wrong-passphrase-and-restart',
        metrics: {
          wrong_passphrase_rejected: errors.includes('invalid-session-message'),
          reconnect_cycles: reconnectCycles,
          restart_rebind_port: restartPort,
          restart_accepts_new_session: Boolean(postRestartSession)
        }
      };
    } finally {
      await postRestartManager.stop().catch(() => undefined);
    }
  } finally {
    await hubManager.stop().catch(() => undefined);
  }
};

const createAppServiceHarness = async (
  roomName: string,
  passphrase: string
): Promise<{
  service: UchatAppService;
  storage: UchatStorage;
  discovery: ControlledDiscoveryRuntime;
  networkEvents: NetworkEvent[];
}> => {
  const directory = await mkdtemp(join(tmpdir(), 'uchat-load-service-'));
  const storage = createSqliteStorage(join(directory, 'state.sqlite'));
  const networkEvents: NetworkEvent[] = [];
  let discoveryRuntime: ControlledDiscoveryRuntime | null = null;
  const createDiscoveryService: DiscoveryServiceFactory = (_, events) => {
    discoveryRuntime = new ControlledDiscoveryRuntime(events);
    return discoveryRuntime;
  };

  const service = createUchatAppService(
    storage,
    (event) => {
      networkEvents.push(event);
    },
    {
      createDiscoveryService,
      checkConfiguredPorts: async ({ udpPort, tcpPort }) => ({
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
      }),
      getLanInterfaces: () => [{ name: 'lo', address: LAN_ADDRESS }]
    }
  );

  await service.joinRoom({
    roomName,
    passphrase,
    udpPort: await getFreeUdpPort(),
    tcpPort: await getFreeTcpPort()
  });

  if (!discoveryRuntime) {
    throw new Error('Controlled discovery runtime was not created.');
  }

  return {
    service,
    storage,
    discovery: discoveryRuntime,
    networkEvents
  };
};

const toLivePeer = (peer: DiscoveryPeerIdentity): Peer => ({
  id: peer.id,
  displayName: peer.displayName,
  status: peer.status,
  address: LAN_ADDRESS,
  udpPort: peer.udpPort,
  tcpPort: peer.tcpPort,
  publicKey: peer.publicKey,
  roomFingerprint: peer.roomFingerprint,
  capabilities: peer.capabilities,
  lastSeenAt: new Date().toISOString()
});

const runAppServiceScenarios = async (): Promise<ScenarioResult> => {
  const roomName = 'App service room';
  const passphrase = 'app-service-secret';
  const room = await deriveRoomKey(roomName, passphrase);
  const harness = await createAppServiceHarness(roomName, passphrase);
  const ackingPeer = await startEchoPeer('app-echo-ack', room, { acknowledgeMessages: true });
  const silentPeer = await startEchoPeer('app-echo-silent', room, { acknowledgeMessages: false });

  try {
    harness.discovery.setPeers([toLivePeer(ackingPeer.peer)]);
    await harness.storage.createConversation({
      id: `direct-${ackingPeer.peer.id}`,
      kind: 'direct',
      title: ackingPeer.peer.displayName,
      peerId: ackingPeer.peer.id
    });

    const directMessages = 80;
    const directStartedAt = performance.now();

    for (let index = 0; index < directMessages; index += 1) {
      await harness.service.sendMessage({
        conversationId: `direct-${ackingPeer.peer.id}`,
        body: `direct throughput ${index + 1}`
      });
    }

    await waitUntil(
      async () =>
        (await harness.storage.listMessages(`direct-${ackingPeer.peer.id}`)).filter(
          (message) => message.deliveryState === 'delivered'
        ).length === directMessages,
      8_000,
      'direct app-service deliveries'
    );

    const directElapsedMs = performance.now() - directStartedAt;

    harness.discovery.setPeers([toLivePeer(ackingPeer.peer), toLivePeer(silentPeer.peer)]);

    const broadcastSent = await harness.service.sendMessage({
      conversationId: 'broadcast',
      body: 'partial acknowledgement broadcast'
    });

    await waitUntil(
      async () =>
        (await harness.storage.listMessages('broadcast')).some((message) => message.id === broadcastSent.id),
      3_000,
      'broadcast message persistence'
    );
    await waitUntil(() => ackingPeer.ackedMessages.includes(broadcastSent.id), 3_000, 'single broadcast acknowledgement');
    await wait(200);

    const broadcastState =
      (await harness.storage.listMessages('broadcast')).find((message) => message.id === broadcastSent.id)?.deliveryState ??
      'missing';

    return {
      name: 'app-service-delivery',
      metrics: {
        direct_messages: directMessages,
        direct_elapsed_ms: Math.round(directElapsedMs),
        direct_messages_per_second: Math.round((directMessages / directElapsedMs) * 1000),
        broadcast_seen_by_acking_peer: ackingPeer.receivedMessages.includes(broadcastSent.id),
        broadcast_seen_by_silent_peer: silentPeer.receivedMessages.includes(broadcastSent.id),
        broadcast_acked_by_acking_peer: ackingPeer.ackedMessages.includes(broadcastSent.id),
        broadcast_acked_by_silent_peer: silentPeer.ackedMessages.includes(broadcastSent.id),
        broadcast_final_delivery_state: broadcastState
      }
    };
  } finally {
    await Promise.all([
      harness.service.cleanup().catch(() => undefined),
      ackingPeer.manager.stop().catch(() => undefined),
      silentPeer.manager.stop().catch(() => undefined)
    ]);
  }
};

const runSqliteStoragePressure = async (): Promise<ScenarioResult> => {
  const directory = await mkdtemp(join(tmpdir(), 'uchat-sqlite-storage-'));
  const storage = createSqliteStorage(join(directory, 'state.sqlite'));
  const totalMessages = 250;

  try {
    const startedAt = performance.now();

    for (let index = 0; index < totalMessages; index += 1) {
      const message = await storage.createMessage({
        conversationId: 'broadcast',
        body: `storage pressure ${index + 1}`,
        author: 'local',
        deliveryState: 'sending'
      });

      await storage.updateMessageDeliveryState({
        messageId: message.id,
        deliveryState: 'sent'
      });
      await storage.updateMessageDeliveryState({
        messageId: message.id,
        deliveryState: 'delivered'
      });
      await storage.addNetworkEvent({
        level: 'info',
        message: `storage event ${index + 1}`
      });
    }

    const elapsedMs = performance.now() - startedAt;
    const snapshot = await storage.getAppState();

    return {
      name: 'sqlite-storage-pressure',
      metrics: {
        messages_written: totalMessages,
        total_snapshot_messages: snapshot.messages.length,
        total_snapshot_events: snapshot.networkEvents.length,
        elapsed_ms: Math.round(elapsedMs),
        writes_per_second: Math.round(((totalMessages * 4) / elapsedMs) * 1000)
      }
    };
  } finally {
    await storage.close().catch(() => undefined);
  }
};

const printScenario = (result: ScenarioResult): void => {
  console.log(`\n=== ${result.name} ===`);
  for (const [key, value] of Object.entries(result.metrics)) {
    console.log(`${key}: ${value}`);
  }
};

const main = async (): Promise<void> => {
  const scenarios = [
    runSimulatorSmoke,
    runHandshakeFanout,
    runBurstScenario,
    runMalformedFrameScenario,
    runWrongPassphraseAndRestart,
    runAppServiceScenarios,
    runSqliteStoragePressure
  ];

  for (const scenario of scenarios) {
    const result = await scenario();
    printScenario(result);
  }
};

await main();
