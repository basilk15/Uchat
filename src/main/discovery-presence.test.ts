import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryPeerIdentity } from '@shared/discovery';

interface MockDiscoverySocket {
  sentPackets: Buffer[];
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  bind: ReturnType<typeof vi.fn>;
  setBroadcast: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const mockState = vi.hoisted(() => ({ sockets: [] as MockDiscoverySocket[] }));

vi.mock('node:dgram', () => ({
  createSocket: vi.fn(() => {
    const socket = {
      sentPackets: [] as Buffer[],
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      bind: vi.fn((_port: number, callback: () => void) => callback()),
      setBroadcast: vi.fn(),
      send: vi.fn(
        (
          packet: Uint8Array,
          _port: number,
          _address: string,
          callback: (error: Error | null) => void
        ) => {
          socket.sentPackets.push(Buffer.from(packet));
          callback(null);
        }
      ),
      close: vi.fn((callback: () => void) => callback())
    } satisfies MockDiscoverySocket;

    mockState.sockets.push(socket);
    return socket;
  })
}));

import { DEFAULT_HEARTBEAT_INTERVAL_MS, UdpDiscoveryService } from './discovery';

const localPeer: DiscoveryPeerIdentity = {
  id: 'local-peer',
  displayName: 'Before',
  status: 'available',
  udpPort: 47_475,
  tcpPort: 47_476,
  publicKey: 'local-public-key',
  roomFingerprint: 'room-fingerprint',
  capabilities: ['discovery', 'tcp-session', 'chat']
};

describe('UdpDiscoveryService local presence updates', () => {
  afterEach(() => {
    vi.useRealTimers();
    mockState.sockets.length = 0;
  });

  it('announces an updated identity immediately and uses it for heartbeats', async () => {
    vi.useFakeTimers();
    const service = new UdpDiscoveryService({
      localPeer,
      udpPort: localPeer.udpPort,
      heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      broadcastAddress: '127.0.0.1'
    });

    await service.start();
    const socket = mockState.sockets[0];
    socket.sentPackets.length = 0;

    await service.updateLocalPeer({
      ...localPeer,
      displayName: 'After',
      status: 'busy'
    });

    const hello = JSON.parse(socket.sentPackets[0].toString('utf8')) as {
      type: string;
      peer: DiscoveryPeerIdentity;
    };
    expect(hello.type).toBe('peer.hello');
    expect(hello.peer).toEqual({
      ...localPeer,
      displayName: 'After',
      status: 'busy'
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS);
    const heartbeat = JSON.parse(socket.sentPackets[1].toString('utf8')) as {
      type: string;
      peer: DiscoveryPeerIdentity;
    };
    expect(heartbeat.type).toBe('peer.heartbeat');
    expect(heartbeat.peer.displayName).toBe('After');
    expect(heartbeat.peer.status).toBe('busy');

    await service.stop();
  });
});
