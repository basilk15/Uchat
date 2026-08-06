import type {
  ChatMessage,
  CreateConversationInput,
  CreateMessageInput,
  LocalProfile,
  NetworkEvent,
  Peer,
  RoomState,
  SetProfileInput,
  UchatAppState,
  UpdateMessageDeliveryStateInput
} from '@shared/types';

export interface AddNetworkEventInput {
  level?: NetworkEvent['level'];
  message: string;
}

export interface UchatStorage {
  getAppState(): Promise<UchatAppState>;
  setProfile(input: SetProfileInput): Promise<LocalProfile>;
  setRoom(input: RoomState): Promise<RoomState>;
  listPeers(): Promise<Peer[]>;
  upsertPeer(peer: Peer): Promise<Peer>;
  removePeer(peerId: string): Promise<boolean>;
  clearPeers(): Promise<void>;
  listConversations(): Promise<UchatAppState['conversations']>;
  createConversation(input: CreateConversationInput): Promise<UchatAppState['conversations'][number]>;
  listMessages(conversationId?: string): Promise<ChatMessage[]>;
  createMessage(input: CreateMessageInput): Promise<ChatMessage>;
  updateMessageDeliveryState(input: UpdateMessageDeliveryStateInput): Promise<ChatMessage>;
  addNetworkEvent(input: AddNetworkEventInput): Promise<NetworkEvent>;
  close(): Promise<void>;
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}
