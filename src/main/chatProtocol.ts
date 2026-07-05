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
      reason: 'invalid-json' | 'invalid-shape';
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown, maxLength = 8192): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;

const isValidSentAt = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

const parsePayload = (payload: Uint8Array | string): { ok: true; value: unknown } | { ok: false } => {
  try {
    const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

export const createChatMessageFrame = (
  input: Omit<ChatMessageFrame, 'type' | 'sentAt'> & { sentAt?: string }
): ChatMessageFrame => ({
  type: CHAT_MESSAGE_CONTENT_TYPE,
  messageId: input.messageId,
  body: input.body,
  scope: input.scope,
  sentAt: input.sentAt ?? new Date().toISOString()
});

export const createChatAckFrame = (
  messageId: string,
  receivedAt = new Date().toISOString()
): ChatAckFrame => ({
  type: CHAT_ACK_CONTENT_TYPE,
  messageId,
  receivedAt
});

export const serializeChatFrame = (frame: ChatMessageFrame | ChatAckFrame): Buffer =>
  Buffer.from(JSON.stringify(frame));

export const validateChatMessageFrame = (
  payload: Uint8Array | string
): ChatFrameValidation<ChatMessageFrame> => {
  const parsed = parsePayload(payload);
  if (!parsed.ok) {
    return { ok: false, reason: 'invalid-json' };
  }

  if (!isRecord(parsed.value)) {
    return { ok: false, reason: 'invalid-shape' };
  }

  if (
    parsed.value.type !== CHAT_MESSAGE_CONTENT_TYPE ||
    !isNonEmptyString(parsed.value.messageId, 128) ||
    !isNonEmptyString(parsed.value.body) ||
    (parsed.value.scope !== 'broadcast' && parsed.value.scope !== 'direct') ||
    !isValidSentAt(parsed.value.sentAt)
  ) {
    return { ok: false, reason: 'invalid-shape' };
  }

  return {
    ok: true,
    frame: {
      type: CHAT_MESSAGE_CONTENT_TYPE,
      messageId: parsed.value.messageId,
      body: parsed.value.body,
      scope: parsed.value.scope,
      sentAt: parsed.value.sentAt
    }
  };
};

export const validateChatAckFrame = (payload: Uint8Array | string): ChatFrameValidation<ChatAckFrame> => {
  const parsed = parsePayload(payload);
  if (!parsed.ok) {
    return { ok: false, reason: 'invalid-json' };
  }

  if (!isRecord(parsed.value)) {
    return { ok: false, reason: 'invalid-shape' };
  }

  if (
    parsed.value.type !== CHAT_ACK_CONTENT_TYPE ||
    !isNonEmptyString(parsed.value.messageId, 128) ||
    !isValidSentAt(parsed.value.receivedAt)
  ) {
    return { ok: false, reason: 'invalid-shape' };
  }

  return {
    ok: true,
    frame: {
      type: CHAT_ACK_CONTENT_TYPE,
      messageId: parsed.value.messageId,
      receivedAt: parsed.value.receivedAt
    }
  };
};
