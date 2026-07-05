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
        | 'invalid-shape'
        | 'unsupported-app'
        | 'unsupported-version'
        | 'unsupported-type'
        | 'invalid-peer'
        | 'room-fingerprint-mismatch';
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

const isDiscoveryPacketType = (value: unknown): value is DiscoveryPacketType =>
  typeof value === 'string' && DISCOVERY_PACKET_TYPES.includes(value as DiscoveryPacketType);

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
  rawPacket: Uint8Array | string | unknown,
  expectedRoomFingerprint?: string
): DiscoveryPacketValidation => {
  let parsed: unknown = rawPacket;

  if (rawPacket instanceof Uint8Array || typeof rawPacket === 'string') {
    try {
      const packetText = typeof rawPacket === 'string' ? rawPacket : new TextDecoder().decode(rawPacket);
      parsed = JSON.parse(packetText);
    } catch {
      return { ok: false, reason: 'invalid-json' };
    }
  }

  if (!isRecord(parsed)) {
    return { ok: false, reason: 'invalid-shape' };
  }

  if (parsed.app !== DISCOVERY_APP_ID) {
    return { ok: false, reason: 'unsupported-app' };
  }

  if (parsed.protocolVersion !== DISCOVERY_PROTOCOL_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }

  if (!isDiscoveryPacketType(parsed.type)) {
    return { ok: false, reason: 'unsupported-type' };
  }

  const peer = validatePeer(parsed.peer);

  if (!peer || !isValidSentAt(parsed.sentAt)) {
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
      type: parsed.type,
      peer,
      sentAt: parsed.sentAt
    }
  };
};
