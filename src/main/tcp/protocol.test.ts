import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encryptFrame } from '../security/crypto';
import type { DiscoveryPeerIdentity } from '@shared/discovery';
import {
  createEncryptedSessionEnvelope,
  createSessionErrorMessage,
  createSessionHelloMessage,
  createSessionReadyMessage,
  validateEncryptedSessionEnvelope,
  validateTcpSessionControlMessage
} from './protocol';

const peer: DiscoveryPeerIdentity = {
  id: 'peer-a',
  displayName: 'Peer A',
  status: 'available',
  udpPort: 47475,
  tcpPort: 47476,
  publicKey: 'test-public-key',
  roomFingerprint: 'room-fingerprint-a',
  capabilities: ['tcp-session']
};

describe('TCP session protocol validation', () => {
  it('accepts session.hello messages for the expected room fingerprint', () => {
    const message = createSessionHelloMessage(peer, '2026-07-05T10:00:00.000Z');
    const validation = validateTcpSessionControlMessage(JSON.stringify(message), peer.roomFingerprint);

    expect(validation.ok).toBe(true);
    expect(validation.ok ? validation.message.type : null).toBe('session.hello');
  });

  it('rejects session.hello messages from another room fingerprint', () => {
    const validation = validateTcpSessionControlMessage(createSessionHelloMessage(peer), 'different-room');

    expect(validation).toEqual({ ok: false, reason: 'room-fingerprint-mismatch' });
  });

  it('validates session.ready and session.error messages', () => {
    const ready = validateTcpSessionControlMessage(createSessionReadyMessage('peer-a'));
    const error = validateTcpSessionControlMessage(createSessionErrorMessage('room-mismatch', 'Room mismatch.'));

    expect(ready.ok ? ready.message.type : null).toBe('session.ready');
    expect(error.ok ? error.message.type : null).toBe('session.error');
  });

  it('rejects unsupported session control message types', () => {
    const validation = validateTcpSessionControlMessage({
      ...createSessionReadyMessage('peer-a'),
      type: 'chat.message'
    });

    expect(validation).toEqual({ ok: false, reason: 'unsupported-type' });
  });

  it('validates encrypted transport envelopes separately from control messages', () => {
    const frame = encryptFrame(Buffer.alloc(32, 1), 'secret payload', 'test.payload');
    const envelope = createEncryptedSessionEnvelope('test.payload', frame, '2026-07-05T10:00:00.000Z');
    const validation = validateEncryptedSessionEnvelope(JSON.stringify(envelope));

    expect(validation.ok).toBe(true);
    expect(validation.ok ? validation.envelope.contentType : null).toBe('test.payload');
    expect(validateTcpSessionControlMessage(envelope)).toEqual({ ok: false, reason: 'unsupported-type' });
  });
});
