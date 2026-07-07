import type { NetworkEvent, UchatAppState } from './types';

export const DEFAULT_DISCOVERY_PORT = 47475;
export const DEFAULT_TCP_PORT = 47476;

let eventCounter = 0;

export const createNetworkEvent = (message: string, level: NetworkEvent['level'] = 'info'): NetworkEvent => ({
  id: `stub-event-${++eventCounter}`,
  level,
  message,
  createdAt: new Date().toISOString()
});

export const createInitialAppState = (): UchatAppState => {
  const createdAt = new Date().toISOString();

  return {
    appName: 'Uchat',
    profile: {
      displayName: 'Basil',
      status: 'available'
    },
    room: {
      roomName: null,
      joined: false,
      udpPort: DEFAULT_DISCOVERY_PORT,
      tcpPort: DEFAULT_TCP_PORT
    },
    peers: [],
    conversations: [
      {
        id: 'broadcast',
        kind: 'broadcast',
        title: 'Broadcast room',
        createdAt,
        updatedAt: createdAt
      }
    ],
    messages: [],
    networkEvents: [
      {
        id: 'stub-event-0',
        level: 'info',
        message: 'Uchat is ready. Join a room to start LAN discovery and messaging.',
        createdAt
      }
    ]
  };
};
