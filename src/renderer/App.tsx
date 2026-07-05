import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { createCopyableUfwAllowScript, createUfwAllowCommands } from '@shared/firewall';
import type {
  ChatMessage,
  Conversation,
  NetworkEvent,
  Peer,
  PresenceStatus,
  UchatAppState
} from '@shared/types';

const now = new Date('2026-07-05T10:30:00.000Z').toISOString();

const MOCK_PEERS: Peer[] = [
  {
    id: 'peer-akhil',
    displayName: 'Akhil',
    status: 'available',
    address: '192.168.18.21',
    udpPort: 47475,
    tcpPort: 47476,
    lastSeenAt: now
  },
  {
    id: 'peer-ayesha',
    displayName: 'Ayesha',
    status: 'away',
    address: '192.168.18.34',
    udpPort: 47475,
    tcpPort: 47476,
    lastSeenAt: new Date('2026-07-05T10:25:00.000Z').toISOString()
  },
  {
    id: 'peer-omar',
    displayName: 'Omar',
    status: 'busy',
    address: '192.168.18.45',
    udpPort: 47475,
    tcpPort: 47477,
    lastSeenAt: new Date('2026-07-05T10:18:00.000Z').toISOString()
  }
];

const MOCK_MESSAGES: ChatMessage[] = [
  {
    id: 'mock-message-1',
    conversationId: 'direct-peer-akhil',
    body: 'Hey Basil, can you see me on the LAN list?',
    author: 'peer',
    deliveryState: 'delivered',
    createdAt: new Date('2026-07-05T10:31:00.000Z').toISOString()
  },
  {
    id: 'mock-message-2',
    conversationId: 'direct-peer-akhil',
    body: 'Yes, your heartbeat is showing on 192.168.18.21.',
    author: 'local',
    deliveryState: 'unsent',
    createdAt: new Date('2026-07-05T10:32:00.000Z').toISOString()
  },
  {
    id: 'mock-message-3',
    conversationId: 'broadcast',
    body: 'Broadcast room is ready for everyone on this WiFi.',
    author: 'local',
    deliveryState: 'unsent',
    createdAt: new Date('2026-07-05T10:33:00.000Z').toISOString()
  }
];

const formatTime = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));

const formatLastSeen = (value: string): string => {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));

  if (minutes < 1) {
    return 'Now';
  }

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  return formatTime(value);
};

const getInitials = (name: string): string =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'UC';

const mergeById = <T extends { id: string }>(items: T[]): T[] => {
  const byId = new Map<string, T>();
  items.forEach((item) => byId.set(item.id, item));
  return Array.from(byId.values());
};

const buildConversations = (base: Conversation[], peers: Peer[]): Conversation[] => {
  const createdAt = now;
  const broadcast =
    base.find((conversation) => conversation.id === 'broadcast') ??
    ({
      id: 'broadcast',
      kind: 'broadcast',
      title: 'Broadcast room',
      createdAt,
      updatedAt: createdAt
    } satisfies Conversation);

  const directConversations = peers.map(
    (peer): Conversation => ({
      id: `direct-${peer.id}`,
      kind: 'direct',
      title: peer.displayName,
      peerId: peer.id,
      createdAt,
      updatedAt: peer.lastSeenAt
    })
  );

  return mergeById([broadcast, ...base.filter((conversation) => conversation.id !== 'broadcast'), ...directConversations]);
};

const createLocalMessage = (conversationId: string, body: string): ChatMessage => ({
  id: `local-${Date.now()}`,
  conversationId,
  body,
  author: 'local',
  deliveryState: 'unsent',
  createdAt: new Date().toISOString()
});

