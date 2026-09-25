import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage, Conversation } from '@shared/types';
import { buildConversations, mergeMessages, MessageBubble } from './App';

const timestamp = '2026-07-05T10:00:00.000Z';
const conversation = (id: string, kind: Conversation['kind'], roomId?: string): Conversation => ({
  id,
  kind,
  title: kind === 'direct' ? 'Ada' : 'Broadcast room',
  ...(kind === 'direct' ? { peerId: 'peer-a' } : {}),
  ...(roomId ? { roomId, roomName: roomId } : {}),
  createdAt: timestamp,
  updatedAt: timestamp
});
const message = (id: string, conversationId: string, deliveryState: ChatMessage['deliveryState']): ChatMessage => ({
  id, conversationId, body: 'hello', author: 'local', deliveryState, createdAt: timestamp
});

describe('chat view model', () => {
  it('keeps offline current-room chats and archived history available without mixing rooms', () => {
    const base = [
      conversation('broadcast', 'broadcast'),
      conversation('broadcast-current', 'broadcast', 'current'),
      conversation('direct-current-peer-a', 'direct', 'current'),
      conversation('broadcast-other', 'broadcast', 'other')
    ];
    const conversations = buildConversations(base, [], 'current', 'Current room', [
      message('old', 'broadcast', 'delivered'),
      message('other', 'broadcast-other', 'delivered')
    ]);

    expect(conversations.map((item) => item.id)).toEqual([
      'broadcast-current', 'direct-current-peer-a', 'broadcast', 'broadcast-other'
    ]);
    expect(conversations[1].peerId).toBe('peer-a');
    expect(conversations[1].roomId).toBe('current');
  });

  it('shows a retry progressing while preserving a delivered acknowledgement against a stale response', () => {
    const failed = message('retry-me', 'direct-current-peer-a', 'failed');
    expect(mergeMessages([failed, { ...failed, deliveryState: 'sending' }])[0].deliveryState).toBe('sending');
    expect(mergeMessages([failed, { ...failed, deliveryState: 'sent' }])[0].deliveryState).toBe('sent');
    expect(mergeMessages([{ ...failed, deliveryState: 'delivered' }, { ...failed, deliveryState: 'sent' }])[0]
      .deliveryState).toBe('delivered');
  });

  it('renders broadcast sender names and the appropriate delivery recovery control', () => {
    const render = (current: ChatMessage, canSend: boolean, archived: boolean, peerOnline = true): string =>
      renderToStaticMarkup(createElement(MessageBubble, {
        message: current, canSend, archived, peerOnline, retrying: false,
        onRetry: () => undefined, onCopy: () => undefined
      }));

    const received = { ...message('from-ada', 'broadcast-current', 'delivered'), author: 'peer' as const,
      senderPeerId: 'peer-a', senderName: 'Ada' };
    expect(render(received, true, false)).toContain('class="message-sender">Ada</strong>');

    const unsent = message('retry-me', 'broadcast-current', 'unsent');
    expect(render(unsent, true, false)).toContain('Retry send</button>');
    expect(render(unsent, false, true)).toContain('Copy message</button>');
    expect(render(unsent, true, false, false)).toContain('disabled=""');
    expect(render({ ...unsent, deliveryState: 'delivered' }, true, false)).not.toContain('Retry send');
  });
});
