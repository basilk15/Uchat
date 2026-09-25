import type { DiscoveryPeerIdentity } from './discovery';
import type {
  ChatMessage,
  Conversation,
  CreateConversationInput,
  CreateMessageInput,
  JoinRoomInput,
  MessageDeliveryState,
  NetworkEvent,
  Peer,
  PresenceStatus,
  RoomState,
  RetryMessageInput,
  SendMessageInput,
  SetProfileInput,
  UpdateMessageDeliveryStateInput
} from './types';

export const VALIDATION_LIMITS = {
  displayName: 80,
  roomName: 80,
  passphrase: 256,
  messageBody: 8_192,
  identifier: 128,
  conversationId: 256,
  address: 253,
  publicKey: 512,
  roomFingerprint: 128,
  capability: 64,
  capabilities: 20,
  networkEventMessage: 512,
  timestamp: 64,
  protocolContentType: 128,
  sessionErrorCode: 80,
  sessionErrorMessage: 512,
  protocolPayloadBytes: 64 * 1024
} as const;

export const MIN_PORT = 1;
export const MAX_PORT = 65_535;

export const PRESENCE_STATUSES: readonly PresenceStatus[] = ['available', 'away', 'busy'] as const;
export const MESSAGE_AUTHORS: readonly ChatMessage['author'][] = ['local', 'peer'] as const;
export const MESSAGE_DELIVERY_STATES: readonly MessageDeliveryState[] = [
  'sending',
  'sent',
  'delivered',
  'failed',
  'unsent'
] as const;
export const CONVERSATION_KINDS: readonly Conversation['kind'][] = ['broadcast', 'direct'] as const;
export const NETWORK_EVENT_LEVELS: readonly NetworkEvent['level'][] = ['info', 'warning', 'error'] as const;

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (operation: string, field: string, message: string): never => {
  throw new ValidationError(`Invalid ${operation} input: ${field} ${message}.`, field);
};

const assertInputRecord = (value: unknown, operation: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new ValidationError(`Invalid ${operation} input: expected an object.`);
  }

  return value;
};

const assertKnownKeys = (
  input: Record<string, unknown>,
  operation: string,
  keys: readonly string[]
): void => {
  const allowed = new Set(keys);
  const unexpected = Object.keys(input).find((key) => !allowed.has(key));
  if (unexpected) {
    invalid(operation, unexpected, 'is not a supported field');
  }
};

const hasOwn = (input: Record<string, unknown>, field: string): boolean =>
  Object.prototype.hasOwnProperty.call(input, field);

const requiredValue = (input: Record<string, unknown>, operation: string, field: string): unknown => {
  if (!hasOwn(input, field)) {
    invalid(operation, field, 'is required');
  }

  return input[field];
};

const optionalValue = (input: Record<string, unknown>, field: string): unknown =>
  !hasOwn(input, field) || input[field] === undefined ? undefined : input[field];

interface NormalizeTextOptions {
  trim?: boolean;
  allowEmpty?: boolean;
}

export const normalizeText = (
  value: unknown,
  field: string,
  maxLength: number,
  options: NormalizeTextOptions = {}
): string => {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string.`, field);
  }

  const normalized = options.trim === false ? value : value.trim();
  if (!options.allowEmpty && normalized.trim().length === 0) {
    throw new ValidationError(`${field} cannot be empty.`, field);
  }

  if (normalized.length > maxLength) {
    throw new ValidationError(`${field} must be at most ${maxLength} characters.`, field);
  }

  return normalized;
};

export const isBoundedString = (value: unknown, maxLength: number, requireNonEmpty = true): value is string =>
  typeof value === 'string' &&
  value.length <= maxLength &&
  (!requireNonEmpty || value.trim().length > 0);

export const isPresenceStatus = (value: unknown): value is PresenceStatus =>
  typeof value === 'string' && PRESENCE_STATUSES.includes(value as PresenceStatus);

export const isMessageDeliveryState = (value: unknown): value is MessageDeliveryState =>
  typeof value === 'string' && MESSAGE_DELIVERY_STATES.includes(value as MessageDeliveryState);

export const isValidPort = (value: unknown, allowZero = false): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  Number.isFinite(value) &&
  value >= (allowZero ? 0 : MIN_PORT) &&
  value <= MAX_PORT;

export const normalizePort = (value: unknown, field: string, allowZero = false): number => {
  if (!isValidPort(value, allowZero)) {
    const minimum = allowZero ? 0 : MIN_PORT;
    throw new ValidationError(`${field} must be an integer from ${minimum} to ${MAX_PORT}.`, field);
  }

  return value;
};

export const isValidTimestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= VALIDATION_LIMITS.timestamp &&
  Number.isFinite(Date.parse(value));

export const normalizeTimestamp = (value: unknown, field: string): string => {
  if (!isValidTimestamp(value)) {
    throw new ValidationError(`${field} must be a valid timestamp.`, field);
  }

  return value;
};

export const parseJsonPayload = (
  raw: unknown,
  maxBytes = VALIDATION_LIMITS.protocolPayloadBytes
): { ok: true; value: unknown } | { ok: false; reason: 'invalid-json' | 'payload-too-large' } => {
  if (!(raw instanceof Uint8Array) && typeof raw !== 'string') {
    return { ok: true, value: raw };
  }

  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return { ok: false, reason: 'payload-too-large' };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
};

const parseEnum = <T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}.`, field);
  }

  return value as T;
};