export const App = (): React.JSX.Element => {
  const [state, setState] = useState<UchatAppState | null>(null);
  const [events, setEvents] = useState<NetworkEvent[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(MOCK_MESSAGES);
  const [activeConversationId, setActiveConversationId] = useState('broadcast');
  const [draft, setDraft] = useState('');
  const [profileDraft, setProfileDraft] = useState('Basil');
  const [statusDraft, setStatusDraft] = useState<PresenceStatus>('available');
  const [roomDraft, setRoomDraft] = useState('Local room');
  const [passphraseDraft, setPassphraseDraft] = useState('part-two-local-passphrase');
  const [sendState, setSendState] = useState('Ready');
  const [copyState, setCopyState] = useState('Copy');

  useEffect(() => {
    let mounted = true;

    void window.uchat.getAppState().then((appState) => {
      if (!mounted) {
        return;
      }

      setState(appState);
      setEvents(appState.networkEvents);
      setMessages((current) => mergeById([...MOCK_MESSAGES, ...appState.messages, ...current]));
      setProfileDraft(appState.profile.displayName);
      setStatusDraft(appState.profile.status);
      setRoomDraft(appState.room.roomName ?? 'Local room');
    });

    const unsubscribePeer = window.uchat.onPeerUpdated((peer) => {
      setState((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          peers: mergeById([peer, ...current.peers])
        };
      });
    });

    const unsubscribeMessage = window.uchat.onMessageReceived((message) => {
      setMessages((current) => mergeById([...current, message]));
    });

    const unsubscribeEvent = window.uchat.onNetworkEvent((event) => {
      setEvents((current) => [event, ...current].slice(0, 10));
    });

    return () => {
      mounted = false;
      unsubscribePeer();
      unsubscribeMessage();
      unsubscribeEvent();
    };
  }, []);

  const peers = useMemo(() => (state?.peers.length ? state.peers : MOCK_PEERS), [state?.peers]);
  const conversations = useMemo(
    () => buildConversations(state?.conversations ?? [], peers),
    [peers, state?.conversations]
  );
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0];
  const selectedPeer = activeConversation?.peerId
    ? peers.find((peer) => peer.id === activeConversation.peerId)
    : undefined;
  const visibleMessages = useMemo(
    () =>
      messages
        .filter((message) => message.conversationId === activeConversation?.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    [activeConversation?.id, messages]
  );

  const ports = {
    udpPort: state?.room.udpPort ?? 47475,
    tcpPort: state?.room.tcpPort ?? 47476
  };
  const ufwCommands = useMemo(() => createUfwAllowCommands(ports), [ports.tcpPort, ports.udpPort]);
  const ufwScript = useMemo(() => createCopyableUfwAllowScript(ports), [ports.tcpPort, ports.udpPort]);
  const onlineCount = peers.filter((peer) => peer.status === 'available').length;
  const roomJoined = state?.room.joined ?? false;

  const handleProfileSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const profile = await window.uchat.setProfile({
      displayName: profileDraft,
      status: statusDraft
    });

    setState((current) => (current ? { ...current, profile } : current));
    setProfileDraft(profile.displayName);
    setStatusDraft(profile.status);
  };

  const handleJoinRoom = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const nextState = await window.uchat.joinRoom({
      roomName: roomDraft,
      passphrase: passphraseDraft,
      udpPort: ports.udpPort,
      tcpPort: ports.tcpPort
    });

    setState(nextState);
    setEvents(nextState.networkEvents);
    setActiveConversationId('broadcast');
  };

  const handleSend = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const body = draft.trim();
    if (!body || !activeConversation) {
      return;
    }

    setDraft('');
    setSendState('Saving...');

    try {
      const sent = await window.uchat.sendMessage({
        conversationId: activeConversation.id,
        body
      });
      setMessages((current) => mergeById([...current, sent]));
      setSendState('Saved locally as unsent');
    } catch {
      setMessages((current) => [...current, createLocalMessage(activeConversation.id, body)]);
      setSendState('Mock direct message kept local');
    }
  };

  const copyText = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState(label);
    } catch {
      setCopyState('Copy failed');
    }
  };

  return (
    <main className="uchat-shell">
      <aside className="pane left-pane" aria-label="Uchat navigation">
        <header className="app-brand">
          <div className="brand-mark" aria-hidden="true">
            U
          </div>
          <div>
            <h1>Uchat</h1>
            <p>Linux LAN messenger</p>
          </div>
        </header>

        <form className="profile-card" onSubmit={handleProfileSubmit}>
          <div className="avatar" aria-hidden="true">
            {getInitials(state?.profile.displayName ?? profileDraft)}
          </div>
          <div className="profile-fields">
            <label>
              Display name
              <input value={profileDraft} onChange={(event) => setProfileDraft(event.target.value)} />
            </label>
            <label>
              Status
              <select
                value={statusDraft}
                onChange={(event) => setStatusDraft(event.target.value as PresenceStatus)}
              >
                <option value="available">Available</option>
                <option value="away">Away</option>
                <option value="busy">Busy</option>
              </select>
            </label>
          </div>
          <button className="secondary-button" type="submit">
            Save
          </button>
        </form>

        <form className="room-card" onSubmit={handleJoinRoom}>
          <div className="section-heading">
            <span>LAN status</span>
            <strong>{roomJoined ? 'Room joined' : 'Local only'}</strong>
          </div>
          <label>
            Room
            <input value={roomDraft} onChange={(event) => setRoomDraft(event.target.value)} />
          </label>
          <label>
            Passphrase
            <input
              type="password"
              value={passphraseDraft}
              onChange={(event) => setPassphraseDraft(event.target.value)}
            />
          </label>
          <button type="submit">{roomJoined ? 'Rejoin room' : 'Join local room'}</button>
        </form>

        <nav className="conversation-list" aria-label="Conversations">
          <div className="list-heading">
            <span>Peers</span>
            <strong>{onlineCount}/{peers.length} available</strong>
          </div>

          <button
            className={`conversation-row broadcast-row ${
              activeConversation?.id === 'broadcast' ? 'selected' : ''
            }`}
            type="button"
            onClick={() => setActiveConversationId('broadcast')}
          >
            <span className="room-glyph" aria-hidden="true">
              #
            </span>
            <span>
              <strong>Broadcast room</strong>
              <small>{peers.length} mock peers</small>
            </span>
          </button>

          {peers.map((peer) => (
            <button
              className={`conversation-row ${activeConversation?.peerId === peer.id ? 'selected' : ''}`}
              type="button"
              key={peer.id}
              onClick={() => setActiveConversationId(`direct-${peer.id}`)}
            >
              <span className="avatar small" aria-hidden="true">
                {getInitials(peer.displayName)}
              </span>
              <span>
                <strong>{peer.displayName}</strong>
                <small>
                  <span className={`presence-dot ${peer.status}`} aria-hidden="true" />
                  {peer.status === 'available' ? 'Same WiFi' : peer.status}
                </small>
              </span>
              <em>{peer.tcpPort}</em>
            </button>
          ))}
        </nav>
      </aside>

      <section className="pane chat-pane" aria-label="Active conversation">
        <header className="chat-header">
          <div className="avatar" aria-hidden="true">
            {getInitials(activeConversation?.title ?? 'Broadcast')}
          </div>
          <div>
            <h2>{activeConversation?.title ?? 'Broadcast room'}</h2>
            <p>
              {selectedPeer
                ? `${selectedPeer.address} / TCP ${selectedPeer.tcpPort}`
                : `${peers.length} peers receive broadcast messages`}
            </p>
          </div>
          <span className="send-state">{sendState}</span>
        </header>

        <div className="message-history" aria-live="polite">
          <div className="day-divider">
            <span>Today</span>
          </div>
          {visibleMessages.length > 0 ? (
            visibleMessages.map((message) => (
              <article className={`message ${message.author}`} key={message.id}>
                <div className="message-bubble">
                  <p>{message.body}</p>
                  <footer>
                    <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
                    <span>{message.deliveryState}</span>
                  </footer>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-thread">
              <strong>No messages yet</strong>
              <span>Send a local mock message to exercise the Part 2 shell.</span>
            </div>
          )}
        </div>

        <form className="composer" onSubmit={handleSend}>
          <textarea
            aria-label="Message"
            placeholder={`Message ${activeConversation?.title ?? 'Broadcast room'}`}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" disabled={!draft.trim()}>
            Send
          </button>
        </form>
      </section>

      <aside className="pane right-pane" aria-label="Network and peer details">
        <section className="detail-section peer-summary">
          <div className="section-heading">
            <span>{selectedPeer ? 'Peer details' : 'Room details'}</span>
            <strong>{selectedPeer?.status ?? (roomJoined ? 'joined' : 'not joined')}</strong>
          </div>
          <div className="large-avatar" aria-hidden="true">
            {getInitials(selectedPeer?.displayName ?? activeConversation?.title ?? 'BR')}
          </div>
          <h2>{selectedPeer?.displayName ?? state?.room.roomName ?? 'Broadcast room'}</h2>
          <dl className="detail-list">
            <div>
              <dt>Address</dt>
              <dd>{selectedPeer?.address ?? 'Same WiFi broadcast'}</dd>
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>{selectedPeer ? formatLastSeen(selectedPeer.lastSeenAt) : 'Local mock state'}</dd>
            </div>
            <div>
              <dt>Peer ports</dt>
              <dd>
                UDP {selectedPeer?.udpPort ?? ports.udpPort} / TCP {selectedPeer?.tcpPort ?? ports.tcpPort}
              </dd>
            </div>
          </dl>
        </section>

        <section className="detail-section">
          <div className="section-heading">
            <span>Room security</span>
            <strong>{roomJoined ? 'Passphrase set' : 'Waiting'}</strong>
          </div>
          <p className="muted-copy">
            {roomJoined
              ? 'Passphrase was provided for this local session. It is not stored by the renderer.'
              : 'Join a room with a passphrase before real LAN discovery starts.'}
          </p>
        </section>

        <section className="detail-section">
          <div className="section-heading">
            <span>Port status</span>
            <strong>Manual firewall</strong>
          </div>
          <div className="port-grid">
            {ufwCommands.map((command) => (
              <button
                className="copy-command"
                type="button"
                key={command.protocol}
                onClick={() => copyText(command.command, `${command.protocol.toUpperCase()} copied`)}
              >
                <span>{command.protocol.toUpperCase()}</span>
                <code>{command.command}</code>
              </button>
            ))}
          </div>
          <button className="secondary-button wide" type="button" onClick={() => copyText(ufwScript, 'Both copied')}>
            {copyState}
          </button>
        </section>

        <section className="detail-section events-section">
          <div className="section-heading">
            <span>Network events</span>
            <strong>{events.length}</strong>
          </div>
          <ol className="event-timeline">
            {events.map((event) => (
              <li className={event.level} key={event.id}>
                <span>{formatTime(event.createdAt)}</span>
                <p>{event.message}</p>
              </li>
            ))}
          </ol>
        </section>
      </aside>
    </main>
  );
};
