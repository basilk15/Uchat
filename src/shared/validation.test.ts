import { describe, expect, it } from 'vitest';
import {
  MAX_PORT,
  MIN_PORT,
  VALIDATION_LIMITS,
  ValidationError,
  parseCreateMessageInput,
  parseJoinRoomInput,
  parseNetworkEventInput,
  parsePeerMessageInput,
  parseSendMessageInput,
  parseSetProfileInput
} from './validation';

describe('runtime input validation', () => {
  it('rejects malformed IPC payloads and status-like values', () => {
    expect(() => parseSetProfileInput(null)).toThrow('expected an object');
    expect(() => parseSetProfileInput({ displayName: 42, status: 'available' })).toThrow(
      'displayName must be a string'
    );
    expect(() => parseSetProfileInput({ displayName: 'Ada', status: 'offline' })).toThrow(
      'status must be one of: available, away, busy'
    );
    expect(() => parseJoinRoomInput({ roomName: [], passphrase: 'secret' })).toThrow(
      'roomName must be a string'
    );
    expect(() => parseJoinRoomInput({ roomName: 'Lab', passphrase: null })).toThrow(
      'passphrase must be a string'
    );
    expect(() => parseSendMessageInput({ conversationId: 'broadcast', body: { text: 'nope' } })).toThrow(
      'body must be a string'
    );
    expect(() => parseNetworkEventInput({ message: 'network', level: 'debug' })).toThrow(
      'level must be one of: info, warning, error'
    );
    expect(() => parsePeerMessageInput({ body: 12 })).toThrow('body must be a string');
    expect(() => parsePeerMessageInput({ body: 'hello', unexpected: true })).toThrow(
      'unexpected is not a supported field'
    );
  });

  it('normalizes valid text and accepts exact limits and port edges', () => {
    expect(
      parseSetProfileInput({ displayName: '  Ada Lovelace  ', status: 'away' })
    ).toEqual({ displayName: 'Ada Lovelace', status: 'away' });

    expect(
      parseJoinRoomInput({
        roomName: '  Lab  ',
        passphrase: ' secret with spaces ',
        udpPort: MIN_PORT,
        tcpPort: MAX_PORT
      })
    ).toEqual({
      roomName: 'Lab',
      passphrase: ' secret with spaces ',
      udpPort: MIN_PORT,
      tcpPort: MAX_PORT
    });

    expect(
      parseSendMessageInput({
        conversationId: ' broadcast ',
        body: ` ${'x'.repeat(VALIDATION_LIMITS.messageBody)} `
      })
    ).toEqual({
      conversationId: 'broadcast',
      body: 'x'.repeat(VALIDATION_LIMITS.messageBody)
    });

    expect(parsePeerMessageInput({ body: ' hello ', targetPeerId: ' peer-a ' })).toEqual({
      body: 'hello',
      targetPeerId: 'peer-a'
    });
  });

  it('rejects oversized text and invalid port representations', () => {
    expect(() =>
      parseSetProfileInput({
        displayName: 'x'.repeat(VALIDATION_LIMITS.displayName + 1),
        status: 'available'
      })
    ).toThrow('displayName must be at most 80 characters');
    expect(() =>
      parseJoinRoomInput({
        roomName: 'x'.repeat(VALIDATION_LIMITS.roomName + 1),
        passphrase: 'secret'
      })
    ).toThrow('roomName must be at most 80 characters');
    expect(() =>
      parseJoinRoomInput({
        roomName: 'Lab',
        passphrase: 'x'.repeat(VALIDATION_LIMITS.passphrase + 1)
      })
    ).toThrow('passphrase must be at most 256 characters');
    expect(() =>
      parseSendMessageInput({
        conversationId: 'broadcast',
        body: 'x'.repeat(VALIDATION_LIMITS.messageBody + 1)
      })
    ).toThrow('body must be at most 8192 characters');

    for (const port of [0, MAX_PORT + 1, 47475.5, '47475', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseJoinRoomInput({ roomName: 'Lab', passphrase: 'secret', udpPort: port })).toThrow(
        ValidationError
      );
    }
  });

  it('rejects invalid persisted message fields before storage can write them', () => {
    expect(() =>
      parseCreateMessageInput({
        conversationId: 'broadcast',
        body: 'hello',
        author: 'system',
        deliveryState: 'sending'
      })
    ).toThrow('author must be one of: local, peer');
  });
});
