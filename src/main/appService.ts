import { DEFAULT_DISCOVERY_PORT, DEFAULT_TCP_PORT } from '@shared/defaults';
import type { DiscoveryPeerIdentity } from '@shared/discovery';
import type {
  ChatMessage,
  Conversation,
  JoinRoomInput,
  LocalProfile,
  NetworkEvent,
  Peer,
  SendMessageInput,
  SetProfileInput,
  UchatAppState
} from '@shared/types';
import { parseJoinRoomInput, parseSendMessageInput, parseSetProfileInput } from '@shared/validation';
import {
  CHAT_ACK_CONTENT_TYPE,
  CHAT_MESSAGE_CONTENT_TYPE,
  createChatAckFrame,
  createChatMessageFrame,
  serializeChatFrame,
  validateChatAckFrame,
  validateChatMessageFrame
} from './chatProtocol';
import {
  createLocalDiscoveryPeer,
  UdpDiscoveryService,
  type UdpDiscoveryServiceConfig,
  type UdpDiscoveryServiceEvents
} from './discovery';
import { deriveRoomKey, generateX25519Identity } from './security/crypto';
import type { UchatStorage } from './storage/types';
import {
  TcpSessionManager,
  type TcpConnectOptions,
  type TcpEncryptedMessage,
  type TcpSession,
  type TcpSessionManagerConfig,
  type TcpSessionManagerEvents
} from './tcp/session';
import {
  checkConfiguredPortAvailability,
  describePortUnavailable,
  getUsableLanInterfaces,
  type ConfiguredPortAvailability,
  type ConfiguredPorts,
  type LanInterfaceSummary,
  type PortAvailabilityResult,
  type PortProtocol
} from './ports';

export interface UchatAppService {
  getAppState(): Promise<UchatAppState>;
  setProfile(input: SetProfileInput): Promise<LocalProfile>;
  joinRoom(input: JoinRoomInput): Promise<UchatAppState>;
  listPeers(): Promise<Peer[]>;
  listConversations(): Promise<UchatAppState['conversations']>;
  sendMessage(input: SendMessageInput): Promise<ChatMessage>;
  cleanup(): Promise<void>;
}

export interface DiscoveryRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  updateLocalPeer(localPeer: DiscoveryPeerIdentity): Promise<void>;
  listPeers(): Peer[];
}

export interface TcpSessionRuntime {
  start(): Promise<number>;
  stop(): Promise<void>;
  connectToPeer(options: TcpConnectOptions): Promise<TcpSession>;
  listSessions(): TcpSession[];
}

interface RuntimeSnapshot {
  discoveryService: DiscoveryRuntime | null;
  tcpSessionManager: TcpSessionRuntime | null;
  activeLocalPeer: DiscoveryPeerIdentity | null;
}

export type DiscoveryServiceFactory = (
  config: UdpDiscoveryServiceConfig,
  events: UdpDiscoveryServiceEvents
) => DiscoveryRuntime;

export type TcpSessionManagerFactory = (
  config: TcpSessionManagerConfig,
  events: TcpSessionManagerEvents
) => TcpSessionRuntime;

export interface UchatAppServiceOptions {
  createDiscoveryService?: DiscoveryServiceFactory;
  createTcpSessionManager?: TcpSessionManagerFactory;
  checkConfiguredPorts?: (ports: ConfiguredPorts) => Promise<ConfiguredPortAvailability>;
  getLanInterfaces?: () => LanInterfaceSummary[];
  deliveryAckTimeoutMs?: number;
  onPeerUpdated?: (peer: Peer) => void;
  onPeerRemoved?: (peerId: string) => void;
  onMessageReceived?: (message: ChatMessage) => void;
}

const DIRECT_CONVERSATION_PREFIX = 'direct-';
const CHAT_CAPABILITIES = ['discovery', 'tcp-session', 'chat'];
export const DEFAULT_CHAT_ACK_TIMEOUT_MS = 5_000;

interface PendingDeliveryAcks {
  expectedPeerIds: Set<string>;
  acknowledgedPeerIds: Set<string>;
  sendCompletedPeerIds: Set<string>;
  timer: NodeJS.Timeout | null;
}

