import type { RemoteInfo } from 'node:dgram';
import { describe, expect, it } from 'vitest';
import { createDiscoveryPacket, type DiscoveryPeerIdentity } from '@shared/discovery';
import { DiscoveryPeerRegistry } from './discovery';

const remoteInfo: RemoteInfo = {
  address: '192.168.1.20',
  family: 'IPv4',
  port: 47475,
  size: 0
};

const peer: DiscoveryPeerIdentity = {
  id: 'peer-a',
  displayName: 'Peer A',
  status: 'available',
  udpPort: 47475,
  tcpPort: 47476,
  publicKey: 'test-public-key',
  roomFingerprint: 'room-fingerprint-a',
  capabilities: []
};

describe('DiscoveryPeerRegistry', () => {
  it('tracks peers from hello and heartbeat packets', () => {
    const registry = new DiscoveryPeerRegistry(15_000);

    registry.upsert(createDiscoveryPacket('peer.hello', peer), remoteInfo, 1_000);
    registry.upsert(
      createDiscoveryPacket('peer.heartbeat', {
        ...peer,
        displayName: 'Peer A Updated',
        status: 'away'
      }),
      remoteInfo,
      2_000
    );

    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: 'peer-a',
        displayName: 'Peer A Updated',
        status: 'away',
        address: '192.168.1.20',
        lastSeenAt: '1970-01-01T00:00:02.000Z'
      })
    ]);
  });

  it('removes peers when goodbye packets arrive', () => {
    const registry = new DiscoveryPeerRegistry(15_000);

    registry.upsert(createDiscoveryPacket('peer.hello', peer), remoteInfo, 1_000);
    const goodbyePeer = registry.upsert(createDiscoveryPacket('peer.goodbye', peer), remoteInfo, 2_000);

    expect(goodbyePeer).toBeNull();
    expect(registry.list()).toEqual([]);
  });

  it('prunes stale peers after the timeout window', () => {
    const registry = new DiscoveryPeerRegistry(5_000);

    registry.upsert(createDiscoveryPacket('peer.hello', peer), remoteInfo, 1_000);

    expect(registry.pruneStale(5_999)).toEqual([]);
    expect(registry.list()).toHaveLength(1);

    const stalePeers = registry.pruneStale(6_000);

    expect(stalePeers).toEqual([expect.objectContaining({ id: 'peer-a' })]);
    expect(registry.list()).toEqual([]);
  });
});
