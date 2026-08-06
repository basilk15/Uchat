import type { EncryptedFrame } from '../security/crypto';
import {
  isBoundedString,
  isRecord,
  isValidTimestamp,
  parseDiscoveryPeerIdentity,
  parseJsonPayload,
  VALIDATION_LIMITS,
  ValidationError
} from '@shared/validation';
import type { DiscoveryPeerIdentity } from '@shared/discovery';

export const TCP_SESSION_APP_ID = 'uchat';
export const TCP_SESSION_PROTOCOL_VERSION = 1;

export const TCP_SESSION_MESSAGE_TYPES = ['session.hello', 'session.ready', 'session.error'] as const;

export type TcpSessionMessageType = (typeof TCP_SESSION_MESSAGE_TYPES)[number];

export interface SessionHelloMessage {
  app: typeof TCP_SESSION_APP_ID;
  protocolVersion: typeof TCP_SESSION_PROTOCOL_VERSION;
  type: 'session.hello';
  peer: DiscoveryPeerIdentity;
  sentAt: string;
}

export interface SessionReadyMessage {
  app: typeof TCP_SESSION_APP_ID;
  protocolVersion: typeof TCP_SESSION_PROTOCOL_VERSION;
  type: 'session.ready';
  peerId: string;
  sentAt: string;
}

export interface SessionErrorMessage {
  app: typeof TCP_SESSION_APP_ID;
  protocolVersion: typeof TCP_SESSION_PROTOCOL_VERSION;
  type: 'session.error';
  code: string;
  message: string;
  sentAt: string;
}

export type TcpSessionControlMessage = SessionHelloMessage | SessionReadyMessage | SessionErrorMessage;

export interface EncryptedSessionEnvelope {
  app: typeof TCP_SESSION_APP_ID;
  protocolVersion: typeof TCP_SESSION_PROTOCOL_VERSION;
  encrypted: true;
  contentType: string;
  frame: EncryptedFrame;
  sentAt: string;
}

export type TcpSessionControlValidation =
  | {
      ok: true;
      message: TcpSessionControlMessage;
    }
  | {
      ok: false;
      reason:
        | 'invalid-json'
        | 'payload-too-large'
        | 'invalid-shape'
        | 'unsupported-app'
        | 'unsupported-version'
        | 'unsupported-type'
        | 'invalid-peer'
        | 'room-fingerprint-mismatch'
        | 'invalid-ready'
        | 'invalid-error';
    };

export type EncryptedSessionEnvelopeValidation =
  | {
      ok: true;
      envelope: EncryptedSessionEnvelope;
    }
  | {
      ok: false;
      reason:
        | 'invalid-json'
        | 'payload-too-large'
        | 'invalid-shape'
        | 'unsupported-app'
        | 'unsupported-version'
        | 'not-encrypted-envelope'
        | 'invalid-content-type'
        | 'invalid-encrypted-frame';
    };

const isSessionMessageType = (value: unknown): value is TcpSessionMessageType =>
  typeof value === 'string' && TCP_SESSION_MESSAGE_TYPES.includes(value as TcpSessionMessageType);

const validateEncryptedFrame = (value: unknown): EncryptedFrame | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.algorithm !== 'aes-256-gcm' ||
    !isBoundedString(value.iv, 128) ||
    !isBoundedString(value.ciphertext, VALIDATION_LIMITS.protocolPayloadBytes) ||
    !isBoundedString(value.authTag, 128)
  ) {
    return null;
  }

  return {
    algorithm: 'aes-256-gcm',
    iv: value.iv,
    ciphertext: value.ciphertext,
    authTag: value.authTag
  };
};

export const createSessionHelloMessage = (
  peer: DiscoveryPeerIdentity,
  sentAt = new Date().toISOString()
): SessionHelloMessage => ({
  app: TCP_SESSION_APP_ID,
  protocolVersion: TCP_SESSION_PROTOCOL_VERSION,
  type: 'session.hello',
  peer,
  sentAt
});

export const createSessionReadyMessage = (
  peerId: string,
  sentAt = new Date().toISOString()
): SessionReadyMessage => ({
  app: TCP_SESSION_APP_ID,
  protocolVersion: TCP_SESSION_PROTOCOL_VERSION,
  type: 'session.ready',
  peerId,
  sentAt
});

export const createSessionErrorMessage = (
  code: string,
  message: string,
  sentAt = new Date().toISOString()
): SessionErrorMessage => ({
  app: TCP_SESSION_APP_ID,
  protocolVersion: TCP_SESSION_PROTOCOL_VERSION,
  type: 'session.error',
  code,
  message,
  sentAt
});

export const createEncryptedSessionEnvelope = (
  contentType: string,
  frame: EncryptedFrame,
  sentAt = new Date().toISOString()
): EncryptedSessionEnvelope => ({
  app: TCP_SESSION_APP_ID,
  protocolVersion: TCP_SESSION_PROTOCOL_VERSION,
  encrypted: true,
  contentType,
  frame,
  sentAt
});

