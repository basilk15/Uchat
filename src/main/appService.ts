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
  listPeers(): Peer[];
}

export interface TcpSessionRuntime {
  start(): Promise<number>;
  stop(): Promise<void>;
  connectToPeer(options: TcpConnectOptions): Promise<TcpSession>;
  listSessions(): TcpSession[];
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
  onPeerUpdated?: (peer: Peer) => void;
  onMessageReceived?: (message: ChatMessage) => void;
}

const DIRECT_CONVERSATION_PREFIX = 'direct-';
const CHAT_CAPABILITIES = ['discovery', 'tcp-session', 'chat'];

const defaultCreateDiscoveryService: DiscoveryServiceFactory = (config, events) =>
  new UdpDiscoveryService(config, events);

const defaultCreateTcpSessionManager: TcpSessionManagerFactory = (config, events) =>
  new TcpSessionManager(config, events);

const isDuplicateMessageError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('Message already exists');

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
  let discoveryService: DiscoveryRuntime | null = null;
  let tcpSessionManager: TcpSessionRuntime | null = null;
  let activeLocalPeer: DiscoveryPeerIdentity | null = null;

  const recordNetworkEvent = async (
    message: string,
    level: NetworkEvent['level'] = 'info'
  ): Promise<NetworkEvent> => {
    const event = await storage.addNetworkEvent({ level, message });
    onNetworkEvent(event);
    return event;
  };

  const getLivePeers = async (): Promise<Peer[]> => discoveryService?.listPeers() ?? storage.listPeers();

  const getAppStateWithLivePeers = async (): Promise<UchatAppState> => {
    const state = await storage.getAppState();
    return {
      ...state,
      peers: await getLivePeers()
    };
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
    if (!tcpSessionManager) {
      return;
    }

    const currentTcpSessionManager = tcpSessionManager;
    tcpSessionManager = null;
    await currentTcpSessionManager.stop();
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

  const markAcknowledged = async (messageId: string): Promise<void> => {
    let updated = await updateDeliveryState(messageId, 'delivered', false);

    if (!updated) {
      const sent = await updateDeliveryState(messageId, 'sent', false);
      updated = sent ? await updateDeliveryState(messageId, 'delivered', false) : null;
    }

    if (updated) {
      options.onMessageReceived?.(updated);
      return;
    }

    await recordNetworkEvent(`Failed to apply chat acknowledgement for message ${messageId}.`, 'warning');
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

    await markAcknowledged(validation.frame.messageId);
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
    getAppState: getAppStateWithLivePeers,

    async setProfile(input) {
      const profile = await storage.setProfile({
        displayName: input.displayName.trim() || 'Uchat user',
        status: input.status
      });
      await recordNetworkEvent(`Profile set to ${profile.displayName}.`);
      return profile;
    },

    async joinRoom(input) {
      const roomName = input.roomName.trim() || 'Local room';
      const udpPort = input.udpPort ?? DEFAULT_DISCOVERY_PORT;
      const tcpPort = input.tcpPort ?? DEFAULT_TCP_PORT;
      const [state, roomKey, identity] = await Promise.all([
        storage.getAppState(),
        deriveRoomKey(roomName, input.passphrase),
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
          onNetworkEvent: (message, level) => {
            void recordNetworkEvent(message, level);
          }
        }
      );

      await stopDiscovery();
      await stopTcpSessions();
      await storage.setRoom({
        roomName,
        joined: true,
        udpPort,
        tcpPort
      });

      activeLocalPeer = localPeer;
      tcpSessionManager = nextTcpSessionManager;
      discoveryService = nextDiscoveryService;

      try {
        await tcpSessionManager.start();
      } catch (error) {
        tcpSessionManager = null;
        activeLocalPeer = null;
        const message = error instanceof Error ? error.message : 'Unknown TCP startup error.';
        await recordNetworkEvent(`Failed to start TCP listener: ${message}`, 'error');
        throw error;
      }

      try {
        await discoveryService.start();
      } catch (error) {
        discoveryService = null;
        await stopTcpSessions();
        activeLocalPeer = null;
        const message = error instanceof Error ? error.message : 'Unknown UDP discovery startup error.';
        await recordNetworkEvent(`Failed to start UDP discovery: ${message}`, 'error');
        throw error;
      }

      await recordNetworkEvent(`Room "${roomName}" joined. UDP discovery and TCP listener started.`);
      return getAppStateWithLivePeers();
    },

    listPeers: getLivePeers,

    listConversations: () => storage.listConversations(),

    async sendMessage(input) {
      const body = input.body.trim();
      if (!body) {
        throw new Error('Message body cannot be empty.');
      }

      const conversation = await resolveSendConversation(input.conversationId);
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
          await recordNetworkEvent('Broadcast message saved as unsent because no same-room peers are online.', 'warning');
          return unsent ?? message;
        }

        const deliveries = await Promise.allSettled(
          peers.map((peer) => sendChatMessageToPeer(peer, message, 'broadcast'))
        );
        const deliveredCount = deliveries.filter((delivery) => delivery.status === 'fulfilled').length;

        if (deliveredCount === 0) {
          const failed = await updateDeliveryState(message.id, 'failed');
          await recordNetworkEvent('Broadcast message failed for all online peers.', 'error');
          return failed ?? message;
        }

        const sent = await updateDeliveryState(message.id, 'sent');
        await recordNetworkEvent(`Broadcast message sent to ${deliveredCount}/${peers.length} online peers.`);
        return sent ?? message;
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

      try {
        await sendChatMessageToPeer(peer, message, 'direct');
      } catch (error) {
        const failed = await updateDeliveryState(message.id, 'failed');
        const errorMessage = error instanceof Error ? error.message : 'Unknown TCP send error.';
        await recordNetworkEvent(`Failed to send direct message to ${peer.displayName}: ${errorMessage}`, 'error');
        return failed ?? message;
      }

      const sent = await updateDeliveryState(message.id, 'sent');
      await recordNetworkEvent(`Direct message sent to ${peer.displayName}.`);
      return sent ?? message;
    },

    async cleanup() {
      await stopDiscovery();
      await stopTcpSessions();
      activeLocalPeer = null;
      await storage.close();
    }
  };
};
