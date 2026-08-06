import { describe, expect, it } from 'vitest';
import {
  CHAT_MESSAGE_CONTENT_TYPE,
  createChatMessageFrame,
  serializeChatFrame,
  validateChatMessageFrame
} from './chatProtocol';
import { VALIDATION_LIMITS } from '@shared/validation';

describe('chat protocol runtime validation', () => {
  it('rejects malformed payload types and JSON', () => {
    expect(validateChatMessageFrame(42)).toEqual({ ok: false, reason: 'invalid-shape' });
    expect(validateChatMessageFrame('{not json')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(validateChatMessageFrame(JSON.stringify({ type: CHAT_MESSAGE_CONTENT_TYPE }))).toEqual({
      ok: false,
      reason: 'invalid-shape'
    });
  });

  it('rejects oversized message bodies before persistence or transmission', () => {
    const validation = validateChatMessageFrame({
      type: CHAT_MESSAGE_CONTENT_TYPE,
      messageId: 'message-1',
      body: 'x'.repeat(VALIDATION_LIMITS.messageBody + 1),
      scope: 'direct',
      sentAt: '2026-07-05T10:00:00.000Z'
    });

    expect(validation).toEqual({ ok: false, reason: 'invalid-shape' });
    expect(() =>
      createChatMessageFrame({
        messageId: 'message-1',
        body: 'x'.repeat(VALIDATION_LIMITS.messageBody + 1),
        scope: 'direct'
      })
    ).toThrow('Invalid chat frame: invalid-shape');
  });

  it('normalizes a valid frame and serializes only validated data', () => {
    const frame = createChatMessageFrame({
      messageId: ' message-1 ',
      body: ' hello from the LAN ',
      scope: 'broadcast',
      sentAt: '2026-07-05T10:00:00.000Z'
    });

    expect(frame).toEqual({
      type: CHAT_MESSAGE_CONTENT_TYPE,
      messageId: 'message-1',
      body: 'hello from the LAN',
      scope: 'broadcast',
      sentAt: '2026-07-05T10:00:00.000Z'
    });
    expect(JSON.parse(serializeChatFrame(frame).toString('utf8'))).toEqual(frame);
  });

  it('rejects protocol payloads larger than the JSON envelope limit', () => {
    const validation = validateChatMessageFrame(JSON.stringify({ body: 'x'.repeat(70_000) }));

    expect(validation).toEqual({ ok: false, reason: 'payload-too-large' });
  });
});