const parseOptionalText = (
  input: Record<string, unknown>,
  field: string,
  maxLength: number
): string | undefined => {
  const value = optionalValue(input, field);
  return value === undefined ? undefined : normalizeText(value, field, maxLength);
};

const parseCapabilities = (value: unknown, field = 'capabilities'): string[] => {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array.`, field);
  }

  if (value.length > VALIDATION_LIMITS.capabilities) {
    throw new ValidationError(
      `${field} must contain at most ${VALIDATION_LIMITS.capabilities} entries.`,
      field
    );
  }

  return value.map((capability, index) =>
    normalizeText(capability, `${field}[${index}]`, VALIDATION_LIMITS.capability)
  );
};

export const parsePresenceStatus = (value: unknown, field = 'status'): PresenceStatus =>
  parseEnum(value, field, PRESENCE_STATUSES);

export const parseSetProfileInput = (value: unknown): SetProfileInput => {
  const input = assertInputRecord(value, 'setProfile');
  assertKnownKeys(input, 'setProfile', ['displayName', 'status']);

  return {
    displayName: normalizeText(
      requiredValue(input, 'setProfile', 'displayName'),
      'displayName',
      VALIDATION_LIMITS.displayName
    ),
    status: parsePresenceStatus(requiredValue(input, 'setProfile', 'status'))
  };
};

export const parseJoinRoomInput = (value: unknown): JoinRoomInput => {
  const input = assertInputRecord(value, 'joinRoom');
  assertKnownKeys(input, 'joinRoom', ['roomName', 'passphrase', 'udpPort', 'tcpPort']);

  const udpPort = optionalValue(input, 'udpPort');
  const tcpPort = optionalValue(input, 'tcpPort');

  return {
    roomName: normalizeText(
      requiredValue(input, 'joinRoom', 'roomName'),
      'roomName',
      VALIDATION_LIMITS.roomName
    ),
    passphrase: normalizeText(
      requiredValue(input, 'joinRoom', 'passphrase'),
      'passphrase',
      VALIDATION_LIMITS.passphrase,
      { trim: false }
    ),
    ...(udpPort === undefined ? {} : { udpPort: normalizePort(udpPort, 'udpPort') }),
    ...(tcpPort === undefined ? {} : { tcpPort: normalizePort(tcpPort, 'tcpPort') })
  };
};

export const parseSendMessageInput = (value: unknown): SendMessageInput => {
  const input = assertInputRecord(value, 'sendMessage');
  assertKnownKeys(input, 'sendMessage', ['conversationId', 'body']);

  return {
    conversationId: normalizeText(
      requiredValue(input, 'sendMessage', 'conversationId'),
      'conversationId',
      VALIDATION_LIMITS.conversationId
    ),
    body: normalizeText(
      requiredValue(input, 'sendMessage', 'body'),
      'body',
      VALIDATION_LIMITS.messageBody
    )
  };
};

export const parseRetryMessageInput = (value: unknown): RetryMessageInput => {
  const input = assertInputRecord(value, 'retryMessage');
  assertKnownKeys(input, 'retryMessage', ['messageId']);
  return {
    messageId: normalizeText(requiredValue(input, 'retryMessage', 'messageId'), 'messageId', VALIDATION_LIMITS.identifier)
  };
};

export interface PeerMessageInput {
  body: string;
  targetPeerId?: string;
}

export const parsePeerMessageInput = (value: unknown): PeerMessageInput => {
  const input = assertInputRecord(value, 'API message');
  assertKnownKeys(input, 'API message', ['body', 'targetPeerId']);

  const targetPeerId = parseOptionalText(input, 'targetPeerId', VALIDATION_LIMITS.identifier);
  return {
    body: normalizeText(requiredValue(input, 'API message', 'body'), 'body', VALIDATION_LIMITS.messageBody),
    ...(targetPeerId === undefined ? {} : { targetPeerId })
  };
};

export const parseRoomState = (value: unknown): RoomState => {
  const input = assertInputRecord(value, 'room');
  assertKnownKeys(input, 'room', ['roomName', 'roomId', 'joined', 'udpPort', 'tcpPort']);
  const roomId = parseOptionalText(input, 'roomId', VALIDATION_LIMITS.roomFingerprint);

  const roomName = requiredValue(input, 'room', 'roomName');
  if (roomName !== null && typeof roomName !== 'string') {
    invalid('room', 'roomName', 'must be a string or null');
  }

  const joinedValue = requiredValue(input, 'room', 'joined');
  if (typeof joinedValue !== 'boolean') {
    invalid('room', 'joined', 'must be a boolean');
  }

  return {
    roomName:
      roomName === null
        ? null
        : normalizeText(roomName, 'roomName', VALIDATION_LIMITS.roomName),
    ...(roomId === undefined ? {} : { roomId }),
    joined: joinedValue as boolean,
    udpPort: normalizePort(requiredValue(input, 'room', 'udpPort'), 'udpPort'),
    tcpPort: normalizePort(requiredValue(input, 'room', 'tcpPort'), 'tcpPort')
  };
};

export const parseDiscoveryPeerIdentity = (
  value: unknown,
  options: { allowEphemeralTcpPort?: boolean } = {}
): DiscoveryPeerIdentity => {
  const input = assertInputRecord(value, 'peer');
  assertKnownKeys(input, 'peer', [
    'id',
    'displayName',
    'status',
    'udpPort',
    'tcpPort',
    'publicKey',
    'roomFingerprint',
    'capabilities'
  ]);

  return {
    id: normalizeText(requiredValue(input, 'peer', 'id'), 'id', VALIDATION_LIMITS.identifier),
    displayName: normalizeText(
      requiredValue(input, 'peer', 'displayName'),
      'displayName',
      VALIDATION_LIMITS.displayName
    ),
    status: parsePresenceStatus(requiredValue(input, 'peer', 'status')),
    udpPort: normalizePort(requiredValue(input, 'peer', 'udpPort'), 'udpPort'),
    tcpPort: normalizePort(
      requiredValue(input, 'peer', 'tcpPort'),
      'tcpPort',
      options.allowEphemeralTcpPort === true
    ),
    publicKey: normalizeText(
      requiredValue(input, 'peer', 'publicKey'),
      'publicKey',
      VALIDATION_LIMITS.publicKey
    ),
    roomFingerprint: normalizeText(
      requiredValue(input, 'peer', 'roomFingerprint'),
      'roomFingerprint',
      VALIDATION_LIMITS.roomFingerprint
    ),
    capabilities: parseCapabilities(requiredValue(input, 'peer', 'capabilities'))
  };
};

export const parsePeer = (value: unknown): Peer => {
  const input = assertInputRecord(value, 'peer');
  assertKnownKeys(input, 'peer', [
    'id',
    'displayName',
    'status',
    'address',
    'udpPort',
    'tcpPort',
    'publicKey',
    'roomFingerprint',
    'capabilities',
    'lastSeenAt'
  ]);

  const publicKey = parseOptionalText(input, 'publicKey', VALIDATION_LIMITS.publicKey);
  const roomFingerprint = parseOptionalText(input, 'roomFingerprint', VALIDATION_LIMITS.roomFingerprint);
  const capabilitiesValue = optionalValue(input, 'capabilities');

  return {
    id: normalizeText(requiredValue(input, 'peer', 'id'), 'id', VALIDATION_LIMITS.identifier),
    displayName: normalizeText(
      requiredValue(input, 'peer', 'displayName'),
      'displayName',
      VALIDATION_LIMITS.displayName
    ),
    status: parsePresenceStatus(requiredValue(input, 'peer', 'status')),
    address: normalizeText(requiredValue(input, 'peer', 'address'), 'address', VALIDATION_LIMITS.address),
    udpPort: normalizePort(requiredValue(input, 'peer', 'udpPort'), 'udpPort'),
    tcpPort: normalizePort(requiredValue(input, 'peer', 'tcpPort'), 'tcpPort'),
    ...(publicKey === undefined ? {} : { publicKey }),
    ...(roomFingerprint === undefined ? {} : { roomFingerprint }),
    ...(capabilitiesValue === undefined ? {} : { capabilities: parseCapabilities(capabilitiesValue) }),
    lastSeenAt: normalizeTimestamp(requiredValue(input, 'peer', 'lastSeenAt'), 'lastSeenAt')
  };
};

export const parseCreateConversationInput = (value: unknown): CreateConversationInput => {
  const input = assertInputRecord(value, 'conversation');
  assertKnownKeys(input, 'conversation', ['id', 'kind', 'title', 'peerId', 'roomId', 'roomName']);

  const id = parseOptionalText(input, 'id', VALIDATION_LIMITS.conversationId);
  const peerId = parseOptionalText(input, 'peerId', VALIDATION_LIMITS.identifier);
  const roomId = parseOptionalText(input, 'roomId', VALIDATION_LIMITS.roomFingerprint);
  const roomName = parseOptionalText(input, 'roomName', VALIDATION_LIMITS.roomName);

  return {
    ...(id === undefined ? {} : { id }),
    kind: parseEnum(requiredValue(input, 'conversation', 'kind'), 'kind', CONVERSATION_KINDS),
    title: normalizeText(requiredValue(input, 'conversation', 'title'), 'title', VALIDATION_LIMITS.roomName),
    ...(peerId === undefined ? {} : { peerId }),
    ...(roomId === undefined ? {} : { roomId }),
    ...(roomName === undefined ? {} : { roomName })
  };
};

export const parseCreateMessageInput = (value: unknown): CreateMessageInput => {
  const input = assertInputRecord(value, 'message');
  assertKnownKeys(input, 'message', ['id', 'conversationId', 'body', 'author', 'senderPeerId', 'senderName', 'deliveryState', 'createdAt']);

  const id = parseOptionalText(input, 'id', VALIDATION_LIMITS.identifier);
  const deliveryState = optionalValue(input, 'deliveryState');
  const createdAt = optionalValue(input, 'createdAt');
  const senderPeerId = parseOptionalText(input, 'senderPeerId', VALIDATION_LIMITS.identifier);
  const senderName = parseOptionalText(input, 'senderName', VALIDATION_LIMITS.displayName);

  return {
    ...(id === undefined ? {} : { id }),
    conversationId: normalizeText(
      requiredValue(input, 'message', 'conversationId'),
      'conversationId',
      VALIDATION_LIMITS.conversationId
    ),
    body: normalizeText(
      requiredValue(input, 'message', 'body'),
      'body',
      VALIDATION_LIMITS.messageBody
    ),
    author: parseEnum(requiredValue(input, 'message', 'author'), 'author', MESSAGE_AUTHORS),
    ...(senderPeerId === undefined ? {} : { senderPeerId }),
    ...(senderName === undefined ? {} : { senderName }),
    ...(deliveryState === undefined
      ? {}
      : { deliveryState: parseEnum(deliveryState, 'deliveryState', MESSAGE_DELIVERY_STATES) }),
    ...(createdAt === undefined ? {} : { createdAt: normalizeTimestamp(createdAt, 'createdAt') })
  };
};

export const parseUpdateMessageDeliveryStateInput = (value: unknown): UpdateMessageDeliveryStateInput => {
  const input = assertInputRecord(value, 'message delivery state');
  assertKnownKeys(input, 'message delivery state', ['messageId', 'deliveryState']);

  return {
    messageId: normalizeText(
      requiredValue(input, 'message delivery state', 'messageId'),
      'messageId',
      VALIDATION_LIMITS.identifier
    ),
    deliveryState: parseEnum(
      requiredValue(input, 'message delivery state', 'deliveryState'),
      'deliveryState',
      MESSAGE_DELIVERY_STATES
    )
  };
};

export const parseNetworkEventInput = (value: unknown): { level: NetworkEvent['level']; message: string } => {
  const input = assertInputRecord(value, 'network event');
  assertKnownKeys(input, 'network event', ['level', 'message']);

  const level = optionalValue(input, 'level');
  return {
    level: level === undefined ? 'info' : parseEnum(level, 'level', NETWORK_EVENT_LEVELS),
    message: normalizeText(
      requiredValue(input, 'network event', 'message'),
      'message',
      VALIDATION_LIMITS.networkEventMessage
    )
  };
};
