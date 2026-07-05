import { describe, expect, it } from 'vitest';
import {
  decryptFrame,
  derivePeerSessionKey,
  deriveRoomKey,
  encryptFrame,
  generateX25519Identity
} from './crypto';

const createSessionPair = async () => {
  const room = await deriveRoomKey('Workshop', 'correct horse battery staple');
  const alice = generateX25519Identity();
  const bob = generateX25519Identity();

  const aliceSessionKey = derivePeerSessionKey({
    roomKey: room.key,
    privateKey: alice.privateKey,
    localPublicKey: alice.publicKey,
    remotePublicKey: bob.publicKey
  });

  const bobSessionKey = derivePeerSessionKey({
    roomKey: room.key,
    privateKey: bob.privateKey,
    localPublicKey: bob.publicKey,
    remotePublicKey: alice.publicKey
  });

  return {
    room,
    alice,
    bob,
    aliceSessionKey,
    bobSessionKey
  };
};

describe('Part 4 crypto and room identity', () => {
  it('encrypts and decrypts a frame with the derived session key', async () => {
    const { aliceSessionKey, bobSessionKey } = await createSessionPair();
    const frame = encryptFrame(aliceSessionKey, 'hello over the LAN', 'chat.message');

    const decrypted = decryptFrame(bobSessionKey, frame, 'chat.message');

    expect(decrypted.toString('utf8')).toBe('hello over the LAN');
  });

  it('rejects decrypt with the wrong session key', async () => {
    const { alice, bob, aliceSessionKey } = await createSessionPair();
    const wrongRoom = await deriveRoomKey('Workshop', 'not the passphrase');
    const wrongSessionKey = derivePeerSessionKey({
      roomKey: wrongRoom.key,
      privateKey: bob.privateKey,
      localPublicKey: bob.publicKey,
      remotePublicKey: alice.publicKey
    });
    const frame = encryptFrame(aliceSessionKey, 'this should stay private');

    expect(() => decryptFrame(wrongSessionKey, frame)).toThrow();
  });

  it('derives matching peer session keys from opposite X25519 identities', async () => {
    const { aliceSessionKey, bobSessionKey } = await createSessionPair();

    expect(aliceSessionKey.equals(bobSessionKey)).toBe(true);
    expect(aliceSessionKey.byteLength).toBe(32);
  });

  it('produces a different room fingerprint for the wrong passphrase', async () => {
    const correctRoom = await deriveRoomKey('Workshop', 'correct horse battery staple');
    const wrongRoom = await deriveRoomKey('Workshop', 'not the passphrase');

    expect(correctRoom.fingerprint).not.toBe(wrongRoom.fingerprint);
  });
});
