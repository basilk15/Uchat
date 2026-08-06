import {
  isBoundedString,
  isRecord,
  isValidTimestamp,
  parseDiscoveryPeerIdentity,
  parseJsonPayload,
  VALIDATION_LIMITS
} from './validation';
import type { PresenceStatus } from './types';

export const DISCOVERY_PROTOCOL_VERSION = 1;
export const DISCOVERY_APP_ID = 'uchat';

export const DISCOVERY_PACKET_TYPES = ['peer.hello', 'peer.heartbeat', 'peer.goodbye'] as const;

export type DiscoveryPacketType = (typeof DISCOVERY_PACKET_TYPES)[number];

export interface DiscoveryPeerIdentity {
  id: string;
  displayName: string;
  status: PresenceStatus;
  udpPort: number;
  tcpPort: number;
  publicKey: string;
  roomFingerprint: string;
  capabilities: string[];
}

export interface DiscoveryPacket {
  app: typeof DISCOVERY_APP_ID;
  protocolVersion: typeof DISCOVERY_PROTOCOL_VERSION;
  type: DiscoveryPacketType;
  peer: DiscoveryPeerIdentity;
  sentAt: string;
}

export type DiscoveryPacketValidation =
  | {
      ok: true;
      packet: DiscoveryPacket;
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
        | 'room-fingerprint-mismatch';
    };

const isDiscoveryPacketType = (value: unknown): value is DiscoveryPacketType =>
  typeof value === 'string' && DISCOVERY_PACKET_TYPES.includes(value as DiscoveryPacketType);

export const createDiscoveryPacket = (
  type: DiscoveryPacketType,
  peer: DiscoveryPeerIdentity,
  sentAt = new Date().toISOString()
): DiscoveryPacket => ({
  app: DISCOVERY_APP_ID,
  protocolVersion: DISCOVERY_PROTOCOL_VERSION,
  type,
  peer,
  sentAt
});

export const validateDiscoveryPacket = (
  rawPacket: unknown,
  expectedRoomFingerprint?: string
): DiscoveryPacketValidation => {
  const parsed = parseJsonPayload(rawPacket, VALIDATION_LIMITS.protocolPayloadBytes);

  if (!parsed.ok) {
    return parsed;
  }

  if (!isRecord(parsed.value)) {
    return { ok: false, reason: 'invalid-shape' };
  }

  if (parsed.value.app !== DISCOVERY_APP_ID) {
    return { ok: false, reason: 'unsupported-app' };
  }

  if (parsed.value.protocolVersion !== DISCOVERY_PROTOCOL_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }

  if (!isDiscoveryPacketType(parsed.value.type)) {
    return { ok: false, reason: 'unsupported-type' };
  }

  let peer: DiscoveryPeerIdentity;
  try {
    peer = parseDiscoveryPeerIdentity(parsed.value.peer);
  } catch {
    return { ok: false, reason: 'invalid-peer' };
  }

  if (
    !isValidTimestamp(parsed.value.sentAt) ||
    !isBoundedString(parsed.value.sentAt, VALIDATION_LIMITS.timestamp)
  ) {
    return { ok: false, reason: 'invalid-peer' };
  }

  if (expectedRoomFingerprint && peer.roomFingerprint !== expectedRoomFingerprint) {
    return { ok: false, reason: 'room-fingerprint-mismatch' };
  }

  return {
    ok: true,
    packet: {
      app: DISCOVERY_APP_ID,
      protocolVersion: DISCOVERY_PROTOCOL_VERSION,
      type: parsed.value.type,
      peer,
      sentAt: parsed.value.sentAt
    }
  };
};