export const serializeTcpSessionMessage = (
  message: TcpSessionControlMessage | EncryptedSessionEnvelope
): Buffer => {
  const candidate: unknown = message;
  const validation =
    isRecord(candidate) && typeof candidate.type === 'string'
      ? validateTcpSessionControlMessage(candidate)
      : validateEncryptedSessionEnvelope(candidate);

  if (!validation.ok) {
    throw new ValidationError(`Invalid TCP session message: ${validation.reason}.`);
  }

  const normalized = 'message' in validation ? validation.message : validation.envelope;
  return Buffer.from(JSON.stringify(normalized));
};

export const validateTcpSessionControlMessage = (
  rawMessage: unknown,
  expectedRoomFingerprint?: string
): TcpSessionControlValidation => {
  const parsed = parseJsonPayload(rawMessage, VALIDATION_LIMITS.protocolPayloadBytes);

  if (!parsed.ok) {
    return parsed;
  }

  if (!isRecord(parsed.value)) {
    return { ok: false, reason: 'invalid-shape' };
  }

  if (parsed.value.app !== TCP_SESSION_APP_ID) {
    return { ok: false, reason: 'unsupported-app' };
  }

  if (parsed.value.protocolVersion !== TCP_SESSION_PROTOCOL_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }

  if (!isSessionMessageType(parsed.value.type)) {
    return { ok: false, reason: 'unsupported-type' };
  }

  if (!isValidTimestamp(parsed.value.sentAt)) {
    return { ok: false, reason: 'invalid-shape' };
  }

  if (parsed.value.type === 'session.hello') {
    let peer: DiscoveryPeerIdentity;
    try {
      peer = parseDiscoveryPeerIdentity(parsed.value.peer);
    } catch {
      return { ok: false, reason: 'invalid-peer' };
    }

    if (expectedRoomFingerprint && peer.roomFingerprint !== expectedRoomFingerprint) {
      return { ok: false, reason: 'room-fingerprint-mismatch' };
    }

    return {
      ok: true,
      message: {
        app: TCP_SESSION_APP_ID,
        protocolVersion: TCP_SESSION_PROTOCOL_VERSION,
        type: 'session.hello',
        peer,
        sentAt: parsed.value.sentAt
      }
    };
  }

  if (parsed.value.type === 'session.ready') {
    if (!isBoundedString(parsed.value.peerId, VALIDATION_LIMITS.identifier)) {
      return { ok: false, reason: 'invalid-ready' };
    }

    return {
      ok: true,
      message: {
        app: TCP_SESSION_APP_ID,
        protocolVersion: TCP_SESSION_PROTOCOL_VERSION,
        type: 'session.ready',
        peerId: parsed.value.peerId,
        sentAt: parsed.value.sentAt
      }
    };
  }

  if (
    !isBoundedString(parsed.value.code, VALIDATION_LIMITS.sessionErrorCode) ||
    !isBoundedString(parsed.value.message, VALIDATION_LIMITS.sessionErrorMessage)
  ) {
    return { ok: false, reason: 'invalid-error' };
  }

  return {
    ok: true,
    message: {
      app: TCP_SESSION_APP_ID,
      protocolVersion: TCP_SESSION_PROTOCOL_VERSION,
      type: 'session.error',
      code: parsed.value.code,
      message: parsed.value.message,
      sentAt: parsed.value.sentAt
    }
  };
};

export const validateEncryptedSessionEnvelope = (
  rawMessage: unknown
): EncryptedSessionEnvelopeValidation => {
  const parsed = parseJsonPayload(rawMessage, VALIDATION_LIMITS.protocolPayloadBytes);

  if (!parsed.ok) {
    return parsed;
  }

  if (!isRecord(parsed.value)) {
    return { ok: false, reason: 'invalid-shape' };
  }

  if (parsed.value.app !== TCP_SESSION_APP_ID) {
    return { ok: false, reason: 'unsupported-app' };
  }

  if (parsed.value.protocolVersion !== TCP_SESSION_PROTOCOL_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }

  if (parsed.value.encrypted !== true) {
    return { ok: false, reason: 'not-encrypted-envelope' };
  }

  if (!isBoundedString(parsed.value.contentType, VALIDATION_LIMITS.protocolContentType)) {
    return { ok: false, reason: 'invalid-content-type' };
  }

  const frame = validateEncryptedFrame(parsed.value.frame);
  if (!frame || !isValidTimestamp(parsed.value.sentAt)) {
    return { ok: false, reason: 'invalid-encrypted-frame' };
  }

  return {
    ok: true,
    envelope: {
      app: TCP_SESSION_APP_ID,
      protocolVersion: TCP_SESSION_PROTOCOL_VERSION,
      encrypted: true,
      contentType: parsed.value.contentType,
      frame,
      sentAt: parsed.value.sentAt
    }
  };
};
