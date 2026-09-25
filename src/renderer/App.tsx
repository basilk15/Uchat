import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { DEFAULT_DISCOVERY_PORT, DEFAULT_TCP_PORT } from '@shared/defaults';
import { createCopyableUfwAllowScript, createUfwAllowCommands } from '@shared/firewall';
import { MAX_PORT, MIN_PORT } from '@shared/validation';
import {
  DEFAULT_PORT_DRAFT,
  PORT_FIELD_LABELS,
  PORT_RANGE_HELPER,
  type PortDraftErrors,
  type PortField,
  validatePortDraft,
  validatePortDrafts
} from './portSettings';
import type {
  ChatMessage,
  Conversation,
  NetworkEvent,
  Peer,
  PresenceStatus,
  UchatAppState
} from '@shared/types';

const now = new Date('2026-07-05T10:30:00.000Z').toISOString();
const THEME_STORAGE_KEY = 'uchat-theme';

type AppTheme = 'light' | 'dark';

const readThemePreference = (): AppTheme => {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
};

const formatTime = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));

const isSameCalendarDay = (left: Date, right: Date): boolean =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

const formatConversationDay = (value: string): string => {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  if (isSameCalendarDay(date, today)) {
    return 'Today';
  }

  if (isSameCalendarDay(date, yesterday)) {
    return 'Yesterday';
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric'
  }).format(date);
};

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
  if (existing.deliveryState === 'delivered' && incoming.deliveryState !== 'delivered') {
    return existing;
  }
  return incoming;
};

