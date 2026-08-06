export type PresenceStatus = 'available' | 'away' | 'busy';

export type ConversationKind = 'broadcast' | 'direct';

export type MessageDeliveryState = 'sending' | 'sent' | 'delivered' | 'failed' | 'unsent';

export interface LocalProfile {
  displayName: string;
  status: PresenceStatus;
}

export interface Peer {
  id: string;
  displayName: string;
  status: PresenceStatus;
  address: string;
  udpPort: number;
  tcpPort: number;
  publicKey?: string;
  roomFingerprint?: string;
  capabilities?: string[];
  lastSeenAt: string;
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string;
  peerId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  body: string;
  author: 'local' | 'peer';
  deliveryState: MessageDeliveryState;
  createdAt: string;
}

export interface NetworkEvent {
  id: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  createdAt: string;
}

export interface RoomState {
  roomName: string | null;
  joined: boolean;
  udpPort: number;
  tcpPort: number;
}

export interface AppSettings {
  profile: LocalProfile;
  room: RoomState;
}

export interface CreateConversationInput {
  id?: string;
  kind: ConversationKind;
  title: string;
  peerId?: string;
}

export interface CreateMessageInput {
  id?: string;
  conversationId: string;
  body: string;
  author: ChatMessage['author'];
  deliveryState?: MessageDeliveryState;
  createdAt?: string;
}

export interface UpdateMessageDeliveryStateInput {
  messageId: string;
  deliveryState: MessageDeliveryState;
}

export interface UchatAppState {
  appName: 'Uchat';
  profile: LocalProfile;
  room: RoomState;
  peers: Peer[];
  conversations: Conversation[];
  messages: ChatMessage[];
  networkEvents: NetworkEvent[];
}

export interface SetProfileInput {
  displayName: string;
  status: PresenceStatus;
}

export interface JoinRoomInput {
  roomName: string;
  passphrase: string;
  udpPort?: number;
  tcpPort?: number;
}

export interface SendMessageInput {
  conversationId: string;
  body: string;
}

export interface UchatAPI {
  getAppState(): Promise<UchatAppState>;
  setProfile(input: SetProfileInput): Promise<LocalProfile>;
  joinRoom(input: JoinRoomInput): Promise<UchatAppState>;
  listPeers(): Promise<Peer[]>;
  listConversations(): Promise<Conversation[]>;
  sendMessage(input: SendMessageInput): Promise<ChatMessage>;
  onPeerUpdated(callback: (peer: Peer) => void): () => void;
  onPeerRemoved(callback: (peerId: string) => void): () => void;
  onMessageReceived(callback: (message: ChatMessage) => void): () => void;
  onNetworkEvent(callback: (event: NetworkEvent) => void): () => void;
}
