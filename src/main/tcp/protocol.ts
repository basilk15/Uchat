import type { EncryptedFrame } from '../security/crypto';
import type { DiscoveryPeerIdentity } from '@shared/discovery';
import type { PresenceStatus } from '@shared/types';

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
        | 'invalid-shape'
        | 'unsupported-app'
        | 'unsupported-version'
        | 'not-encrypted-envelope'
        | 'invalid-content-type'
        | 'invalid-encrypted-frame';
    };

const presenceStatuses: readonly PresenceStatus[] = ['available', 'away', 'busy'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown, maxLength = 256): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;

const isValidPort = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535;

const isValidSentAt = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

const isValidCapabilities = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 20 &&
  value.every((capability) => isNonEmptyString(capability, 64));

const isSessionMessageType = (value: unknown): value is TcpSessionMessageType =>
  typeof value === 'string' && TCP_SESSION_MESSAGE_TYPES.includes(value as TcpSessionMessageType);

const parseJson = (
  rawMessage: Uint8Array | string | unknown
): { ok: true; value: unknown } | { ok: false; reason: 'invalid-json' } => {
  if (!(rawMessage instanceof Uint8Array) && typeof rawMessage !== 'string') {
    return { ok: true, value: rawMessage };
  }

  try {
    const text = typeof rawMessage === 'string' ? rawMessage : Buffer.from(rawMessage).toString('utf8');
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
};

const validatePeer = (value: unknown): DiscoveryPeerIdentity | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (
    !isNonEmptyString(value.id, 128) ||
    !isNonEmptyString(value.displayName, 80) ||
    !presenceStatuses.includes(value.status as PresenceStatus) ||
    !isValidPort(value.udpPort) ||
    !isValidPort(value.tcpPort) ||
    !isNonEmptyString(value.publicKey, 512) ||
    !isNonEmptyString(value.roomFingerprint, 128) ||
    !isValidCapabilities(value.capabilities)
  ) {
    return null;
  }

  return {
    id: value.id,
    displayName: value.displayName,
    status: value.status as PresenceStatus,
    udpPort: value.udpPort,
    tcpPort: value.tcpPort,
    publicKey: value.publicKey,
    roomFingerprint: value.roomFingerprint,
    capabilities: value.capabilities
  };
};

const validateEncryptedFrame = (value: unknown): EncryptedFrame | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.algorithm !== 'aes-256-gcm' ||
    !isNonEmptyString(value.iv, 128) ||
    !isNonEmptyString(value.ciphertext, 1024 * 1024) ||
    !isNonEmptyString(value.authTag, 128)
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
): Buffer => Buffer.from(JSON.stringify(message));

export const validateTcpSessionControlMessage = (
  rawMessage: Uint8Array | string | unknown,
  expectedRoomFingerprint?: string
): TcpSessionControlValidation => {
  const parsed = parseJson(rawMessage);

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

  if (!isValidSentAt(parsed.value.sentAt)) {
    return { ok: false, reason: 'invalid-shape' };
  }

  if (parsed.value.type === 'session.hello') {
    const peer = validatePeer(parsed.value.peer);

    if (!peer) {
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
    if (!isNonEmptyString(parsed.value.peerId, 128)) {
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

  if (!isNonEmptyString(parsed.value.code, 80) || !isNonEmptyString(parsed.value.message, 512)) {
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
  rawMessage: Uint8Array | string | unknown
): EncryptedSessionEnvelopeValidation => {
  const parsed = parseJson(rawMessage);

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

  if (!isNonEmptyString(parsed.value.contentType, 128)) {
    return { ok: false, reason: 'invalid-content-type' };
  }

  const frame = validateEncryptedFrame(parsed.value.frame);
  if (!frame || !isValidSentAt(parsed.value.sentAt)) {
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
