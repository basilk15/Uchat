import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canTransitionDeliveryState, isMessageDeliveryState } from '@shared/domain';
import { createInitialAppState } from '@shared/defaults';
import type {
  ChatMessage,
  Conversation,
  CreateConversationInput,
  CreateMessageInput,
  LocalProfile,
  MessageDeliveryState,
  NetworkEvent,
  Peer,
  PresenceStatus,
  RoomState,
  SetProfileInput,
  UchatAppState,
  UpdateMessageDeliveryStateInput
} from '@shared/types';
import {
  parseCreateConversationInput,
  parseCreateMessageInput,
  parseNetworkEventInput,
  parsePeer,
  parseRoomState,
  parseSetProfileInput,
  parseUpdateMessageDeliveryStateInput,
  normalizeTimestamp,
  isBoundedString,
  VALIDATION_LIMITS
} from '@shared/validation';
import { StorageError, type AddNetworkEventInput, type UchatStorage } from './types';

interface SettingsRow {
  profile_display_name: string;
  profile_status: PresenceStatus;
  room_name: string | null;
  room_joined: 0 | 1;
  udp_port: number;
  tcp_port: number;
}

interface PeerRow {
  id: string;
  display_name: string;
  status: PresenceStatus;
  address: string;
  udp_port: number;
  tcp_port: number;
  public_key: string | null;
  room_fingerprint: string | null;
  capabilities_json: string | null;
  last_seen_at: string;
}

interface ConversationRow {
  id: string;
  kind: Conversation['kind'];
  title: string;
  peer_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  body: string;
  author: ChatMessage['author'];
  delivery_state: MessageDeliveryState;
  created_at: string;
}

interface NetworkEventRow {
  id: string;
  level: NetworkEvent['level'];
  message: string;
  created_at: string;
}

const parseCapabilities = (value: string | null): string[] | undefined => {
  if (!value) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new StorageError('Stored peer capabilities are not valid JSON.');
  }

  if (
    Array.isArray(parsed) &&
    parsed.length <= VALIDATION_LIMITS.capabilities &&
    parsed.every((entry) => isBoundedString(entry, VALIDATION_LIMITS.capability))
  ) {
    return parsed;
  }

  throw new StorageError('Stored peer capabilities are invalid.');
};

const toPeer = (row: PeerRow): Peer => ({
  ...parsePeer({
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    address: row.address,
    udpPort: row.udp_port,
    tcpPort: row.tcp_port,
    publicKey: row.public_key ?? undefined,
    roomFingerprint: row.room_fingerprint ?? undefined,
    capabilities: parseCapabilities(row.capabilities_json),
    lastSeenAt: row.last_seen_at
  })
});

const toConversation = (row: ConversationRow): Conversation => {
  const conversation = parseCreateConversationInput({
    id: row.id,
    kind: row.kind,
    title: row.title,
    peerId: row.peer_id ?? undefined
  });

  return {
    id: conversation.id as string,
    kind: conversation.kind,
    title: conversation.title,
    peerId: conversation.peerId,
    createdAt: normalizeTimestamp(row.created_at, 'createdAt'),
    updatedAt: normalizeTimestamp(row.updated_at, 'updatedAt')
  };
};

const toMessage = (row: MessageRow): ChatMessage => {
  const message = parseCreateMessageInput({
    id: row.id,
    conversationId: row.conversation_id,
    body: row.body,
    author: row.author,
    deliveryState: row.delivery_state,
    createdAt: row.created_at
  });

  if (!message.deliveryState) {
    throw new StorageError(`Stored message ${row.id} is missing a delivery state.`);
  }

  return {
    id: message.id as string,
    conversationId: message.conversationId,
    body: message.body,
    author: message.author,
    deliveryState: message.deliveryState,
    createdAt: message.createdAt as string
  };
};

const toNetworkEvent = (row: NetworkEventRow): NetworkEvent => ({
  id: row.id,
  ...parseNetworkEventInput({ level: row.level, message: row.message }),
  createdAt: normalizeTimestamp(row.created_at, 'createdAt')
});

