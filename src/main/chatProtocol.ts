import {
  isRecord,
  normalizeText,
  normalizeTimestamp,
  parseJsonPayload,
  VALIDATION_LIMITS,
  ValidationError
} from '@shared/validation';

export const CHAT_MESSAGE_CONTENT_TYPE = 'chat.message';
export const CHAT_ACK_CONTENT_TYPE = 'chat.ack';

export interface ChatMessageFrame {
  type: typeof CHAT_MESSAGE_CONTENT_TYPE;
  messageId: string;
  body: string;
  scope: 'broadcast' | 'direct';
  sentAt: string;
}

export interface ChatAckFrame {
  type: typeof CHAT_ACK_CONTENT_TYPE;
  messageId: string;
  receivedAt: string;
}

export type ChatFrameValidation<T> =
  | {
      ok: true;
      frame: T;
    }
  | {
      ok: false;
      reason: 'invalid-json' | 'payload-too-large' | 'invalid-shape';
    };

const validationError = (reason: 'invalid-json' | 'payload-too-large' | 'invalid-shape'): ValidationError =>
  new ValidationError(`Invalid chat frame: ${reason}.`);

export const createChatMessageFrame = (
  input: Omit<ChatMessageFrame, 'type' | 'sentAt'> & { sentAt?: string }
): ChatMessageFrame => {
  if (!isRecord(input)) {
    throw new ValidationError('Invalid chat frame input: expected an object.');
  }

  const validation = validateChatMessageFrame({
    type: CHAT_MESSAGE_CONTENT_TYPE,
    messageId: input.messageId,
    body: input.body,
    scope: input.scope,
    sentAt: input.sentAt ?? new Date().toISOString()
  });

  if (!validation.ok) {
    throw validationError(validation.reason);
  }

  return validation.frame;
};

export const createChatAckFrame = (
  messageId: string,
  receivedAt = new Date().toISOString()
): ChatAckFrame => {
  const validation = validateChatAckFrame({
    type: CHAT_ACK_CONTENT_TYPE,
    messageId,
    receivedAt
  });

  if (!validation.ok) {
    throw validationError(validation.reason);
  }

  return validation.frame;
};

export const serializeChatFrame = (frame: ChatMessageFrame | ChatAckFrame): Buffer => {
  if (!isRecord(frame)) {
    throw validationError('invalid-shape');
  }

  const validation =
    frame.type === CHAT_MESSAGE_CONTENT_TYPE ? validateChatMessageFrame(frame) : validateChatAckFrame(frame);

  if (!validation.ok) {
    throw validationError(validation.reason);
  }

  return Buffer.from(JSON.stringify(validation.frame));
};

export const validateChatMessageFrame = (
  payload: unknown
): ChatFrameValidation<ChatMessageFrame> => {
  const parsed = parseJsonPayload(payload, VALIDATION_LIMITS.protocolPayloadBytes);
  if (!parsed.ok) {
    return parsed;
  }

  if (!isRecord(parsed.value)) {
    return { ok: false, reason: 'invalid-shape' };
  }

  if (parsed.value.type !== CHAT_MESSAGE_CONTENT_TYPE) {
    return { ok: false, reason: 'invalid-shape' };
  }

  try {
    if (parsed.value.scope !== 'broadcast' && parsed.value.scope !== 'direct') {
      return { ok: false, reason: 'invalid-shape' };
    }

    return {
      ok: true,
      frame: {
        type: CHAT_MESSAGE_CONTENT_TYPE,
        messageId: normalizeText(parsed.value.messageId, 'messageId', VALIDATION_LIMITS.identifier),
        body: normalizeText(parsed.value.body, 'body', VALIDATION_LIMITS.messageBody),
        scope: parsed.value.scope,
        sentAt: normalizeTimestamp(parsed.value.sentAt, 'sentAt')
      }
    };
  } catch {
    return { ok: false, reason: 'invalid-shape' };
  }
};

export const validateChatAckFrame = (payload: unknown): ChatFrameValidation<ChatAckFrame> => {
  const parsed = parseJsonPayload(payload, VALIDATION_LIMITS.protocolPayloadBytes);
  if (!parsed.ok) {
    return parsed;
  }

  if (!isRecord(parsed.value)) {
    return { ok: false, reason: 'invalid-shape' };
  }

  if (parsed.value.type !== CHAT_ACK_CONTENT_TYPE) {
    return { ok: false, reason: 'invalid-shape' };
  }

  try {
    return {
      ok: true,
      frame: {
        type: CHAT_ACK_CONTENT_TYPE,
        messageId: normalizeText(parsed.value.messageId, 'messageId', VALIDATION_LIMITS.identifier),
        receivedAt: normalizeTimestamp(parsed.value.receivedAt, 'receivedAt')
      }
    };
  } catch {
    return { ok: false, reason: 'invalid-shape' };
  }
};
