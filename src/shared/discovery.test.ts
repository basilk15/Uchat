import { describe, expect, it } from 'vitest';
import { createDiscoveryPacket, validateDiscoveryPacket, type DiscoveryPeerIdentity } from './discovery';

const peer: DiscoveryPeerIdentity = {
  id: 'peer-a',
  displayName: 'Peer A',
  status: 'available',
  udpPort: 47475,
  tcpPort: 47476,
  publicKey: 'test-public-key',
  roomFingerprint: 'room-fingerprint-a',
  capabilities: ['chat']
};

describe('discovery packet validation', () => {
  it('accepts supported discovery packets for the expected room', () => {
    const packet = createDiscoveryPacket('peer.hello', peer, '2026-07-05T10:00:00.000Z');
    const validation = validateDiscoveryPacket(JSON.stringify(packet), peer.roomFingerprint);

    expect(validation.ok).toBe(true);
    expect(validation.ok ? validation.packet.type : null).toBe('peer.hello');
  });

  it('rejects malformed JSON', () => {
    const validation = validateDiscoveryPacket('{bad json');

    expect(validation).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('rejects unsupported protocol versions', () => {
    const packet = {
      ...createDiscoveryPacket('peer.heartbeat', peer),
      protocolVersion: 99
    };
    const validation = validateDiscoveryPacket(packet);

    expect(validation).toEqual({ ok: false, reason: 'unsupported-version' });
  });

  it('rejects peers from another room fingerprint', () => {
    const packet = createDiscoveryPacket('peer.heartbeat', peer);
    const validation = validateDiscoveryPacket(packet, 'different-room-fingerprint');

    expect(validation).toEqual({ ok: false, reason: 'room-fingerprint-mismatch' });
  });

  it('rejects invalid peer ports', () => {
    const packet = createDiscoveryPacket('peer.hello', {
      ...peer,
      tcpPort: 70_000
    });
    const validation = validateDiscoveryPacket(packet);

    expect(validation).toEqual({ ok: false, reason: 'invalid-peer' });
  });
});
