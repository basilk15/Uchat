import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteStorage } from './sqliteStorage';
import { StorageError } from './types';

const tempDirs: string[] = [];

const createStorage = async (): Promise<SqliteStorage> => {
  const directory = await mkdtemp(join(tmpdir(), 'uchat-sqlite-storage-'));
  tempDirs.push(directory);
  return new SqliteStorage(join(directory, 'uchat.sqlite3'));
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SqliteStorage', () => {
  it('keeps a stable identity within each room across restarts', async () => {
    const storage = await createStorage();
    const filePath = join(tempDirs[0], 'uchat.sqlite3');
    const first = await storage.getOrCreateIdentity('room-one');
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    for (const sidecar of [`${filePath}-wal`, `${filePath}-shm`]) {
      expect(existsSync(sidecar)).toBe(true);
      expect(statSync(sidecar).mode & 0o777).toBe(0o600);
    }
    expect(await storage.getOrCreateIdentity('room-one')).toEqual(first);
    expect((await storage.getOrCreateIdentity('room-two')).publicKey).not.toBe(first.publicKey);
    await storage.close();

    const reopened = new SqliteStorage(filePath);
    expect(await reopened.getOrCreateIdentity('room-one')).toEqual(first);
    await reopened.close();
  });

  it('migrates existing history without assigning it to a guessed room or sender', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'uchat-legacy-storage-'));
    tempDirs.push(directory);
    const filePath = join(directory, 'uchat.sqlite3');
    const legacy = new Database(filePath);
    legacy.exec(`
      CREATE TABLE app_settings (id INTEGER PRIMARY KEY, profile_display_name TEXT NOT NULL,
        profile_status TEXT NOT NULL, room_name TEXT, room_joined INTEGER NOT NULL,
        udp_port INTEGER NOT NULL, tcp_port INTEGER NOT NULL);
      INSERT INTO app_settings VALUES (1, 'Basil', 'available', 'Old room', 0, 47475, 47476);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
        peer_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO conversations VALUES ('broadcast', 'broadcast', 'Broadcast room', NULL,
        '2026-07-05T10:00:00.000Z', '2026-07-05T10:00:00.000Z');
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, body TEXT NOT NULL,
        author TEXT NOT NULL, delivery_state TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO messages VALUES ('old-message', 'broadcast', 'saved text', 'peer', 'delivered',
        '2026-07-05T10:00:00.000Z');
    `);
    legacy.close();

    const migrated = new SqliteStorage(filePath);
    expect(await migrated.listConversations()).toContainEqual(expect.objectContaining({
      id: 'broadcast', roomId: undefined
    }));
    expect(await migrated.listMessages('broadcast')).toContainEqual(expect.objectContaining({
      id: 'old-message', body: 'saved text', senderName: undefined
    }));
    await migrated.close();
  });

  it('rejects malformed and oversized writes before touching SQLite', async () => {
    const storage = await createStorage();

    await expect(
      storage.setProfile({ displayName: 42 as never, status: 'available' })
    ).rejects.toThrow('displayName must be a string');
    await expect(
      storage.setRoom({
        roomName: 'Lab',
        joined: true,
        udpPort: '47475' as never,
        tcpPort: 47476
      })
    ).rejects.toThrow('udpPort must be an integer');
    await expect(
      storage.createMessage({
        conversationId: 'broadcast',
        body: 'x'.repeat(8_193),
        author: 'local'
      })
    ).rejects.toThrow('body must be at most 8192 characters');
    await expect(storage.addNetworkEvent({ level: 'debug' as never, message: 'bad level' })).rejects.toThrow(
      'level must be one of: info, warning, error'
    );

    await expect(storage.getAppState()).resolves.toEqual(
      expect.objectContaining({
        profile: expect.objectContaining({ displayName: 'Basil' }),
        room: expect.objectContaining({ joined: false })
      })
    );
  });

  it('persists profile and room settings across storage instances', async () => {
    const storage = await createStorage();
    const filePath = join(tempDirs[0], 'uchat.sqlite3');

    await storage.setProfile({ displayName: 'Ada', status: 'busy' });
    await storage.setRoom({
      roomName: 'Lab',
      joined: true,
      udpPort: 49001,
      tcpPort: 49002
    });
    await storage.close();

    const reopened = new SqliteStorage(filePath);
    const state = await reopened.getAppState();

    expect(state.profile).toEqual({ displayName: 'Ada', status: 'busy' });
    expect(state.room).toEqual({
      roomName: 'Lab',
      joined: true,
      udpPort: 49001,
      tcpPort: 49002
    });

    await reopened.close();
  });

  it('creates and lists conversations and messages in chronological order', async () => {
    const storage = await createStorage();
    const conversation = await storage.createConversation({
      kind: 'direct',
      title: 'Grace',
      peerId: 'peer-grace'
    });

    const secondMessage = await storage.createMessage({
      id: 'msg-2',
      conversationId: conversation.id,
      body: 'second',
      author: 'local',
      deliveryState: 'sending',
      createdAt: '2026-07-05T10:00:02.000Z'
    });
    const firstMessage = await storage.createMessage({
      id: 'msg-1',
      conversationId: conversation.id,
      body: 'first',
      author: 'peer',
      deliveryState: 'delivered',
      createdAt: '2026-07-05T10:00:01.000Z'
    });

    const conversations = await storage.listConversations();
    expect(conversations).toContainEqual({
      ...conversation,
      updatedAt: firstMessage.createdAt
    });
    await expect(storage.listMessages(conversation.id)).resolves.toEqual([firstMessage, secondMessage]);
  });

  it('persists created messages across storage instances', async () => {
    const storage = await createStorage();
    const filePath = join(tempDirs[0], 'uchat.sqlite3');
    const message = await storage.createMessage({
      conversationId: 'broadcast',
      body: 'hello LAN',
      author: 'local',
      deliveryState: 'unsent'
    });

    await storage.close();
    const reopened = new SqliteStorage(filePath);

    await expect(reopened.listMessages('broadcast')).resolves.toEqual([message]);
    await reopened.close();
  });

  it('allows valid delivery state transitions', async () => {
    const storage = await createStorage();
    const message = await storage.createMessage({
      conversationId: 'broadcast',
      body: 'hello',
      author: 'local',
      deliveryState: 'sending'
    });

    const sent = await storage.updateMessageDeliveryState({
      messageId: message.id,
      deliveryState: 'sent'
    });
    const delivered = await storage.updateMessageDeliveryState({
      messageId: message.id,
      deliveryState: 'delivered'
    });

    expect(sent.deliveryState).toBe('sent');
    expect(delivered.deliveryState).toBe('delivered');
  });

  it('rejects invalid delivery state transitions', async () => {
    const storage = await createStorage();
    const message = await storage.createMessage({
      conversationId: 'broadcast',
      body: 'already delivered',
      author: 'local',
      deliveryState: 'delivered'
    });

    await expect(
      storage.updateMessageDeliveryState({
        messageId: message.id,
        deliveryState: 'sending'
      })
    ).rejects.toBeInstanceOf(StorageError);
  });

  it('clears runtime peers without deleting persisted chat history', async () => {
    const storage = await createStorage();
    const message = await storage.createMessage({
      conversationId: 'broadcast',
      body: 'kept',
      author: 'local',
      deliveryState: 'sent'
    });
    await storage.upsertPeer({
      id: 'peer-a',
      displayName: 'Peer A',
      status: 'available',
      address: '127.0.0.1',
      udpPort: 47475,
      tcpPort: 47476,
      publicKey: 'public-key',
      roomFingerprint: 'room',
      capabilities: ['discovery', 'tcp-session', 'chat'],
      lastSeenAt: '2026-07-05T10:00:00.000Z'
    });

    await storage.clearPeers();

    await expect(storage.listPeers()).resolves.toEqual([]);
    await expect(storage.listMessages('broadcast')).resolves.toEqual([message]);
  });

  it('removes one departed peer without clearing conversation history', async () => {
    const storage = await createStorage();
    const peer = {
      id: 'peer-a',
      displayName: 'Peer A',
      status: 'available' as const,
      address: '192.168.1.20',
      udpPort: 47475,
      tcpPort: 47476,
      publicKey: 'public-key',
      roomFingerprint: 'room',
      capabilities: ['discovery', 'tcp-session', 'chat'],
      lastSeenAt: '2026-07-05T10:00:00.000Z'
    };

    await storage.upsertPeer(peer);
    await storage.createConversation({
      id: 'direct-peer-a',
      kind: 'direct',
      title: peer.displayName,
      peerId: peer.id
    });

    await expect(storage.removePeer(peer.id)).resolves.toBe(true);
    await expect(storage.removePeer(peer.id)).resolves.toBe(false);
    await expect(storage.listPeers()).resolves.toEqual([]);
    await expect(storage.listConversations()).resolves.toContainEqual(
      expect.objectContaining({ id: 'direct-peer-a', peerId: peer.id })
    );
  });

  it('keeps only the latest network events', async () => {
    const storage = await createStorage();

    for (let index = 0; index < 55; index += 1) {
      await storage.addNetworkEvent({ message: `event-${index}` });
    }

    const state = await storage.getAppState();
    expect(state.networkEvents).toHaveLength(50);
    expect(state.networkEvents[0]?.message).toBe('event-54');
    expect(state.networkEvents.some((event) => event.message === 'event-0')).toBe(false);
  });
});
