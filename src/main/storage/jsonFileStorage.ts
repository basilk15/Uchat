import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canTransitionDeliveryState } from '@shared/domain';
import { createInitialAppState } from '@shared/defaults';
import type {
  ChatMessage,
  Conversation,
  CreateConversationInput,
  CreateMessageInput,
  NetworkEvent,
  Peer,
  RoomState,
  SetProfileInput,
  UchatAppState,
  UpdateMessageDeliveryStateInput
} from '@shared/types';
import { StorageError, type AddNetworkEventInput, type UchatStorage } from './types';

type StorageSnapshot = UchatAppState;

const clone = <T>(value: T): T => structuredClone(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasArray = (value: Record<string, unknown>, key: string): boolean => Array.isArray(value[key]);

const isStorageSnapshot = (value: unknown): value is StorageSnapshot => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.appName === 'Uchat' &&
    isRecord(value.profile) &&
    isRecord(value.room) &&
    hasArray(value, 'peers') &&
    hasArray(value, 'conversations') &&
    hasArray(value, 'messages') &&
    hasArray(value, 'networkEvents')
  );
};

const normalizeSnapshot = (snapshot: StorageSnapshot): StorageSnapshot => {
  const fallback = createInitialAppState();
  const now = new Date().toISOString();
  const conversations = snapshot.conversations.length > 0 ? snapshot.conversations : fallback.conversations;

  return {
    ...fallback,
    ...snapshot,
    profile: {
      ...fallback.profile,
      ...snapshot.profile
    },
    room: {
      ...fallback.room,
      ...snapshot.room
    },
    conversations: conversations.map((conversation) => ({
      ...conversation,
      createdAt: conversation.createdAt ?? conversation.updatedAt ?? now,
      updatedAt: conversation.updatedAt ?? conversation.createdAt ?? now
    }))
  };
};

// Temporary Part 3 adapter: replace with SQLite behind UchatStorage before MVP.
export class JsonFileStorage implements UchatStorage {
  readonly #filePath: string;
  #pending: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async getAppState(): Promise<UchatAppState> {
    await this.#pending;
    return clone(await this.#readSnapshot());
  }

  async setProfile(input: SetProfileInput): Promise<UchatAppState['profile']> {
    return this.#transact((snapshot) => {
      snapshot.profile = {
        displayName: input.displayName,
        status: input.status
      };
      return clone(snapshot.profile);
    });
  }

  async setRoom(input: RoomState): Promise<RoomState> {
    return this.#transact((snapshot) => {
      snapshot.room = clone(input);
      return clone(snapshot.room);
    });
  }

  async listPeers(): Promise<Peer[]> {
    const snapshot = await this.getAppState();
    return snapshot.peers;
  }

  async upsertPeer(peer: Peer): Promise<Peer> {
    return this.#transact((snapshot) => {
      const index = snapshot.peers.findIndex((current) => current.id === peer.id);
      if (index >= 0) {
        snapshot.peers[index] = clone(peer);
      } else {
        snapshot.peers.push(clone(peer));
      }

      return clone(peer);
    });
  }

  async listConversations(): Promise<Conversation[]> {
    const snapshot = await this.getAppState();
    return snapshot.conversations;
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    return this.#transact((snapshot) => {
      const now = new Date().toISOString();
      const conversation: Conversation = {
        id: input.id ?? randomUUID(),
        kind: input.kind,
        title: input.title,
        peerId: input.peerId,
        createdAt: now,
        updatedAt: now
      };

      if (snapshot.conversations.some((current) => current.id === conversation.id)) {
        throw new StorageError(`Conversation already exists: ${conversation.id}`);
      }

      snapshot.conversations.push(conversation);
      return clone(conversation);
    });
  }

  async listMessages(conversationId?: string): Promise<ChatMessage[]> {
    const snapshot = await this.getAppState();
    const messages = conversationId
      ? snapshot.messages.filter((message) => message.conversationId === conversationId)
      : snapshot.messages;

    return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createMessage(input: CreateMessageInput): Promise<ChatMessage> {
    return this.#transact((snapshot) => {
      const conversation = snapshot.conversations.find((current) => current.id === input.conversationId);
      if (!conversation) {
        throw new StorageError(`Conversation not found: ${input.conversationId}`);
      }

      const createdAt = input.createdAt ?? new Date().toISOString();
      const message: ChatMessage = {
        id: input.id ?? randomUUID(),
        conversationId: input.conversationId,
        body: input.body,
        author: input.author,
        deliveryState: input.deliveryState ?? 'sending',
        createdAt
      };

      if (snapshot.messages.some((current) => current.id === message.id)) {
        throw new StorageError(`Message already exists: ${message.id}`);
      }

      snapshot.messages.push(message);
      conversation.updatedAt = createdAt;
      return clone(message);
    });
  }

  async updateMessageDeliveryState(input: UpdateMessageDeliveryStateInput): Promise<ChatMessage> {
    return this.#transact((snapshot) => {
      const message = snapshot.messages.find((current) => current.id === input.messageId);
      if (!message) {
        throw new StorageError(`Message not found: ${input.messageId}`);
      }

      if (!canTransitionDeliveryState(message.deliveryState, input.deliveryState)) {
        throw new StorageError(
          `Cannot transition message ${message.id} from ${message.deliveryState} to ${input.deliveryState}`
        );
      }

      message.deliveryState = input.deliveryState;
      return clone(message);
    });
  }

  async addNetworkEvent(input: AddNetworkEventInput): Promise<NetworkEvent> {
    return this.#transact((snapshot) => {
      const event: NetworkEvent = {
        id: randomUUID(),
        level: input.level ?? 'info',
        message: input.message,
        createdAt: new Date().toISOString()
      };

      snapshot.networkEvents = [event, ...snapshot.networkEvents].slice(0, 50);
      return clone(event);
    });
  }

  async close(): Promise<void> {
    await this.#pending;
  }

  async #transact<T>(operation: (snapshot: StorageSnapshot) => T): Promise<T> {
    const transaction = this.#pending.then(async () => {
      const snapshot = await this.#readSnapshot();
      const result = operation(snapshot);
      await this.#writeSnapshot(snapshot);
      return result;
    });

    this.#pending = transaction.then(
      () => undefined,
      () => undefined
    );

    return transaction;
  }

  async #readSnapshot(): Promise<StorageSnapshot> {
    try {
      const raw = await readFile(this.#filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isStorageSnapshot(parsed)) {
        return normalizeSnapshot(parsed);
      }
    } catch (error) {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }
    }

    const initialState = createInitialAppState();
    await this.#writeSnapshot(initialState);
    return initialState;
  }

  async #writeSnapshot(snapshot: StorageSnapshot): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.#filePath);
  }
}

export const createJsonFileStorage = (filePath: string): UchatStorage => new JsonFileStorage(filePath);