export const mergeMessages = (items: ChatMessage[]): ChatMessage[] => {
  const byId = new Map<string, ChatMessage>();

  items.forEach((item) => {
    const existing = byId.get(item.id);
    byId.set(item.id, existing ? mergeMessage(existing, item) : item);
  });

  return Array.from(byId.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
};

export const buildConversations = (
  base: Conversation[],
  peers: Peer[],
  roomId: string | undefined,
  roomName: string | null,
  messages: ChatMessage[]
): Conversation[] => {
  const createdAt = now;
  const broadcastId = roomId ? `broadcast-${roomId}` : 'broadcast';
  const broadcast =
    base.find((conversation) => conversation.id === broadcastId) ??
    ({
      id: broadcastId,
      kind: 'broadcast',
      title: 'Broadcast room',
      roomId,
      roomName: roomName ?? undefined,
      createdAt,
      updatedAt: createdAt
    } satisfies Conversation);

  const onlineConversations = peers.map(
    (peer): Conversation => ({
      id: `direct-${roomId}-${peer.id}`,
      kind: 'direct',
      title: peer.displayName,
      peerId: peer.id,
      roomId,
      roomName: roomName ?? undefined,
      createdAt,
      updatedAt: peer.lastSeenAt
    })
  );

  const savedDirect = base.filter((conversation) => conversation.kind === 'direct' && conversation.roomId === roomId);
  const archived = base.filter((conversation) =>
    conversation.roomId !== roomId && messages.some((message) => message.conversationId === conversation.id)
  );
  return mergeById([broadcast, ...savedDirect, ...onlineConversations, ...archived]);
};

const removePeerById = (peers: Peer[], peerId: string): Peer[] => peers.filter((peer) => peer.id !== peerId);

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

interface MessageBubbleProps {
  message: ChatMessage;
  canSend: boolean;
  archived: boolean;
  peerOnline: boolean;
  retrying: boolean;
  onRetry: () => void;
  onCopy: () => void;
}

export const MessageBubble = ({
  message, canSend, archived, peerOnline, retrying, onRetry, onCopy
}: MessageBubbleProps): React.JSX.Element => (
  <article className={`message ${message.author}`}>
    <div className="message-bubble">
      {message.author === 'peer' ? (
        <strong className="message-sender">{message.senderName ?? 'Unknown peer'}</strong>
      ) : null}
      <p>{message.body}</p>
      <footer>
        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        {message.author === 'local' ? <span>{message.deliveryState}</span> : null}
      </footer>
      {message.author === 'local' &&
        (message.deliveryState === 'failed' || message.deliveryState === 'unsent') &&
        canSend ? (
          <button className="message-retry" type="button" disabled={retrying || !peerOnline} onClick={onRetry}>
            {retrying ? 'Retrying…' : 'Retry send'}
          </button>
        ) : null}
      {message.author === 'local' &&
        (message.deliveryState === 'failed' || message.deliveryState === 'unsent') &&
        archived ? (
          <button className="message-retry" type="button" onClick={onCopy}>Copy message</button>
        ) : null}
    </div>
  </article>
);

type ResponsivePanel = 'conversations' | 'details' | null;

export const App = (): React.JSX.Element => {
  const [theme, setTheme] = useState<AppTheme>(readThemePreference);
  const [state, setState] = useState<UchatAppState | null>(null);
  const [events, setEvents] = useState<NetworkEvent[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeConversationId, setActiveConversationId] = useState('broadcast');
  const [draft, setDraft] = useState('');
  const [profileDraft, setProfileDraft] = useState('Basil');
  const [statusDraft, setStatusDraft] = useState<PresenceStatus>('available');
  const [roomDraft, setRoomDraft] = useState('Local room');
  const [passphraseDraft, setPassphraseDraft] = useState('');
  const [udpPortDraft, setUdpPortDraft] = useState(DEFAULT_PORT_DRAFT.udpPort);
  const [tcpPortDraft, setTcpPortDraft] = useState(DEFAULT_PORT_DRAFT.tcpPort);
  const [portErrors, setPortErrors] = useState<PortDraftErrors>({});
  const [sendState, setSendState] = useState('');
  const [retryingMessageId, setRetryingMessageId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState('');
  const [roomState, setRoomState] = useState('Not connected');
  const [bootIssue, setBootIssue] = useState<string | null>(null);
  const [passphraseSubmitted, setPassphraseSubmitted] = useState(false);
  const [responsivePanel, setResponsivePanel] = useState<ResponsivePanel>(null);
  const [roomSettingsOpen, setRoomSettingsOpen] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const portSettingsRef = useRef<HTMLDetailsElement | null>(null);
  const panelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const conversationsCloseRef = useRef<HTMLButtonElement | null>(null);
  const detailsCloseRef = useRef<HTMLButtonElement | null>(null);
  const previousPanelRef = useRef<ResponsivePanel>(null);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The toggle still works for this session if persistent storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    if (responsivePanel === 'conversations') {
      conversationsCloseRef.current?.focus();
    } else if (responsivePanel === 'details') {
      detailsCloseRef.current?.focus();
    } else if (previousPanelRef.current) {
      panelTriggerRef.current?.focus();
    }

    previousPanelRef.current = responsivePanel;
  }, [responsivePanel]);

  useEffect(() => {
    if (!responsivePanel) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setResponsivePanel(null);
        setRoomSettingsOpen(false);
      }
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [responsivePanel]);

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
        setUdpPortDraft(String(appState.room.udpPort));
        setTcpPortDraft(String(appState.room.tcpPort));
        setPortErrors({});
        setPassphraseSubmitted(false);
        setRoomState(appState.room.joined ? 'Connected' : 'Not connected');
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
      void api.listConversations().then((conversations) => {
        if (mounted) {
          setState((current) => current ? { ...current, conversations } : current);
        }
      }).catch(() => undefined);
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
    () => buildConversations(state?.conversations ?? [], peers, state?.room.roomId, state?.room.roomName ?? null, messages),
    [peers, state?.conversations, state?.room.roomId, state?.room.roomName, messages]
  );
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0];
  const currentBroadcast = conversations.find((conversation) =>
    conversation.kind === 'broadcast' && conversation.roomId === state?.room.roomId
  );
  const savedDirectConversations = conversations.filter((conversation) => conversation.kind === 'direct');
  const archivedBroadcasts = conversations.filter((conversation) =>
    conversation.kind === 'broadcast' && conversation.id !== currentBroadcast?.id
  );
  const activeConversationArchived = activeConversation?.roomId !== state?.room.roomId;
  const canSend = Boolean(state?.room.joined && activeConversation && !activeConversationArchived);
  const selectedPeer = activeConversation?.peerId && !activeConversationArchived
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
    udpPort: state?.room.udpPort ?? DEFAULT_DISCOVERY_PORT,
    tcpPort: state?.room.tcpPort ?? DEFAULT_TCP_PORT
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
  const roomStatusTone = roomJoined
    ? 'success'
    : roomState === 'Join failed' || roomState === 'Local UI only'
      ? 'error'
      : roomState === 'Checking ports'
        ? 'info'
        : roomState === 'Check port settings' || roomState === 'Passphrase required'
          ? 'warning'
          : 'neutral';

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
      setProfileEditorOpen(false);
      return;
    }

    try {
      const profile = await window.uchat.setProfile(nextProfile);
      setState((current) => (current ? { ...current, profile } : current));
      setProfileDraft(profile.displayName);
      setStatusDraft(profile.status);
      setProfileEditorOpen(false);
      setBootIssue(null);
    } catch (error) {
      setBootIssue(`Could not save profile: ${formatUnknownError(error)}`);
    }
  };

  const handleJoinRoom = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    setRoomState('Checking ports');

    const portValidation = validatePortDrafts({ udpPort: udpPortDraft, tcpPort: tcpPortDraft });
    setPortErrors(portValidation.errors);

    if (!portValidation.values) {
      setRoomState('Check port settings');
      if (portSettingsRef.current) {
        portSettingsRef.current.open = true;
      }
      setBootIssue('Choose a valid UDP and TCP port before joining.');
      return;
    }

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
        udpPort: portValidation.values.udpPort,
        tcpPort: portValidation.values.tcpPort
      });

      setState(nextState);
      setEvents(nextState.networkEvents);
      setUdpPortDraft(String(nextState.room.udpPort));
      setTcpPortDraft(String(nextState.room.tcpPort));
      setPortErrors({});
      setRoomState('Connected');
      setPassphraseSubmitted(true);
      setActiveConversationId(`broadcast-${nextState.room.roomId}`);
      setRoomSettingsOpen(false);
      setResponsivePanel(null);
      setBootIssue(null);
    } catch (error) {
      setRoomState('Join failed');
      setBootIssue(`Could not join room: ${formatUnknownError(error)}`);
    }
  };

  const handlePortChange = (field: PortField, value: string): void => {
    if (field === 'udpPort') {
      setUdpPortDraft(value);
    } else {
      setTcpPortDraft(value);
    }

    if (portErrors[field]) {
      setPortErrors((current) => ({ ...current, [field]: undefined }));
    }
  };

  const handlePortBlur = (field: PortField, value: string): void => {
    const validation = validatePortDraft(value, field);
    setPortErrors((current) => ({
      ...current,
      [field]: validation.error
    }));
  };

  const handleSend = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const body = draft.trim();
    if (!body || !activeConversation) {
      return;
    }

    setDraft('');
    setSendState('Sending…');

    if (!window.uchat) {
      setDraft(body);
      setSendState('Not sent');
      setBootIssue('Message could not be sent because the app connection is unavailable.');
      return;
    }

    try {
      const sent = await window.uchat.sendMessage({
        conversationId: activeConversation.id,
        body
      });
      setMessages((current) => mergeMessages([...current, sent]));
      void window.uchat.listConversations().then((conversations) => {
        setState((current) => current ? { ...current, conversations } : current);
      }).catch(() => undefined);
      setSendState(sent.deliveryState);
      setBootIssue(null);
    } catch (error) {
      setDraft(body);
      setSendState('Not sent');
      setBootIssue(`Could not send message: ${formatUnknownError(error)}`);
    }
  };

  const handleRetryMessage = async (messageId: string): Promise<void> => {
    if (!window.uchat) {
      setBootIssue('Message could not be retried because the app connection is unavailable.');
      return;
    }
    setRetryingMessageId(messageId);
    setSendState('Retrying…');
    try {
      const retried = await window.uchat.retryMessage({ messageId });
      setMessages((current) => mergeMessages([...current, retried]));
      setSendState(retried.deliveryState);
      setBootIssue(null);
    } catch (error) {
      setSendState('Retry failed');
      setBootIssue(`Could not retry message: ${formatUnknownError(error)}`);
    } finally {
      setRetryingMessageId(null);
    }
  };

  const handleCopyMessage = async (body: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(body);
      setSendState('Message copied');
    } catch {
      setBootIssue('Could not copy the message. You can select its text instead.');
    }
  };

  const copyText = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState(label);
    } catch {
      setCopyState('Could not copy to clipboard.');
    }
  };

  return (
    <main className={`uchat-shell${responsivePanel ? ` panel-open-${responsivePanel}` : ''}`}>
      {bootIssue ? (
        <section className="app-alert" role="alert" aria-live="assertive">
          <span className="alert-mark" aria-hidden="true">!</span>
          <p>{bootIssue}</p>
          <button type="button" onClick={() => setBootIssue(null)} aria-label="Dismiss message">
            Dismiss
          </button>
        </section>
      ) : null}

      <aside id="left-pane" className="pane left-pane" aria-label="Uchat navigation">
        <header className="app-brand">
          <div className="brand-mark" aria-hidden="true">
            U
          </div>
          <div>
            <h1>Uchat</h1>
            <p>Private local chat</p>
          </div>
          <button
            className="pane-close nav-close"
            ref={conversationsCloseRef}
            type="button"
            onClick={() => {
              setResponsivePanel(null);
              setRoomSettingsOpen(false);
            }}
          >
            Close
          </button>
        </header>

        <button
          className="room-switcher"
          type="button"
          aria-controls="right-pane"
          aria-expanded={responsivePanel === 'details' && roomSettingsOpen}
          onClick={(event) => {
            panelTriggerRef.current = event.currentTarget;
            setRoomSettingsOpen(true);
            setResponsivePanel('details');
          }}
        >
          <span className="room-switcher-icon" aria-hidden="true">#</span>
          <span className="room-switcher-copy">
            <span className="eyebrow">YOUR ROOM</span>
            <strong>{roomJoined ? state?.room.roomName ?? roomDraft : 'Not connected'}</strong>
            <small>
              <span className={`presence-dot ${roomJoined ? 'available' : 'away'}`} aria-hidden="true" />
              {roomJoined ? `${onlineCount} nearby` : 'Connect to get started'}
            </small>
          </span>
          <span className="room-switcher-action">{roomJoined ? 'Manage' : 'Join'} <span aria-hidden="true">›</span></span>
        </button>

        <nav className="conversation-list" aria-label="Conversations">
          <div className="list-heading">
            <span>CHATS</span>
            {roomJoined ? <strong>{onlineCount} online</strong> : null}
          </div>

          <button
            className={`conversation-row broadcast-row ${
              activeConversation?.id === currentBroadcast?.id ? 'selected' : ''
            }`}
            type="button"
            aria-pressed={activeConversation?.id === currentBroadcast?.id}
            onClick={() => {
              setActiveConversationId(currentBroadcast?.id ?? 'broadcast');
              setResponsivePanel(null);
              setRoomSettingsOpen(false);
            }}
          >
            <span className="room-glyph" aria-hidden="true">
              #
            </span>
            <span>
              <strong>Broadcast room</strong>
              <small>{peers.length} peers in this room</small>
            </span>
          </button>

          {savedDirectConversations.length > 0 ? (
            savedDirectConversations.map((conversation) => {
              const peer = conversation.roomId === state?.room.roomId
                ? peers.find((item) => item.id === conversation.peerId)
                : undefined;
              return (
                <button
                  className={`conversation-row ${activeConversation?.id === conversation.id ? 'selected' : ''}`}
                  type="button"
                  key={conversation.id}
                  aria-pressed={activeConversation?.id === conversation.id}
                  onClick={() => {
                    setActiveConversationId(conversation.id);
                    setResponsivePanel(null);
                    setRoomSettingsOpen(false);
                  }}
                >
                  <span className="avatar small" aria-hidden="true">
                    {getInitials(conversation.title)}
                  </span>
                  <span>
                    <strong>{conversation.title}</strong>
                    <small>
                      {peer ? <span className={`presence-dot ${peer.status}`} aria-hidden="true" /> : null}
                      {conversation.roomId !== state?.room.roomId
                        ? `Earlier room: ${conversation.roomName ?? 'unknown'}`
                        : peer ? (peer.status === 'available' ? 'Available' : peer.status) : 'Offline'}
                    </small>
                  </span>
                </button>
              );
            })
          ) : (
            <div className="empty-list">
              <strong>{roomJoined ? 'No one nearby yet' : 'Your people will show up here'}</strong>
              <span>{roomJoined ? 'When someone joins this room, they’ll appear here.' : 'Join a room to find people on your local network.'}</span>
            </div>
          )}
          {archivedBroadcasts.map((conversation) => (
            <button
              className={`conversation-row broadcast-row ${activeConversation?.id === conversation.id ? 'selected' : ''}`}
              type="button"
              key={conversation.id}
              aria-pressed={activeConversation?.id === conversation.id}
              onClick={() => {
                setActiveConversationId(conversation.id);
                setResponsivePanel(null);
              }}
            >
              <span className="room-glyph" aria-hidden="true">#</span>
              <span>
                <strong>{conversation.roomName ?? 'Earlier history'}</strong>
                <small>Saved broadcast history</small>
              </span>
            </button>
          ))}
        </nav>

        <form className={`profile-card${profileEditorOpen ? ' editing' : ''}`} aria-label="Your profile" onSubmit={handleProfileSubmit}>
          {!profileEditorOpen ? (
            <div className="profile-summary">
              <div className="avatar" aria-hidden="true">
                {getInitials(state?.profile.displayName ?? profileDraft)}
              </div>
              <div className="profile-summary-copy">
                <span className="eyebrow">YOUR PROFILE</span>
                <strong>{profileDraft}</strong>
                <small><span className={`presence-dot ${statusDraft}`} aria-hidden="true" />{statusDraft}</small>
              </div>
              <button
                className="quiet-button"
                type="button"
                aria-expanded={profileEditorOpen}
                onClick={() => setProfileEditorOpen(true)}
              >
                Edit
              </button>
            </div>
          ) : (
            <>
              <div className="profile-edit-heading">
                <span className="avatar" aria-hidden="true">{getInitials(profileDraft)}</span>
                <strong>Edit your profile</strong>
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
              <div className="profile-actions">
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() => {
                    setProfileDraft(state?.profile.displayName ?? 'Basil');
                    setStatusDraft(state?.profile.status ?? 'available');
                    setProfileEditorOpen(false);
                  }}
                >
                  Cancel
                </button>
                <button className="secondary-button" type="submit">Save profile</button>
              </div>
            </>
          )}
          <button
            className="theme-toggle"
            type="button"
            role="switch"
            aria-label="Dark theme"
            aria-checked={theme === 'dark'}
            onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M17.1 12.8A7.7 7.7 0 0 1 7.2 2.9 7.8 7.8 0 1 0 17.1 12.8Z" />
            </svg>
            <span>Dark theme</span>
            <span className="theme-switch-track" aria-hidden="true"><span /></span>
          </button>
        </form>
      </aside>

      <section className="pane chat-pane" aria-label="Active conversation">
        <header className="chat-header">
          <div className="chat-actions">
            <button
              className="panel-toggle conversations-toggle"
              ref={panelTriggerRef}
              type="button"
              aria-controls="left-pane"
              aria-expanded={responsivePanel === 'conversations'}
              onClick={(event) => {
                panelTriggerRef.current = event.currentTarget;
                setResponsivePanel((current) => current === 'conversations' ? null : 'conversations');
              }}
            >
              Chats
            </button>
            <button
              className="panel-toggle details-toggle"
              ref={panelTriggerRef}
              type="button"
              aria-controls="right-pane"
              aria-expanded={responsivePanel === 'details'}
              onClick={(event) => {
                panelTriggerRef.current = event.currentTarget;
                setRoomSettingsOpen(false);
                setResponsivePanel((current) => current === 'details' ? null : 'details');
              }}
            >
              <span className="details-button-mark" aria-hidden="true" />
              Room info
            </button>
          </div>
          <div className="avatar" aria-hidden="true">
            {getInitials(activeConversation?.title ?? 'Broadcast')}
          </div>
          <div className="chat-heading">
            <h2>{activeConversation?.title ?? 'Broadcast room'}</h2>
            <p>
              {selectedPeer
                ? `${selectedPeer.address} / TCP ${selectedPeer.tcpPort}`
                : activeConversationArchived
                  ? activeConversation?.roomId
                    ? `Saved history from ${activeConversation.roomName ?? 'another room'} — join that room to send.`
                    : 'Earlier history has no saved room identity. Copy a message into a current chat to resend it.'
                : directConversationOffline
                  ? 'Peer offline — retry unsent messages when they return.'
                  : !roomJoined
                    ? 'Connect to a room to start chatting.'
                    : peers.length === 0
                      ? 'No peers in this room yet.'
                      : `${onlineCount} of ${peers.length} peers online`}
            </p>
          </div>
          {sendState ? <span className="send-state" aria-live="polite">{sendState}</span> : null}
        </header>

        <div className="message-history" aria-label="Message history" aria-live="polite">
          {!roomJoined && visibleMessages.length === 0 ? (
            <section className="welcome-state" aria-labelledby="welcome-title">
              <div className="network-illustration" aria-hidden="true">
                <svg viewBox="0 0 220 170" fill="none">
                  <path d="M56 78 105 45l56 24-8 56-64 11-33-58Z" />
                  <path d="m56 78 33 58m16-91 48 80m8-56L89 136m72-67-72 67" />
                  <circle cx="56" cy="78" r="15" />
                  <circle cx="105" cy="45" r="15" />
                  <circle cx="161" cy="69" r="15" />
                  <circle cx="153" cy="125" r="15" />
                  <circle cx="89" cy="136" r="15" />
                </svg>
                <span className="network-node node-one">Y</span>
                <span className="network-node node-two">A</span>
                <span className="network-node node-three">M</span>
              </div>
              <p className="eyebrow">PRIVATE CHATS, CLOSE TO HOME</p>
              <h2 id="welcome-title">Talk with people nearby.</h2>
              <p className="welcome-copy">
                Join the same room as your friends or teammates, then message over your local Wi-Fi.
              </p>
              <button
                className="primary-button welcome-button"
                type="button"
                onClick={(event) => {
                  panelTriggerRef.current = event.currentTarget;
                  setRoomSettingsOpen(true);
                  setResponsivePanel('details');
                }}
              >
                Connect to a room <span className="button-arrow" aria-hidden="true" />
              </button>
              <span className="welcome-note">Your room passphrase is only used for this session.</span>
            </section>
          ) : visibleMessages.length > 0 ? (
            visibleMessages.map((message, index) => {
              const currentDate = new Date(message.createdAt);
              const previousMessage = visibleMessages[index - 1];
              const startsDay = !previousMessage ||
                !isSameCalendarDay(currentDate, new Date(previousMessage.createdAt));

              return (
                <Fragment key={message.id}>
                  {startsDay ? (
                    <div className="day-divider">
                      <span>{formatConversationDay(message.createdAt)}</span>
                    </div>
                  ) : null}
                  <MessageBubble
                    message={message}
                    canSend={canSend}
                    archived={activeConversationArchived}
                    peerOnline={!activeConversation?.peerId || Boolean(selectedPeer)}
                    retrying={retryingMessageId === message.id}
                    onRetry={() => void handleRetryMessage(message.id)}
                    onCopy={() => void handleCopyMessage(message.body)}
                  />
                </Fragment>
              );
            })
          ) : (
            <div className="empty-thread">
              <span className="empty-thread-mark" aria-hidden="true">#</span>
              <strong>No messages yet</strong>
              <span>Say hello to everyone in the room to get things going.</span>
            </div>
          )}
        </div>

        {canSend ? (
          <form className="composer" onSubmit={handleSend}>
            <textarea
              aria-label="Message"
              placeholder={`Message ${activeConversation?.title ?? 'Broadcast room'}`}
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" disabled={!draft.trim()}>
              Send <span className="send-arrow" aria-hidden="true" />
            </button>
          </form>
        ) : null}
      </section>

      <aside
        id="right-pane"
        className="pane right-pane"
        aria-label={roomSettingsOpen ? 'Room settings' : 'Room and peer details'}
        aria-labelledby="drawer-title"
      >
        <header className="detail-pane-header">
          <div>
            <span className="eyebrow">{roomSettingsOpen ? 'CONNECTION' : 'AT A GLANCE'}</span>
            <h2 id="drawer-title">{roomSettingsOpen ? 'Room settings' : 'Room info'}</h2>
          </div>
          <button
            className="pane-close"
            ref={detailsCloseRef}
            type="button"
            onClick={() => {
              setResponsivePanel(null);
              setRoomSettingsOpen(false);
            }}
          >
            Close
          </button>
        </header>
        {roomSettingsOpen ? (
          <div className="drawer-scroll settings-view">
            <div className="settings-intro">
              <span className="settings-icon" aria-hidden="true">#</span>
              <p>Use the same room name and passphrase as the people you want to reach.</p>
            </div>
            <form className="connection-form" onSubmit={handleJoinRoom} noValidate>
              <div className="section-heading">
                <span>Room connection</span>
                <span className={`connection-pill ${roomStatusTone}`} aria-live="polite">{roomState}</span>
              </div>
              <label>
                Room name
                <input id="room-name" autoComplete="off" value={roomDraft} onChange={(event) => setRoomDraft(event.target.value)} />
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
                <span className="field-note">Used for this session only. It isn’t saved after you quit.</span>
              </label>
              <details className="advanced-settings" ref={portSettingsRef}>
                <summary>Advanced port settings</summary>
                <fieldset className="port-settings" aria-describedby="port-settings-help">
                  <legend>Network ports</legend>
                  <span className="field-note" id="port-settings-help">Change these only if the default ports are already in use.</span>
                  <div className="port-input-grid">
                    {(['udpPort', 'tcpPort'] as const).map((field) => {
                      const isUdp = field === 'udpPort';
                      const inputId = isUdp ? 'udp-port' : 'tcp-port';
                      const helperId = `${inputId}-help`;
                      const errorId = `${inputId}-error`;
                      const error = portErrors[field];
                      const label = PORT_FIELD_LABELS[field];
                      const value = isUdp ? udpPortDraft : tcpPortDraft;
                      const defaultPort = isUdp ? DEFAULT_DISCOVERY_PORT : DEFAULT_TCP_PORT;

                      return (
                        <label htmlFor={inputId} key={field}>
                          {label}
                          <input
                            id={inputId}
                            type="number"
                            inputMode="numeric"
                            min={MIN_PORT}
                            max={MAX_PORT}
                            step={1}
                            required
                            value={value}
                            aria-describedby={error ? `${helperId} ${errorId}` : helperId}
                            aria-invalid={error ? 'true' : undefined}
                            onBlur={(event) => handlePortBlur(field, event.target.value)}
                            onChange={(event) => handlePortChange(field, event.target.value)}
                          />
                          <span className="field-note" id={helperId}>Default: {defaultPort.toLocaleString()} · {PORT_RANGE_HELPER}</span>
                          {error ? <span className="field-error" id={errorId} role="alert">{error}</span> : null}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              </details>
              <button className="primary-button" type="submit">
                {roomJoined ? 'Reconnect to room' : 'Join room'} <span className="button-arrow" aria-hidden="true" />
              </button>
            </form>
          </div>
        ) : (
          <div className="drawer-scroll">
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

        <section className="detail-section room-action-section">
          <p className="muted-copy">Need to join another room or update your connection?</p>
          <button className="secondary-button wide" type="button" onClick={() => setRoomSettingsOpen(true)}>
            Open room settings <span className="button-arrow" aria-hidden="true" />
          </button>
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
                onClick={() => copyText(command.command, `${command.protocol.toUpperCase()} command copied.`)}
              >
                <span className="copy-protocol">{command.protocol.toUpperCase()}</span>
                <code>{command.command}</code>
                <span className="copy-action">Copy</span>
              </button>
            ))}
          </div>
          <button
            className="secondary-button wide"
            type="button"
            aria-label="Copy both firewall commands"
            onClick={() => copyText(ufwScript, 'Firewall commands copied.')}
          >
            Copy both commands
          </button>
          {copyState ? <p className="copy-feedback" role="status" aria-live="polite">{copyState}</p> : null}
        </section>

        <section className="detail-section events-section">
          <div className="section-heading">
            <span>Network events</span>
            <strong>{events.length}</strong>
          </div>
          {events.length ? (
            <ol className="event-timeline" aria-label="Recent network events">
              {events.map((event) => (
                <li className={event.level} key={event.id}>
                  <span>{formatTime(event.createdAt)}</span>
                  <p>{event.message}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty-note">No network events yet.</p>
          )}
        </section>
          </div>
        )}
      </aside>
    </main>
  );
};
