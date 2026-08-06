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

const deliveryStateRank: Record<ChatMessage['deliveryState'], number> = {
  unsent: 0,
  sending: 1,
  sent: 2,
  failed: 3,
  delivered: 4
};

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

const mergeMessage = (existing: ChatMessage, incoming: ChatMessage): ChatMessage => {
  const existingRank = deliveryStateRank[existing.deliveryState];
  const incomingRank = deliveryStateRank[incoming.deliveryState];

  if (existingRank > incomingRank) {
    return existing;
  }

  if (existingRank === incomingRank && existing.createdAt > incoming.createdAt) {
    return existing;
  }

  return incoming;
};

const mergeMessages = (items: ChatMessage[]): ChatMessage[] => {
  const byId = new Map<string, ChatMessage>();

  items.forEach((item) => {
    const existing = byId.get(item.id);
    byId.set(item.id, existing ? mergeMessage(existing, item) : item);
  });

  return Array.from(byId.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
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

const removePeerById = (peers: Peer[], peerId: string): Peer[] => peers.filter((peer) => peer.id !== peerId);

const createLocalMessage = (conversationId: string, body: string): ChatMessage => ({
  id: `local-${Date.now()}`,
  conversationId,
  body,
  author: 'local',
  deliveryState: 'unsent',
  createdAt: new Date().toISOString()
});

const formatUnknownError = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown renderer boot error.';

const createRendererEvent = (message: string, level: NetworkEvent['level'] = 'warning'): NetworkEvent => ({
  id: `renderer-${Date.now()}`,
  level,
  message,
  createdAt: new Date().toISOString()
});

const isReliabilityEvent = (event: NetworkEvent): boolean => {
  const message = event.message.toLowerCase();

  return (
    message.includes('port') ||
    message.includes('firewall') ||
    message.includes('lan interface') ||
    message.includes('discovery') ||
    message.includes('tcp')
  );
};

export const App = (): React.JSX.Element => {
  const [state, setState] = useState<UchatAppState | null>(null);
  const [events, setEvents] = useState<NetworkEvent[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeConversationId, setActiveConversationId] = useState('broadcast');
  const [draft, setDraft] = useState('');
  const [profileDraft, setProfileDraft] = useState('Basil');
  const [statusDraft, setStatusDraft] = useState<PresenceStatus>('available');
  const [roomDraft, setRoomDraft] = useState('Local room');
  const [passphraseDraft, setPassphraseDraft] = useState('');
  const [sendState, setSendState] = useState('Ready');
  const [copyState, setCopyState] = useState('Copy');
  const [roomState, setRoomState] = useState('Local only');
  const [bootIssue, setBootIssue] = useState<string | null>(null);
  const [passphraseSubmitted, setPassphraseSubmitted] = useState(false);

  useEffect(() => {
    let mounted = true;
    const api = window.uchat;

    if (!api) {
      const message = 'Preload API unavailable. Showing local UI shell only.';
      setBootIssue(message);
      setEvents([createRendererEvent(message, 'error')]);
      return () => {
        mounted = false;
      };
    }

    void api
      .getAppState()
      .then((appState) => {
        if (!mounted) {
          return;
        }

        setState(appState);
        setEvents(appState.networkEvents);
        setMessages((current) => mergeMessages([...current, ...appState.messages]));
        setProfileDraft(appState.profile.displayName);
        setStatusDraft(appState.profile.status);
        setRoomDraft(appState.room.roomName ?? 'Local room');
        setPassphraseDraft('');
        setPassphraseSubmitted(false);
        setRoomState(appState.room.joined ? 'Room joined' : 'Local only');
        setBootIssue(null);
      })
      .catch((error: unknown) => {
        if (!mounted) {
          return;
        }

        const message = `Could not load saved app state: ${formatUnknownError(error)}`;
        setBootIssue(message);
        setEvents((current) => [createRendererEvent(message, 'error'), ...current].slice(0, 10));
      });

    const unsubscribePeer = api.onPeerUpdated((peer) => {
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

    const unsubscribePeerRemoved = api.onPeerRemoved((peerId) => {
      setState((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          peers: removePeerById(current.peers, peerId)
        };
      });
    });

    const unsubscribeMessage = api.onMessageReceived((message) => {
      setMessages((current) => mergeMessages([...current, message]));
    });

    const unsubscribeEvent = api.onNetworkEvent((event) => {
      setEvents((current) => [event, ...current].slice(0, 10));
    });

    return () => {
      mounted = false;
      unsubscribePeer();
      unsubscribePeerRemoved();
      unsubscribeMessage();
      unsubscribeEvent();
    };
  }, []);

  const peers = useMemo(() => state?.peers ?? [], [state?.peers]);
  const conversations = useMemo(
    () => buildConversations(state?.conversations ?? [], peers),
    [peers, state?.conversations]
  );
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0];
  const selectedPeer = activeConversation?.peerId
    ? peers.find((peer) => peer.id === activeConversation.peerId)
    : undefined;
  const directConversationOffline = activeConversation?.kind === 'direct' && !selectedPeer;
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
  const roomJoined = state?.room.joined ?? false;
  const ufwCommands = useMemo(() => createUfwAllowCommands(ports), [ports.tcpPort, ports.udpPort]);
  const ufwScript = useMemo(() => createCopyableUfwAllowScript(ports), [ports.tcpPort, ports.udpPort]);
  const latestReliabilityEvent = useMemo(() => events.find(isReliabilityEvent), [events]);
  const portStatusLevel = latestReliabilityEvent?.level ?? 'info';
  const portStatusLabel =
    portStatusLevel === 'error' ? 'Needs attention' : portStatusLevel === 'warning' ? 'Check network' : roomJoined ? 'Listening' : 'Not joined';
  const portStatusMessage =
    latestReliabilityEvent?.message ??
    (roomJoined
      ? `UDP ${ports.udpPort} and TCP ${ports.tcpPort} are configured for this room.`
      : 'Join a room to check local UDP and TCP port availability.');
  const onlineCount = peers.filter((peer) => peer.status === 'available').length;

  const handleProfileSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const nextProfile = {
      displayName: profileDraft.trim() || 'Uchat user',
      status: statusDraft
    };

    if (!window.uchat) {
      setState((current) => (current ? { ...current, profile: nextProfile } : current));
      setProfileDraft(nextProfile.displayName);
      setBootIssue('Profile saved only in this renderer session because preload API is unavailable.');
      return;
    }

    try {
      const profile = await window.uchat.setProfile(nextProfile);
      setState((current) => (current ? { ...current, profile } : current));
      setProfileDraft(profile.displayName);
      setStatusDraft(profile.status);
      setBootIssue(null);
    } catch (error) {
      setBootIssue(`Could not save profile: ${formatUnknownError(error)}`);
    }
  };

  const handleJoinRoom = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    setRoomState('Checking ports');

    if (!passphraseDraft.trim()) {
      setRoomState('Passphrase required');
      setPassphraseSubmitted(false);
      setBootIssue('Enter the room passphrase again. Uchat never stores passphrases after restart.');
      return;
    }

    if (!window.uchat) {
      setRoomState('Local UI only');
      setBootIssue('Room join stayed local to this renderer session because preload API is unavailable.');
      return;
    }

    try {
      const nextState = await window.uchat.joinRoom({
        roomName: roomDraft,
        passphrase: passphraseDraft,
        udpPort: ports.udpPort,
        tcpPort: ports.tcpPort
      });

      setState(nextState);
      setEvents(nextState.networkEvents);
      setRoomState('Room joined');
      setPassphraseSubmitted(true);
      setActiveConversationId('broadcast');
      setBootIssue(null);
    } catch (error) {
      setRoomState('Join failed');
      setBootIssue(`Could not join room: ${formatUnknownError(error)}`);
    }
  };

  const handleSend = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const body = draft.trim();
    if (!body || !activeConversation) {
      return;
    }

    setDraft('');
    setSendState('Saving...');

    if (!window.uchat) {
      setMessages((current) => [...current, createLocalMessage(activeConversation.id, body)]);
      setSendState('Saved in local UI fallback');
      setBootIssue('Message stayed local to this renderer session because preload API is unavailable.');
      return;
    }

    try {
      const sent = await window.uchat.sendMessage({
        conversationId: activeConversation.id,
        body
      });
      setMessages((current) => mergeMessages([...current, sent]));
      setSendState(`Message ${sent.deliveryState}`);
      setBootIssue(null);
    } catch (error) {
      setMessages((current) => [...current, createLocalMessage(activeConversation.id, body)]);
      setSendState('Mock direct message kept local');
      setBootIssue(`Message kept in local UI state: ${formatUnknownError(error)}`);
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
      {bootIssue ? (
        <section className="boot-banner" role="status" aria-live="polite">
          <strong>Renderer fallback active</strong>
          <span>{bootIssue}</span>
        </section>
      ) : null}

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
              <input
                id="display-name"
                autoComplete="name"
                value={profileDraft}
                onChange={(event) => setProfileDraft(event.target.value)}
              />
            </label>
            <label>
              Status
              <select
                id="presence-status"
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
            <strong>{roomState}</strong>
          </div>
          <label>
            Room
            <input id="room-name" value={roomDraft} onChange={(event) => setRoomDraft(event.target.value)} />
          </label>
          <label>
            Passphrase
            <input
              id="room-passphrase"
              type="password"
              autoComplete="current-password"
              value={passphraseDraft}
              onChange={(event) => setPassphraseDraft(event.target.value)}
            />
            <span className="field-note">Not stored. Re-enter to reconnect after restart.</span>
          </label>
          <button type="submit">{roomJoined ? 'Reconnect room' : 'Join local room'}</button>
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
            aria-pressed={activeConversation?.id === 'broadcast'}
            onClick={() => setActiveConversationId('broadcast')}
          >
            <span className="room-glyph" aria-hidden="true">
              #
            </span>
            <span>
              <strong>Broadcast room</strong>
              <small>{peers.length} discovered peers</small>
            </span>
          </button>

          {peers.length > 0 ? (
            peers.map((peer) => (
              <button
                className={`conversation-row ${activeConversation?.peerId === peer.id ? 'selected' : ''}`}
                type="button"
                key={peer.id}
                aria-pressed={activeConversation?.peerId === peer.id}
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
            ))
          ) : (
            <div className="empty-list">
              <strong>No peers discovered</strong>
              <span>Join the same room on another device or start the local simulator.</span>
            </div>
          )}
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
                : directConversationOffline
                  ? 'Peer offline — messages will be saved as unsent until they return.'
                : `${peers.length} discovered peers receive broadcast messages`}
            </p>
          </div>
          <span className="send-state" aria-live="polite">
            {sendState}
          </span>
        </header>

        <div className="message-history" aria-label="Message history" aria-live="polite">
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
              <span>Messages will appear here after local sends or LAN delivery.</span>
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
            <span>{selectedPeer ? 'Peer details' : directConversationOffline ? 'Direct conversation' : 'Room details'}</span>
            <strong>{selectedPeer?.status ?? (directConversationOffline ? 'offline' : roomJoined ? 'joined' : 'not joined')}</strong>
          </div>
          <div className="large-avatar" aria-hidden="true">
            {getInitials(selectedPeer?.displayName ?? activeConversation?.title ?? 'BR')}
          </div>
          <h2>
            {selectedPeer?.displayName ?? (directConversationOffline ? activeConversation?.title : state?.room.roomName) ?? 'Broadcast room'}
          </h2>
          <dl className="detail-list">
            <div>
              <dt>Address</dt>
              <dd>{selectedPeer?.address ?? (directConversationOffline ? 'Unavailable while peer is offline' : 'Same WiFi broadcast')}</dd>
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>{selectedPeer ? formatLastSeen(selectedPeer.lastSeenAt) : directConversationOffline ? 'Unavailable' : 'This device'}</dd>
            </div>
            <div>
              <dt>Peer ports</dt>
              <dd>
                {selectedPeer
                  ? `UDP ${selectedPeer.udpPort} / TCP ${selectedPeer.tcpPort}`
                  : directConversationOffline
                    ? 'Unavailable'
                    : `UDP ${ports.udpPort} / TCP ${ports.tcpPort}`}
              </dd>
            </div>
          </dl>
        </section>

        <section className="detail-section">
          <div className="section-heading">
            <span>Room security</span>
            <strong>{roomJoined && passphraseSubmitted ? 'Passphrase entered' : 'Needs passphrase'}</strong>
          </div>
          <p className="muted-copy">
            {roomJoined && passphraseSubmitted
              ? 'Passphrase was provided for this session only. It will be empty again after restart.'
              : 'Passphrases are never stored. Re-enter the room passphrase to reconnect discovery.'}
          </p>
        </section>

        <section className="detail-section">
          <div className="section-heading">
            <span>Port status</span>
            <strong className={`status-pill ${portStatusLevel}`}>{portStatusLabel}</strong>
          </div>
          <div className="port-summary">
            <div>
              <span>UDP discovery</span>
              <strong>{ports.udpPort}</strong>
            </div>
            <div>
              <span>TCP chat</span>
              <strong>{ports.tcpPort}</strong>
            </div>
          </div>
          <p className={`port-note ${portStatusLevel}`}>{portStatusMessage}</p>
          <div className="port-grid">
            {ufwCommands.map((command) => (
              <button
                className="copy-command"
                type="button"
                key={command.protocol}
                aria-label={`Copy ${command.protocol.toUpperCase()} firewall command`}
                onClick={() => copyText(command.command, `${command.protocol.toUpperCase()} copied`)}
              >
                <span>{command.protocol.toUpperCase()}</span>
                <code>{command.command}</code>
              </button>
            ))}
          </div>
          <button
            className="secondary-button wide"
            type="button"
            aria-label="Copy both firewall commands"
            onClick={() => copyText(ufwScript, 'Both copied')}
          >
            {copyState}
          </button>
        </section>

        <section className="detail-section events-section">
          <div className="section-heading">
            <span>Network events</span>
            <strong>{events.length}</strong>
          </div>
          <ol className="event-timeline" aria-label="Recent network events">
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
