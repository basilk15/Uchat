import { DEFAULT_DISCOVERY_PORT, DEFAULT_TCP_PORT } from '@shared/defaults';
import type {
  ChatMessage,
  JoinRoomInput,
  LocalProfile,
  NetworkEvent,
  Peer,
  SendMessageInput,
  SetProfileInput,
  UchatAppState
} from '@shared/types';
import {
  createLocalDiscoveryPeer,
  UdpDiscoveryService,
  type UdpDiscoveryServiceConfig,
  type UdpDiscoveryServiceEvents
} from './discovery';
import { deriveRoomKey, generateX25519Identity } from './security/crypto';
import type { UchatStorage } from './storage/types';

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

export type DiscoveryServiceFactory = (
  config: UdpDiscoveryServiceConfig,
  events: UdpDiscoveryServiceEvents
) => DiscoveryRuntime;

export interface UchatAppServiceOptions {
  createDiscoveryService?: DiscoveryServiceFactory;
  onPeerUpdated?: (peer: Peer) => void;
}

const defaultCreateDiscoveryService: DiscoveryServiceFactory = (config, events) =>
  new UdpDiscoveryService(config, events);

export const createUchatAppService = (
  storage: UchatStorage,
  onNetworkEvent: (event: NetworkEvent) => void,
  options: UchatAppServiceOptions = {}
): UchatAppService => {
  const createDiscoveryService = options.createDiscoveryService ?? defaultCreateDiscoveryService;
  let discoveryService: DiscoveryRuntime | null = null;

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
        capabilities: ['discovery']
      });
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
      await storage.setRoom({
        roomName,
        joined: true,
        udpPort,
        tcpPort
      });

      discoveryService = nextDiscoveryService;

      try {
        await discoveryService.start();
      } catch (error) {
        discoveryService = null;
        const message = error instanceof Error ? error.message : 'Unknown UDP discovery startup error.';
        await recordNetworkEvent(`Failed to start UDP discovery: ${message}`, 'error');
        throw error;
      }

      await recordNetworkEvent(`Room "${roomName}" joined. UDP discovery started on ${udpPort}.`);
      return getAppStateWithLivePeers();
    },

    listPeers: getLivePeers,

    listConversations: () => storage.listConversations(),

    async sendMessage(input) {
      const body = input.body.trim();
      const message = await storage.createMessage({
        conversationId: input.conversationId,
        body,
        author: 'local',
        deliveryState: 'unsent'
      });

      await recordNetworkEvent('Message saved locally as unsent. Delivery transport is not implemented yet.', 'warning');
      return message;
    },

    async cleanup() {
      await stopDiscovery();
      await storage.close();
    }
  };
};