const defaultCreateDiscoveryService: DiscoveryServiceFactory = (config, events) =>
  new UdpDiscoveryService(config, events);

const defaultCreateTcpSessionManager: TcpSessionManagerFactory = (config, events) =>
  new TcpSessionManager(config, events);

const isDuplicateMessageError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('Message already exists');

const isAddressInUseError = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';

const createStartupFailureResult = (
  protocol: PortProtocol,
  port: number,
  error: unknown
): PortAvailabilityResult => ({
  protocol,
  port,
  available: false,
  code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
  message: error instanceof Error ? error.message : 'Unknown startup failure.'
});

const toDiscoveryPeerIdentity = (peer: Peer): DiscoveryPeerIdentity | null => {
  if (!peer.publicKey || !peer.roomFingerprint || !peer.capabilities) {
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

const toPeerFromSession = (session: TcpSession, fallback?: Peer): Peer => ({
  id: session.remotePeer.id,
  displayName: session.remotePeer.displayName,
  status: session.remotePeer.status,
  address: fallback?.address ?? 'unknown',
  udpPort: session.remotePeer.udpPort,
  tcpPort: session.remotePeer.tcpPort,
  publicKey: session.remotePeer.publicKey,
  roomFingerprint: session.remotePeer.roomFingerprint,
  capabilities: session.remotePeer.capabilities,
  lastSeenAt: new Date().toISOString()
});

export const createUchatAppService = (
  storage: UchatStorage,
  onNetworkEvent: (event: NetworkEvent) => void,
  options: UchatAppServiceOptions = {}
): UchatAppService => {
  const createDiscoveryService = options.createDiscoveryService ?? defaultCreateDiscoveryService;
  const createTcpSessionManager = options.createTcpSessionManager ?? defaultCreateTcpSessionManager;
  const checkConfiguredPorts = options.checkConfiguredPorts ?? checkConfiguredPortAvailability;
  const getLanInterfaces = options.getLanInterfaces ?? getUsableLanInterfaces;
  const deliveryAckTimeoutMs =
    options.deliveryAckTimeoutMs && Number.isFinite(options.deliveryAckTimeoutMs) && options.deliveryAckTimeoutMs > 0
      ? options.deliveryAckTimeoutMs
      : DEFAULT_CHAT_ACK_TIMEOUT_MS;
  let discoveryService: DiscoveryRuntime | null = null;
  let tcpSessionManager: TcpSessionRuntime | null = null;
  let activeLocalPeer: DiscoveryPeerIdentity | null = null;
  const pendingDirectAcks = new Map<string, PendingDeliveryAcks>();
  const pendingBroadcastAcks = new Map<string, PendingDeliveryAcks>();

  const recordNetworkEvent = async (
    message: string,
    level: NetworkEvent['level'] = 'info'
  ): Promise<NetworkEvent> => {
    const event = await storage.addNetworkEvent({ level, message });
    onNetworkEvent(event);
    return event;
  };

  const reconcilePersistedRuntimeState = async (): Promise<void> => {
    const state = await storage.getAppState();

    if (state.peers.length > 0) {
      await storage.clearPeers();
    }

    if (!state.room.joined) {
      return;
    }

    await storage.setRoom({
      ...state.room,
      joined: false
    });
    await recordNetworkEvent(
      'LAN networking is disconnected after restart. Re-enter the room passphrase to resume UDP discovery and TCP chat.',
      'warning'
    );
  };

  const startupReady = reconcilePersistedRuntimeState();
  void startupReady.catch(() => undefined);

  const afterStartup = async <T>(operation: () => Promise<T>): Promise<T> => {
    await startupReady;
    return operation();
  };

  const getLivePeers = async (): Promise<Peer[]> => discoveryService?.listPeers() ?? storage.listPeers();

  const getAppStateWithLivePeers = async (): Promise<UchatAppState> => {
    const state = await storage.getAppState();
    return {
      ...state,
      peers: await getLivePeers()
    };
  };

  const updateActiveLocalPeer = async (profile: LocalProfile): Promise<void> => {
    if (!activeLocalPeer) {
      return;
    }

    const nextLocalPeer = {
      ...activeLocalPeer,
      displayName: profile.displayName,
      status: profile.status
    };
    activeLocalPeer = nextLocalPeer;

    const currentDiscoveryService = discoveryService;
    if (!currentDiscoveryService) {
      return;
    }

    try {
      await currentDiscoveryService.updateLocalPeer(nextLocalPeer);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown discovery update error.';
      await recordNetworkEvent(`Failed to broadcast updated profile: ${message}`, 'warning');
    }
  };

  const stopDiscovery = async (): Promise<void> => {
    if (!discoveryService) {
      return;
    }

    const currentDiscoveryService = discoveryService;
    discoveryService = null;
    await currentDiscoveryService.stop();
  };

  const stopTcpSessions = async (): Promise<void> => {
    await failPendingDeliveries('TCP sessions stopped before delivery was acknowledged.');

    if (!tcpSessionManager) {
      return;
    }

    const currentTcpSessionManager = tcpSessionManager;
    tcpSessionManager = null;
    await currentTcpSessionManager.stop();
  };

  const detachRuntime = (): RuntimeSnapshot => {
    const snapshot = {
      discoveryService,
      tcpSessionManager,
      activeLocalPeer
    };
    discoveryService = null;
    tcpSessionManager = null;
    activeLocalPeer = null;
    return snapshot;
  };

  const stopRuntimeServices = async (runtime: RuntimeSnapshot): Promise<void> => {
    let firstError: unknown;

    for (const service of [runtime.discoveryService, runtime.tcpSessionManager]) {
      if (!service) {
        continue;
      }

      try {
        await service.stop();
      } catch (error) {
        firstError ??= error;
      }
    }

    if (firstError) {
      throw firstError;
    }
  };

  const checkRoomNetworking = async (
    ports: ConfiguredPorts,
    persistedRoom: UchatAppState['room']
  ): Promise<void> => {
    const lanInterfaces = getLanInterfaces();
    if (lanInterfaces.length === 0) {
      await recordNetworkEvent(
        'No usable LAN interface detected. Discovery may not reach other devices until WiFi or Ethernet is connected.',
        'warning'
      );
    }

    const portStatus = await checkConfiguredPorts(ports);
    const currentRuntimeOwnsPort = (protocol: PortProtocol, port: number): boolean =>
      persistedRoom.joined &&
      discoveryService !== null &&
      tcpSessionManager !== null &&
      (protocol === 'udp' ? persistedRoom.udpPort : persistedRoom.tcpPort) === port;
    const failures = [portStatus.udp, portStatus.tcp].filter(
      (result) => !result.available && !currentRuntimeOwnsPort(result.protocol, result.port)
    );

    if (failures.length === 0) {
      await recordNetworkEvent(`Port check passed for UDP ${ports.udpPort} and TCP ${ports.tcpPort}.`);
      return;
    }

    await Promise.all(failures.map((failure) => recordNetworkEvent(describePortUnavailable(failure), 'error')));
    throw new Error('Cannot join room because one or more configured ports are unavailable.');
  };

  const isSameActiveRoomPeer = (peer: Peer): boolean =>
    Boolean(
      activeLocalPeer &&
        peer.id !== activeLocalPeer.id &&
        peer.roomFingerprint === activeLocalPeer.roomFingerprint &&
        peer.capabilities?.includes('tcp-session') &&
        peer.capabilities.includes('chat') &&
        toDiscoveryPeerIdentity(peer)
    );

  const listOnlineChatPeers = async (): Promise<Peer[]> => (await getLivePeers()).filter(isSameActiveRoomPeer);

  const findOnlinePeer = async (peerId: string): Promise<Peer | null> =>
    (await listOnlineChatPeers()).find((peer) => peer.id === peerId) ?? null;

  const ensureBroadcastConversation = async (): Promise<Conversation> => {
    const existing = (await storage.listConversations()).find((conversation) => conversation.id === 'broadcast');
    if (existing) {
      return existing;
    }

    return storage.createConversation({
      id: 'broadcast',
      kind: 'broadcast',
      title: 'Broadcast room'
    });
  };

  const ensureDirectConversation = async (
    peerId: string,
    title: string
  ): Promise<Conversation> => {
    const existing = (await storage.listConversations()).find(
      (conversation) => conversation.kind === 'direct' && conversation.peerId === peerId
    );
    if (existing) {
      return existing;
    }

    return storage.createConversation({
      id: `${DIRECT_CONVERSATION_PREFIX}${peerId}`,
      kind: 'direct',
      title,
      peerId
    });
  };

  const resolveSendConversation = async (conversationId: string): Promise<Conversation> => {
    const conversations = await storage.listConversations();
    const existing = conversations.find((conversation) => conversation.id === conversationId);
    if (existing) {
      return existing;
    }

    if (conversationId.startsWith(DIRECT_CONVERSATION_PREFIX)) {
      const peerId = conversationId.slice(DIRECT_CONVERSATION_PREFIX.length);
      const peer =
        (await getLivePeers()).find((current) => current.id === peerId) ??
        (await storage.listPeers()).find((current) => current.id === peerId);

      return ensureDirectConversation(peerId, peer?.displayName ?? peerId);
    }

    throw new Error(`Conversation not found: ${conversationId}`);
  };

  const updateDeliveryState = async (
    messageId: string,
    deliveryState: ChatMessage['deliveryState'],
    recordFailure = true
  ): Promise<ChatMessage | null> => {
    try {
      return await storage.updateMessageDeliveryState({ messageId, deliveryState });
    } catch (error) {
      if (!recordFailure) {
        return null;
      }

      const message = error instanceof Error ? error.message : 'Unknown delivery state error.';
      await recordNetworkEvent(`Failed to update message delivery state: ${message}`, 'warning');
      return null;
    }
  };

  const findPendingDelivery = (
    messageId: string
  ): { pending: PendingDeliveryAcks; map: Map<string, PendingDeliveryAcks> } | null => {
    const direct = pendingDirectAcks.get(messageId);
    if (direct) {
      return { pending: direct, map: pendingDirectAcks };
    }

    const broadcast = pendingBroadcastAcks.get(messageId);
    return broadcast ? { pending: broadcast, map: pendingBroadcastAcks } : null;
  };

  const removePendingDelivery = (
    messageId: string,
    expectedPending?: PendingDeliveryAcks
  ): PendingDeliveryAcks | null => {
    const pending = findPendingDelivery(messageId);
    if (!pending || (expectedPending && pending.pending !== expectedPending)) {
      return null;
    }

    pending.map.delete(messageId);
    if (pending.pending.timer) {
      clearTimeout(pending.pending.timer);
      pending.pending.timer = null;
    }
    return pending.pending;
  };

  const markFailed = async (messageId: string, reason: string): Promise<void> => {
    const failed = await updateDeliveryState(messageId, 'failed', false);
    if (failed) {
      options.onMessageReceived?.(failed);
    }
    await recordNetworkEvent(reason, 'warning');
  };

  const failPendingDelivery = async (
    messageId: string,
    pending: PendingDeliveryAcks,
    reason: string
  ): Promise<void> => {
    if (!removePendingDelivery(messageId, pending)) {
      return;
    }

    await markFailed(messageId, reason);
  };

  const startDeliveryAckTimeout = (messageId: string, pending: PendingDeliveryAcks): void => {
    if (pending.timer) {
      return;
    }

    pending.timer = setTimeout(() => {
      void failPendingDelivery(
        messageId,
        pending,
        `Message ${messageId} failed because delivery was not acknowledged within ${deliveryAckTimeoutMs}ms.`
      );
    }, deliveryAckTimeoutMs);
  };

  const completePendingDelivery = async (messageId: string, pending: PendingDeliveryAcks): Promise<void> => {
    const active = findPendingDelivery(messageId);
    if (
      !active ||
      active.pending !== pending ||
      pending.acknowledgedPeerIds.size !== pending.expectedPeerIds.size ||
      pending.sendCompletedPeerIds.size !== pending.expectedPeerIds.size
    ) {
      return;
    }

    removePendingDelivery(messageId, pending);
    await markAcknowledged(messageId);
  };

  const failPendingDeliveries = async (reason: string): Promise<void> => {
    const pendingEntries = [
      ...Array.from(pendingDirectAcks.entries()),
      ...Array.from(pendingBroadcastAcks.entries())
    ];

    for (const [messageId, pending] of pendingEntries) {
      await failPendingDelivery(messageId, pending, `Message ${messageId} failed. ${reason}`);
    }
  };

  const restoreRuntime = async (runtime: RuntimeSnapshot): Promise<unknown | null> => {
    try {
      if (runtime.tcpSessionManager) {
        await runtime.tcpSessionManager.start();
      }

      if (runtime.discoveryService) {
        await runtime.discoveryService.start();
      }

      tcpSessionManager = runtime.tcpSessionManager;
      discoveryService = runtime.discoveryService;
      activeLocalPeer = runtime.activeLocalPeer;
      return null;
    } catch (error) {
      try {
        await stopRuntimeServices(runtime);
      } catch {
        // Preserve the original startup error. The runtime stays detached if
        // cleanup of the failed restore also fails.
      }

      tcpSessionManager = null;
      discoveryService = null;
      activeLocalPeer = null;
      return error;
    }
  };

  const findStoredMessageConversation = async (
    messageId: string
  ): Promise<{ message: ChatMessage; conversation: Conversation } | null> => {
    const message = (await storage.listMessages()).find((current) => current.id === messageId);
    if (!message) {
      return null;
    }

    const conversation = (await storage.listConversations()).find(
      (current) => current.id === message.conversationId
    );

    return conversation ? { message, conversation } : null;
  };

  const markAcknowledged = async (messageId: string): Promise<ChatMessage | null> => {
    let updated = await updateDeliveryState(messageId, 'delivered', false);

    if (!updated) {
      const sent = await updateDeliveryState(messageId, 'sent', false);
      updated = sent ? await updateDeliveryState(messageId, 'delivered', false) : null;
    }

    if (updated) {
      options.onMessageReceived?.(updated);
      return updated;
    }

    await recordNetworkEvent(`Failed to apply chat acknowledgement for message ${messageId}.`, 'warning');
    return null;
  };

  const getOrConnectSession = async (peer: Peer): Promise<TcpSession> => {
    if (!tcpSessionManager) {
      throw new Error('TCP session manager is not running. Join a room before sending messages.');
    }

    const existing = tcpSessionManager.listSessions().find((session) => session.remotePeer.id === peer.id);
    if (existing) {
      return existing;
    }

    const identity = toDiscoveryPeerIdentity(peer);
    if (!identity) {
      throw new Error(`Peer ${peer.displayName} is missing TCP identity material.`);
    }

    return tcpSessionManager.connectToPeer({
      peer: identity,
      address: peer.address,
      port: peer.tcpPort
    });
  };

  const sendChatMessageToPeer = async (
    peer: Peer,
    message: ChatMessage,
    scope: 'broadcast' | 'direct'
  ): Promise<void> => {
    const session = await getOrConnectSession(peer);
    const frame = createChatMessageFrame({
      messageId: message.id,
      body: message.body,
      scope
    });
    await session.sendEncrypted(CHAT_MESSAGE_CONTENT_TYPE, serializeChatFrame(frame));
  };

  const handleInboundChatMessage = async (message: TcpEncryptedMessage): Promise<void> => {
    const validation = validateChatMessageFrame(message.payload);
    if (!validation.ok) {
      await recordNetworkEvent(`Ignored invalid chat.message frame: ${validation.reason}.`, 'warning');
      return;
    }

    const remotePeer =
      (await storage.listPeers()).find((peer) => peer.id === message.session.remotePeer.id) ??
      toPeerFromSession(message.session);
    const conversation =
      validation.frame.scope === 'broadcast'
        ? await ensureBroadcastConversation()
        : await ensureDirectConversation(message.session.remotePeer.id, message.session.remotePeer.displayName);
    let savedMessage: ChatMessage | null = null;

    const savedPeer = await storage.upsertPeer(toPeerFromSession(message.session, remotePeer));
    options.onPeerUpdated?.(savedPeer);

    try {
      savedMessage = await storage.createMessage({
        id: validation.frame.messageId,
        conversationId: conversation.id,
        body: validation.frame.body,
        author: 'peer',
        deliveryState: 'delivered',
        createdAt: validation.frame.sentAt
      });
    } catch (error) {
      if (!isDuplicateMessageError(error)) {
        throw error;
      }

      savedMessage =
        (await storage.listMessages(conversation.id)).find((current) => current.id === validation.frame.messageId) ??
        null;
    }

    if (savedMessage) {
      options.onMessageReceived?.(savedMessage);
    }

    await message.session.sendEncrypted(
      CHAT_ACK_CONTENT_TYPE,
      serializeChatFrame(createChatAckFrame(validation.frame.messageId))
    );
  };

  const handleInboundChatAck = async (message: TcpEncryptedMessage): Promise<void> => {
    const validation = validateChatAckFrame(message.payload);
    if (!validation.ok) {
      await recordNetworkEvent(`Ignored invalid chat.ack frame: ${validation.reason}.`, 'warning');
      return;
    }

    const pendingDelivery = findPendingDelivery(validation.frame.messageId);
    if (!pendingDelivery) {
      await recordNetworkEvent(
        `Ignored chat acknowledgement for ${validation.frame.messageId} because no delivery is pending.`,
        'warning'
      );
      return;
    }

    const remotePeerId = message.session.remotePeer.id;
    if (!pendingDelivery.pending.expectedPeerIds.has(remotePeerId)) {
      await recordNetworkEvent(
        `Ignored chat acknowledgement for ${validation.frame.messageId} from unexpected peer ${remotePeerId}.`,
        'warning'
      );
      return;
    }

    pendingDelivery.pending.acknowledgedPeerIds.add(remotePeerId);
    await completePendingDelivery(validation.frame.messageId, pendingDelivery.pending);
  };

  const handleEncryptedMessage = async (message: TcpEncryptedMessage): Promise<void> => {
    try {
      if (message.contentType === CHAT_MESSAGE_CONTENT_TYPE) {
        await handleInboundChatMessage(message);
        return;
      }

      if (message.contentType === CHAT_ACK_CONTENT_TYPE) {
        await handleInboundChatAck(message);
        return;
      }

      await recordNetworkEvent(`Ignored unsupported encrypted TCP content type: ${message.contentType}.`, 'warning');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown chat delivery error.';
      await recordNetworkEvent(`Failed to handle encrypted chat frame: ${errorMessage}`, 'error');
    }
  };

  return {
    getAppState: () => afterStartup(getAppStateWithLivePeers),

    async setProfile(input) {
      const normalizedInput = parseSetProfileInput(input);
      return afterStartup(async () => {
        const profile = await storage.setProfile(normalizedInput);
        await updateActiveLocalPeer(profile);
        await recordNetworkEvent(`Profile set to ${profile.displayName}.`);
        return profile;
      });
    },

    async joinRoom(input) {
      const normalizedInput = parseJoinRoomInput(input);
      return afterStartup(async () => {
        const roomName = normalizedInput.roomName;
        const udpPort = normalizedInput.udpPort ?? DEFAULT_DISCOVERY_PORT;
        const tcpPort = normalizedInput.tcpPort ?? DEFAULT_TCP_PORT;
        const state = await storage.getAppState();

        // Validate candidate ports while the current room is still running.
        // A listener owned by that current room is safe to reuse during a
        // replacement; other unavailable ports must fail before teardown.
        await checkRoomNetworking({ udpPort, tcpPort }, state.room);

        const [roomKey, identity] = await Promise.all([
          deriveRoomKey(roomName, normalizedInput.passphrase),
          Promise.resolve(generateX25519Identity())
        ]);
        const localPeer = createLocalDiscoveryPeer({
          id: identity.publicKey,
          displayName: state.profile.displayName,
          status: state.profile.status,
          roomFingerprint: roomKey.fingerprint,
          publicKey: identity.publicKey,
          udpPort,
          tcpPort,
          capabilities: CHAT_CAPABILITIES
        });

        const nextTcpSessionManager = createTcpSessionManager(
          {
            peer: localPeer,
            privateKey: identity.privateKey,
            roomKey: roomKey.key,
            tcpPort
          },
          {
            onEncryptedMessage: (message) => {
              void handleEncryptedMessage(message);
            },
            onSessionError: (error) => {
              void recordNetworkEvent(`TCP session error: ${error.message}`, 'warning');
            }
          }
        );
        const nextDiscoveryService = createDiscoveryService(
          {
            localPeer,
            udpPort
          },
          {
            onPeerUpdated: (peer) => {
              void storage
                .upsertPeer(peer)
                .then((savedPeer) => {
                  options.onPeerUpdated?.(savedPeer);
                })
                .catch((error: unknown) => {
                  const message = error instanceof Error ? error.message : 'Unknown peer persistence error.';
                  void recordNetworkEvent(`Failed to persist discovered peer: ${message}`, 'error');
                });
            },
            onPeerRemoved: (peerId) => {
              options.onPeerRemoved?.(peerId);
              void storage.removePeer(peerId).catch((error: unknown) => {
                const message = error instanceof Error ? error.message : 'Unknown peer removal persistence error.';
                void recordNetworkEvent(`Failed to remove departed peer: ${message}`, 'error');
              });
            },
            onNetworkEvent: (message, level) => {
              void recordNetworkEvent(message, level);
            }
          }
        );

        const previousRuntime: RuntimeSnapshot = {
          discoveryService,
          tcpSessionManager,
          activeLocalPeer
        };
        let startupPhase: 'stopping' | 'tcp' | 'udp' | 'persisting' | 'ready' = 'stopping';

        try {
          detachRuntime();
          await stopRuntimeServices(previousRuntime);

          startupPhase = 'tcp';
          await nextTcpSessionManager.start();
          startupPhase = 'udp';
          await nextDiscoveryService.start();

          startupPhase = 'persisting';
          await storage.setRoom({
            roomName,
            joined: true,
            udpPort,
            tcpPort
          });

          tcpSessionManager = nextTcpSessionManager;
          discoveryService = nextDiscoveryService;
          activeLocalPeer = localPeer;
          startupPhase = 'ready';

          await failPendingDeliveries('TCP sessions stopped before delivery was acknowledged.');
          await recordNetworkEvent(`Room "${roomName}" joined. UDP discovery and TCP listener started.`);
          return getAppStateWithLivePeers();
        } catch (error) {
          try {
            await stopRuntimeServices({
              discoveryService: nextDiscoveryService,
              tcpSessionManager: nextTcpSessionManager,
              activeLocalPeer: null
            });
          } catch (cleanupError) {
            const message = cleanupError instanceof Error ? cleanupError.message : 'Unknown runtime cleanup error.';
            await recordNetworkEvent(`Failed to clean up the replacement room runtime: ${message}`, 'warning');
          }

          tcpSessionManager = null;
          discoveryService = null;
          activeLocalPeer = null;

          const restoreError = await restoreRuntime(previousRuntime);
          const persistedRoom = restoreError && state.room.joined ? { ...state.room, joined: false } : state.room;
          try {
            await storage.setRoom(persistedRoom);
          } catch (storageError) {
            const storageMessage =
              storageError instanceof Error ? storageError.message : 'Unknown room-state restoration error.';
            await recordNetworkEvent(`Failed to restore persisted room state: ${storageMessage}`, 'error');
          }

          if (restoreError) {
            const message = restoreError instanceof Error ? restoreError.message : 'Unknown runtime restore error.';
            await recordNetworkEvent(`Failed to restore the previous room runtime: ${message}`, 'error');
          }

          const message = error instanceof Error ? error.message : 'Unknown room startup error.';
          if (startupPhase === 'tcp') {
            await recordNetworkEvent(
              isAddressInUseError(error)
                ? describePortUnavailable(createStartupFailureResult('tcp', tcpPort, error))
                : `Failed to start TCP listener on ${tcpPort}: ${message}`,
              'error'
            );
          } else if (startupPhase === 'udp') {
            await recordNetworkEvent(
              isAddressInUseError(error)
                ? describePortUnavailable(createStartupFailureResult('udp', udpPort, error))
                : `Failed to start UDP discovery on ${udpPort}: ${message}`,
              'error'
            );
          } else {
            await recordNetworkEvent(`Failed to join room "${roomName}": ${message}`, 'error');
          }

          throw error;
        }
      });
    },

    listPeers: () => afterStartup(getLivePeers),

    listConversations: () => afterStartup(() => storage.listConversations()),

    async sendMessage(input) {
      const normalizedInput = parseSendMessageInput(input);
      return afterStartup(async () => {
        const body = normalizedInput.body;

        const conversation = await resolveSendConversation(normalizedInput.conversationId);
        const message = await storage.createMessage({
          conversationId: conversation.id,
          body,
          author: 'local',
          deliveryState: 'sending'
        });

        if (conversation.kind === 'broadcast') {
          const peers = await listOnlineChatPeers();
          if (peers.length === 0) {
            const unsent = await updateDeliveryState(message.id, 'unsent');
            await recordNetworkEvent(
              'Broadcast message saved as unsent because no same-room peers are online.',
              'warning'
            );
            return unsent ?? message;
          }

          pendingBroadcastAcks.set(message.id, {
            expectedPeerIds: new Set(peers.map((peer) => peer.id)),
            acknowledgedPeerIds: new Set(),
            sendCompletedPeerIds: new Set(),
            timer: null
          });

          const deliveries = await Promise.allSettled(
            peers.map((peer) => sendChatMessageToPeer(peer, message, 'broadcast'))
          );
          const deliveredCount = deliveries.filter((delivery) => delivery.status === 'fulfilled').length;

          if (deliveredCount === 0) {
            removePendingDelivery(message.id);
            const failed = await updateDeliveryState(message.id, 'failed');
            await recordNetworkEvent('Broadcast message failed for all online peers.', 'error');
            return failed ?? message;
          }

          if (deliveredCount < peers.length) {
            removePendingDelivery(message.id);
            const failed = await updateDeliveryState(message.id, 'failed');
            await recordNetworkEvent(
              `Broadcast message only reached ${deliveredCount}/${peers.length} online peers; full delivery is not guaranteed.`,
              'error'
            );
            return failed ?? message;
          }

          const sent = await updateDeliveryState(message.id, 'sent');
          const pending = pendingBroadcastAcks.get(message.id);
          if (pending) {
            for (const peer of peers) {
              pending.sendCompletedPeerIds.add(peer.id);
            }
            startDeliveryAckTimeout(message.id, pending);
            await completePendingDelivery(message.id, pending);
          }

          const current = await findStoredMessageConversation(message.id);
          await recordNetworkEvent(`Broadcast message sent to ${deliveredCount}/${peers.length} online peers.`);
          return current?.message ?? sent ?? message;
        }

        if (!conversation.peerId) {
          const failed = await updateDeliveryState(message.id, 'failed');
          await recordNetworkEvent('Direct message conversation is missing a peer id.', 'error');
          return failed ?? message;
        }

        const peer = await findOnlinePeer(conversation.peerId);
        if (!peer) {
          const unsent = await updateDeliveryState(message.id, 'unsent');
          await recordNetworkEvent('Direct message saved as unsent because the peer is offline.', 'warning');
          return unsent ?? message;
        }

        const pendingDirect: PendingDeliveryAcks = {
          expectedPeerIds: new Set([peer.id]),
          acknowledgedPeerIds: new Set(),
          sendCompletedPeerIds: new Set(),
          timer: null
        };
        pendingDirectAcks.set(message.id, pendingDirect);

        try {
          await sendChatMessageToPeer(peer, message, 'direct');
        } catch (error) {
          removePendingDelivery(message.id, pendingDirect);
          const failed = await updateDeliveryState(message.id, 'failed');
          const errorMessage = error instanceof Error ? error.message : 'Unknown TCP send error.';
          await recordNetworkEvent(`Failed to send direct message to ${peer.displayName}: ${errorMessage}`, 'error');
          return failed ?? message;
        }

        const sent = await updateDeliveryState(message.id, 'sent');
        const pending = pendingDirectAcks.get(message.id);
        if (pending) {
          pending.sendCompletedPeerIds.add(peer.id);
          startDeliveryAckTimeout(message.id, pending);
          await completePendingDelivery(message.id, pending);
        }

        const current = await findStoredMessageConversation(message.id);
        await recordNetworkEvent(`Direct message sent to ${peer.displayName}.`);
        return current?.message ?? sent ?? message;
      });
    },

    async cleanup() {
      await afterStartup(async () => {
        await stopDiscovery();
        await stopTcpSessions();
        activeLocalPeer = null;
        await storage.close();
      });
    }
  };
};
