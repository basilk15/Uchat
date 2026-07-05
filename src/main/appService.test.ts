import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Peer } from '@shared/types';
import {
  createUchatAppService,
  type DiscoveryRuntime,
  type DiscoveryServiceFactory
} from './appService';
import type { UdpDiscoveryServiceConfig, UdpDiscoveryServiceEvents } from './discovery';
import { createJsonFileStorage } from './storage/jsonFileStorage';

class FakeDiscoveryRuntime implements DiscoveryRuntime {
  readonly peers = new Map<string, Peer>();
  startCalls = 0;
  stopCalls = 0;

  constructor(
    readonly config: UdpDiscoveryServiceConfig,
    private readonly events: UdpDiscoveryServiceEvents
  ) {}

  start(): Promise<void> {
    this.startCalls += 1;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopCalls += 1;
    return Promise.resolve();
  }

  listPeers(): Peer[] {
    return Array.from(this.peers.values());
  }

  emitPeerUpdated(peer: Peer): void {
    this.peers.set(peer.id, peer);
    this.events.onPeerUpdated?.(peer);
  }
}

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const createHarness = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uchat-app-service-'));
  const storage = createJsonFileStorage(join(directory, 'storage.json'));
  const networkEvents: string[] = [];
  const peerEvents: Peer[] = [];
  const discoveryRuntimes: FakeDiscoveryRuntime[] = [];
  const createDiscoveryService: DiscoveryServiceFactory = (config, events) => {
    const runtime = new FakeDiscoveryRuntime(config, events);
    discoveryRuntimes.push(runtime);
    return runtime;
  };
  const service = createUchatAppService(
    storage,
    (event) => {
      networkEvents.push(event.message);
    },
    {
      createDiscoveryService,
      onPeerUpdated: (peer) => peerEvents.push(peer)
    }
  );

  return {
    service,
    storage,
    networkEvents,
    peerEvents,
    discoveryRuntimes
  };
};

describe('createUchatAppService discovery integration', () => {
  it('derives room identity and starts discovery when joining a room', async () => {
    const { service, storage, discoveryRuntimes, networkEvents } = await createHarness();

    await service.setProfile({ displayName: 'Alice', status: 'away' });
    const state = await service.joinRoom({
      roomName: ' Team Room ',
      passphrase: 'correct horse battery staple',
      udpPort: 48_888,
      tcpPort: 48_889
    });

    expect(discoveryRuntimes).toHaveLength(1);
    expect(discoveryRuntimes[0].startCalls).toBe(1);
    expect(discoveryRuntimes[0].config.udpPort).toBe(48_888);
    expect(discoveryRuntimes[0].config.localPeer).toEqual(
      expect.objectContaining({
        displayName: 'Alice',
        status: 'away',
        udpPort: 48_888,
        tcpPort: 48_889,
        capabilities: ['discovery']
      })
    );
    expect(discoveryRuntimes[0].config.localPeer.id).toBe(discoveryRuntimes[0].config.localPeer.publicKey);
    expect(discoveryRuntimes[0].config.localPeer.publicKey.length).toBeGreaterThan(0);
    expect(discoveryRuntimes[0].config.localPeer.roomFingerprint.length).toBeGreaterThan(0);
    expect(state.room).toEqual({
      roomName: 'Team Room',
      joined: true,
      udpPort: 48_888,
      tcpPort: 48_889
    });
    expect(JSON.stringify(await storage.getAppState())).not.toContain('correct horse battery staple');
    expect(networkEvents.at(-1)).toBe('Room "Team Room" joined. UDP discovery started on 48888.');

    await service.cleanup();
  });

  it('restarts discovery on subsequent room joins', async () => {
    const { service, discoveryRuntimes } = await createHarness();

    await service.joinRoom({ roomName: 'First', passphrase: 'one' });
    await service.joinRoom({ roomName: 'Second', passphrase: 'two', udpPort: 49_000 });

    expect(discoveryRuntimes).toHaveLength(2);
    expect(discoveryRuntimes[0].stopCalls).toBe(1);
    expect(discoveryRuntimes[1].startCalls).toBe(1);
    expect(discoveryRuntimes[1].config.udpPort).toBe(49_000);

    await service.cleanup();
  });

  it('reflects live discovery peers in app state and peer callbacks', async () => {
    const { service, storage, peerEvents, discoveryRuntimes } = await createHarness();
    const peer: Peer = {
      id: 'peer-a',
      displayName: 'Peer A',
      status: 'available',
      address: '192.168.1.25',
      udpPort: 47475,
      tcpPort: 47476,
      lastSeenAt: '2026-07-05T12:00:00.000Z'
    };

    await service.joinRoom({ roomName: 'Room', passphrase: 'secret' });
    discoveryRuntimes[0].emitPeerUpdated(peer);
    await nextTick();

    await expect(service.listPeers()).resolves.toEqual([peer]);
    await expect(service.getAppState()).resolves.toEqual(expect.objectContaining({ peers: [peer] }));
    await expect(storage.listPeers()).resolves.toEqual([peer]);
    expect(peerEvents).toEqual([peer]);

    await service.cleanup();
  });
});
