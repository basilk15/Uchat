import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveRoomKey, generateX25519Identity } from '../security/crypto';
import type { DiscoveryPeerIdentity } from '@shared/discovery';
import type * as Net from 'node:net';

class SilentSocket extends EventEmitter {
  destroyed = false;

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

const sockets: SilentSocket[] = [];

vi.mock('node:net', async () => {
  const actual = await vi.importActual<typeof Net>('node:net');
  return {
    ...actual,
    connect: vi.fn(() => {
      const socket = new SilentSocket();
      sockets.push(socket);
      return socket;
    })
  };
});

const { TcpSessionManager } = await import('./session');

const createPeer = (id: string, publicKey: string, roomFingerprint: string): DiscoveryPeerIdentity => ({
  id,
  displayName: id,
  status: 'available',
  udpPort: 47_475,
  tcpPort: 47_476,
  publicKey,
  roomFingerprint,
  capabilities: ['tcp-session']
});

describe('TcpSessionManager connect timeout', () => {
  afterEach(() => {
    sockets.splice(0);
  });

  it('rejects and destroys a socket when TCP connection establishment is silent', async () => {
    const room = await deriveRoomKey('Lab', 'correct horse battery staple');
    const localIdentity = generateX25519Identity();
    const remoteIdentity = generateX25519Identity();
    const manager = new TcpSessionManager({
      peer: createPeer('alice', localIdentity.publicKey, room.fingerprint),
      privateKey: localIdentity.privateKey,
      roomKey: room.key,
      host: '127.0.0.1',
      tcpPort: 47_476,
      connectTimeoutMs: 10
    });

    await expect(
      manager.connectToPeer({
        peer: createPeer('bob', remoteIdentity.publicKey, room.fingerprint),
        address: '127.0.0.1',
        timeoutMs: 10
      })
    ).rejects.toMatchObject({
      code: 'connect-timeout'
    });
    expect(sockets).toHaveLength(1);
    expect(sockets[0].destroyed).toBe(true);
  });
});