const toRoom = (row: SettingsRow): RoomState =>
  parseRoomState({
    roomName: row.room_name,
    joined: row.room_joined === 1,
    udpPort: row.udp_port,
    tcpPort: row.tcp_port
  });

const toProfile = (row: SettingsRow): LocalProfile =>
  parseSetProfileInput({ displayName: row.profile_display_name, status: row.profile_status });

const resolveElectronNativeBinding = (): string | undefined => {
  if (!process.versions.electron) {
    return undefined;
  }

  const nativeDirectory = `electron-v${process.versions.modules}-${process.platform}-${process.arch}`;
  const candidates = [
    join(process.resourcesPath, 'native', nativeDirectory, 'better_sqlite3.node'),
    join(process.cwd(), 'native', nativeDirectory, 'better_sqlite3.node'),
    join(__dirname, '..', '..', 'native', nativeDirectory, 'better_sqlite3.node')
  ];
  const bindingPath = candidates.find((candidate) => existsSync(candidate));

  if (!bindingPath) {
    throw new StorageError(
      `Missing Electron SQLite native binding for ${nativeDirectory}. Run "pnpm rebuild:sqlite-electron".`
    );
  }

  return bindingPath;
};

export class SqliteStorage implements UchatStorage {
  readonly #db: Database.Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    const nativeBinding = resolveElectronNativeBinding();
    this.#db = new Database(filePath, nativeBinding ? { nativeBinding } : undefined);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('foreign_keys = ON');
    this.#migrate();
  }

  async getAppState(): Promise<UchatAppState> {
    const settings = this.#getSettings();

    return {
      appName: 'Uchat',
      profile: toProfile(settings),
      room: toRoom(settings),
      peers: await this.listPeers(),
      conversations: await this.listConversations(),
      messages: await this.listMessages(),
      networkEvents: this.#db
        .prepare('SELECT * FROM network_events ORDER BY created_at DESC, rowid DESC LIMIT 50')
        .all()
        .map((row) => toNetworkEvent(row as NetworkEventRow))
    };
  }

  async setProfile(input: SetProfileInput): Promise<LocalProfile> {
    const normalizedInput = parseSetProfileInput(input);
    this.#db
      .prepare('UPDATE app_settings SET profile_display_name = ?, profile_status = ? WHERE id = 1')
      .run(normalizedInput.displayName, normalizedInput.status);
    return normalizedInput;
  }

  async setRoom(input: RoomState): Promise<RoomState> {
    const normalizedInput = parseRoomState(input);
    this.#db
      .prepare('UPDATE app_settings SET room_name = ?, room_joined = ?, udp_port = ?, tcp_port = ? WHERE id = 1')
      .run(
        normalizedInput.roomName,
        normalizedInput.joined ? 1 : 0,
        normalizedInput.udpPort,
        normalizedInput.tcpPort
      );
    return normalizedInput;
  }

  async listPeers(): Promise<Peer[]> {
    return this.#db
      .prepare('SELECT * FROM peers ORDER BY last_seen_at DESC, id ASC')
      .all()
      .map((row) => toPeer(row as PeerRow));
  }

  async upsertPeer(peer: Peer): Promise<Peer> {
    const normalizedPeer = parsePeer(peer);
    this.#db
      .prepare(
        `INSERT INTO peers (
          id, display_name, status, address, udp_port, tcp_port, public_key,
          room_fingerprint, capabilities_json, last_seen_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          status = excluded.status,
          address = excluded.address,
          udp_port = excluded.udp_port,
          tcp_port = excluded.tcp_port,
          public_key = excluded.public_key,
          room_fingerprint = excluded.room_fingerprint,
          capabilities_json = excluded.capabilities_json,
          last_seen_at = excluded.last_seen_at`
      )
      .run(
        normalizedPeer.id,
        normalizedPeer.displayName,
        normalizedPeer.status,
        normalizedPeer.address,
        normalizedPeer.udpPort,
        normalizedPeer.tcpPort,
        normalizedPeer.publicKey ?? null,
        normalizedPeer.roomFingerprint ?? null,
        normalizedPeer.capabilities ? JSON.stringify(normalizedPeer.capabilities) : null,
        normalizedPeer.lastSeenAt
      );

    return normalizedPeer;
  }

  async removePeer(peerId: string): Promise<boolean> {
    const result = this.#db.prepare('DELETE FROM peers WHERE id = ?').run(peerId);
    return result.changes > 0;
  }

  async clearPeers(): Promise<void> {
    this.#db.prepare('DELETE FROM peers').run();
  }

  async listConversations(): Promise<Conversation[]> {
    return this.#db
      .prepare('SELECT * FROM conversations ORDER BY created_at ASC, id ASC')
      .all()
      .map((row) => toConversation(row as ConversationRow));
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const normalizedInput = parseCreateConversationInput(input);
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: normalizedInput.id ?? randomUUID(),
      kind: normalizedInput.kind,
      title: normalizedInput.title,
      peerId: normalizedInput.peerId,
      createdAt: now,
      updatedAt: now
    };

    const existing = this.#db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversation.id);
    if (existing) {
      throw new StorageError(`Conversation already exists: ${conversation.id}`);
    }

    this.#db
      .prepare(
        `INSERT INTO conversations (id, kind, title, peer_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        conversation.id,
        conversation.kind,
        conversation.title,
        conversation.peerId ?? null,
        conversation.createdAt,
        conversation.updatedAt
      );

    return conversation;
  }

  async listMessages(conversationId?: string): Promise<ChatMessage[]> {
    const statement = conversationId
      ? this.#db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC')
      : this.#db.prepare('SELECT * FROM messages ORDER BY created_at ASC, id ASC');
    const rows = conversationId ? statement.all(conversationId) : statement.all();
    return rows.map((row) => toMessage(row as MessageRow));
  }

  async createMessage(input: CreateMessageInput): Promise<ChatMessage> {
    const normalizedInput = parseCreateMessageInput(input);
    const createMessage = this.#db.transaction(() => {
      const conversation = this.#db
        .prepare('SELECT id FROM conversations WHERE id = ?')
        .get(normalizedInput.conversationId);
      if (!conversation) {
        throw new StorageError(`Conversation not found: ${normalizedInput.conversationId}`);
      }

      const createdAt = normalizedInput.createdAt ?? new Date().toISOString();
      const message: ChatMessage = {
        id: normalizedInput.id ?? randomUUID(),
        conversationId: normalizedInput.conversationId,
        body: normalizedInput.body,
        author: normalizedInput.author,
        deliveryState: normalizedInput.deliveryState ?? 'sending',
        createdAt
      };

      const existing = this.#db.prepare('SELECT id FROM messages WHERE id = ?').get(message.id);
      if (existing) {
        throw new StorageError(`Message already exists: ${message.id}`);
      }

      this.#db
        .prepare(
          `INSERT INTO messages (id, conversation_id, body, author, delivery_state, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(message.id, message.conversationId, message.body, message.author, message.deliveryState, message.createdAt);
      this.#db
        .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(createdAt, normalizedInput.conversationId);

      return message;
    });

    return createMessage();
  }

  async updateMessageDeliveryState(input: UpdateMessageDeliveryStateInput): Promise<ChatMessage> {
    const normalizedInput = parseUpdateMessageDeliveryStateInput(input);
    const row = this.#db.prepare('SELECT * FROM messages WHERE id = ?').get(normalizedInput.messageId) as
      | MessageRow
      | undefined;
    if (!row) {
      throw new StorageError(`Message not found: ${normalizedInput.messageId}`);
    }

    if (!isMessageDeliveryState(row.delivery_state)) {
      throw new StorageError(
        `Stored message ${normalizedInput.messageId} has invalid delivery state: ${row.delivery_state}`
      );
    }

    if (!canTransitionDeliveryState(row.delivery_state, normalizedInput.deliveryState)) {
      throw new StorageError(
        `Cannot transition message ${normalizedInput.messageId} from ${row.delivery_state} to ${normalizedInput.deliveryState}`
      );
    }

    this.#db
      .prepare('UPDATE messages SET delivery_state = ? WHERE id = ?')
      .run(normalizedInput.deliveryState, normalizedInput.messageId);
    return {
      ...toMessage(row),
      deliveryState: normalizedInput.deliveryState
    };
  }

  async addNetworkEvent(input: AddNetworkEventInput): Promise<NetworkEvent> {
    const normalizedInput = parseNetworkEventInput(input);
    const event: NetworkEvent = {
      id: randomUUID(),
      level: normalizedInput.level,
      message: normalizedInput.message,
      createdAt: new Date().toISOString()
    };

    const addEvent = this.#db.transaction(() => {
      this.#db
        .prepare('INSERT INTO network_events (id, level, message, created_at) VALUES (?, ?, ?, ?)')
        .run(event.id, event.level, event.message, event.createdAt);
      this.#db
        .prepare(
          `DELETE FROM network_events
           WHERE id NOT IN (
             SELECT id FROM network_events ORDER BY created_at DESC, rowid DESC LIMIT 50
           )`
        )
        .run();
    });
    addEvent();

    return event;
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  #getSettings(): SettingsRow {
    const row = this.#db.prepare('SELECT * FROM app_settings WHERE id = 1').get() as SettingsRow | undefined;
    if (!row) {
      throw new StorageError('Missing app settings row.');
    }
    return row;
  }

  #migrate(): void {
    const migrate = this.#db.transaction(() => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          profile_display_name TEXT NOT NULL,
          profile_status TEXT NOT NULL,
          room_name TEXT,
          room_joined INTEGER NOT NULL CHECK (room_joined IN (0, 1)),
          udp_port INTEGER NOT NULL,
          tcp_port INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS peers (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          status TEXT NOT NULL,
          address TEXT NOT NULL,
          udp_port INTEGER NOT NULL,
          tcp_port INTEGER NOT NULL,
          public_key TEXT,
          room_fingerprint TEXT,
          capabilities_json TEXT,
          last_seen_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          peer_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          body TEXT NOT NULL,
          author TEXT NOT NULL,
          delivery_state TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS network_events (
          id TEXT PRIMARY KEY,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_peers_last_seen_at ON peers(last_seen_at);
        CREATE INDEX IF NOT EXISTS idx_conversations_peer_id ON conversations(peer_id);
        CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at ON messages(conversation_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_network_events_created_at ON network_events(created_at);
      `);

      this.#seedDefaults();
      this.#db.pragma('user_version = 1');
    });

    migrate();
  }

  #seedDefaults(): void {
    const initialState = createInitialAppState();
    const broadcastConversation = initialState.conversations.find((conversation) => conversation.id === 'broadcast');

    this.#db
      .prepare(
        `INSERT OR IGNORE INTO app_settings (
          id, profile_display_name, profile_status, room_name, room_joined, udp_port, tcp_port
        )
        VALUES (1, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        initialState.profile.displayName,
        initialState.profile.status,
        initialState.room.roomName,
        initialState.room.joined ? 1 : 0,
        initialState.room.udpPort,
        initialState.room.tcpPort
      );

    if (broadcastConversation) {
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO conversations (id, kind, title, peer_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          broadcastConversation.id,
          broadcastConversation.kind,
          broadcastConversation.title,
          broadcastConversation.peerId ?? null,
          broadcastConversation.createdAt,
          broadcastConversation.updatedAt
        );
    }

    const eventCount = this.#db.prepare('SELECT COUNT(*) AS count FROM network_events').get() as
      | { count: number }
      | undefined;
    if (eventCount?.count === 0) {
      const initialEvent = initialState.networkEvents[0];
      this.#db
        .prepare('INSERT INTO network_events (id, level, message, created_at) VALUES (?, ?, ?, ?)')
        .run(initialEvent.id, initialEvent.level, initialEvent.message, initialEvent.createdAt);
    }
  }
}

export const createSqliteStorage = (filePath: string): UchatStorage => new SqliteStorage(filePath);
