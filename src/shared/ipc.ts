export const UCHAT_IPC = {
  getAppState: 'uchat:get-app-state',
  setProfile: 'uchat:set-profile',
  joinRoom: 'uchat:join-room',
  listPeers: 'uchat:list-peers',
  listConversations: 'uchat:list-conversations',
  sendMessage: 'uchat:send-message',
  retryMessage: 'uchat:retry-message',
  peerUpdated: 'uchat:peer-updated',
  peerRemoved: 'uchat:peer-removed',
  messageReceived: 'uchat:message-received',
  networkEvent: 'uchat:network-event'
} as const;

export type UchatIpcChannel = (typeof UCHAT_IPC)[keyof typeof UCHAT_IPC];
