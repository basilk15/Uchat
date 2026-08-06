import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
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
