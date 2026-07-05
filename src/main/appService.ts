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
import type { UchatStorage } from './storage/types';

export interface UchatAppService {
  getAppState(): Promise<UchatAppState>;
  setProfile(input: SetProfileInput): Promise<LocalProfile>;
  joinRoom(input: JoinRoomInput): Promise<UchatAppState>;
  listPeers(): Promise<Peer[]>;
  listConversations(): Promise<UchatAppState['conversations']>;
  sendMessage(input: SendMessageInput): Promise<ChatMessage>;
}

export const createUchatAppService = (
  storage: UchatStorage,
  onNetworkEvent: (event: NetworkEvent) => void
): UchatAppService => {
  const recordNetworkEvent = async (
    message: string,
    level: NetworkEvent['level'] = 'info'
  ): Promise<NetworkEvent> => {
    const event = await storage.addNetworkEvent({ level, message });
    onNetworkEvent(event);
    return event;
  };

  return {
    getAppState: () => storage.getAppState(),

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
      await storage.setRoom({
        roomName,
        joined: true,
        udpPort: input.udpPort ?? DEFAULT_DISCOVERY_PORT,
        tcpPort: input.tcpPort ?? DEFAULT_TCP_PORT
      });
      await recordNetworkEvent(`Room "${roomName}" joined locally. LAN networking starts in a later part.`);
      return storage.getAppState();
    },

    listPeers: () => storage.listPeers(),

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
    }
  };
};
