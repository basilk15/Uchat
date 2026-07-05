import { afterEach, describe, expect, it } from 'vitest';
import { deriveRoomKey, generateX25519Identity, type DerivedRoomKey, type X25519Identity } from '../security/crypto';
import type { DiscoveryPeerIdentity } from '@shared/discovery';
import {
  TcpSessionError,
  TcpSessionManager,
  type TcpEncryptedMessage,
  type TcpSession,
  type TcpSessionErrorEvent
} from './session';

interface TestPeer {
  identity: X25519Identity;
  peer: DiscoveryPeerIdentity;
}

const managers: TcpSessionManager[] = [];

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
};

const createPeer = (id: string, room: DerivedRoomKey): TestPeer => {
  const identity = generateX25519Identity();

  return {
    identity,
    peer: {
      id,
      displayName: id,
      status: 'available',
      udpPort: 47475,
      tcpPort: 47476,
      publicKey: identity.publicKey,
      roomFingerprint: room.fingerprint,
      capabilities: ['tcp-session']
    }
  };
};

const createManager = (
  local: TestPeer,
  room: DerivedRoomKey,
  events = {},
  tcpPort = 0
): TcpSessionManager => {
  const manager = new TcpSessionManager(
    {
      peer: local.peer,
      privateKey: local.identity.privateKey,
      roomKey: room.key,
      host: '127.0.0.1',
      tcpPort,
      handshakeTimeoutMs: 1_000
    },
    events
  );
  managers.push(manager);
  return manager;
};

const waitForServerSession = (manager: TcpSessionManager): Promise<TcpSession> =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const [session] = manager.listSessions();
      if (session) {
        clearInterval(timer);
        resolve(session);
        return;
      }

      if (Date.now() - startedAt > 1_000) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for server TCP session.'));
      }
    }, 10);
  });

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
});

describe('TcpSessionManager', () => {
  it('establishes a TCP session handshake on loopback using an ephemeral server port', async () => {
    const room = await deriveRoomKey('Lab', 'correct horse battery staple');
    const alice = createPeer('alice', room);
    const bob = createPeer('bob', room);
    const serverReady = deferred<TcpSession>();
    const bobManager = createManager(bob, room, {
      onSessionReady: serverReady.resolve
    });

    const bobPort = await bobManager.start();
    bob.peer.tcpPort = bobPort;

    const aliceManager = createManager(alice, room);
    const aliceSession = await aliceManager.connectToPeer({
      peer: bob.peer,
      address: '127.0.0.1',
      port: bobPort
    });
    const bobSession = await serverReady.promise;

    expect(aliceSession.remotePeer.id).toBe('bob');
    expect(bobSession.remotePeer.id).toBe('alice');
    expect(aliceManager.listSessions()).toHaveLength(1);
    expect(bobManager.listSessions()).toHaveLength(1);
  });

  it('rejects a handshake when the room fingerprint does not match', async () => {
    const room = await deriveRoomKey('Lab', 'correct horse battery staple');
    const wrongRoom = await deriveRoomKey('Lab', 'wrong passphrase');
    const alice = createPeer('alice', wrongRoom);
    const bob = createPeer('bob', room);
    const serverErrors: TcpSessionErrorEvent[] = [];
    const bobManager = createManager(bob, room, {
      onSessionError: (error: TcpSessionErrorEvent) => serverErrors.push(error)
    });

    const bobPort = await bobManager.start();
    bob.peer.tcpPort = bobPort;

    const aliceManager = createManager(alice, wrongRoom);

    await expect(
      aliceManager.connectToPeer({
        peer: bob.peer,
        address: '127.0.0.1',
        port: bobPort,
        timeoutMs: 1_000
      })
    ).rejects.toBeInstanceOf(TcpSessionError);
    expect(serverErrors).toContainEqual(
      expect.objectContaining({
        code: 'invalid-session-message'
      })
    );
  });

  it('sends and receives encrypted payloads in both directions after handshake', async () => {
    const room = await deriveRoomKey('Lab', 'correct horse battery staple');
    const alice = createPeer('alice', room);
    const bob = createPeer('bob', room);
    const aliceMessage = deferred<TcpEncryptedMessage>();
    const bobMessage = deferred<TcpEncryptedMessage>();
    const bobManager = createManager(bob, room, {
      onEncryptedMessage: bobMessage.resolve
    });

    const bobPort = await bobManager.start();
    bob.peer.tcpPort = bobPort;

    const aliceManager = createManager(alice, room, {
      onEncryptedMessage: aliceMessage.resolve
    });
    const aliceSession = await aliceManager.connectToPeer({
      peer: bob.peer,
      address: '127.0.0.1',
      port: bobPort
    });
    const bobSession = await waitForServerSession(bobManager);

    await aliceSession.sendEncrypted('test.payload', 'hello bob');
    const receivedByBob = await bobMessage.promise;

    expect(receivedByBob.contentType).toBe('test.payload');
    expect(receivedByBob.payload.toString('utf8')).toBe('hello bob');

    await bobSession.sendEncrypted('test.reply', 'hello alice');
    const receivedByAlice = await aliceMessage.promise;

    expect(receivedByAlice.contentType).toBe('test.reply');
    expect(receivedByAlice.payload.toString('utf8')).toBe('hello alice');
  });
});
