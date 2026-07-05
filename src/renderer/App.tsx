import { useEffect, useState } from 'react';
import type { NetworkEvent, UchatAppState } from '@shared/types';

export const App = (): React.JSX.Element => {
  const [state, setState] = useState<UchatAppState | null>(null);
  const [events, setEvents] = useState<NetworkEvent[]>([]);

  useEffect(() => {
    let mounted = true;

    void window.uchat.getAppState().then((appState) => {
      if (mounted) {
        setState(appState);
        setEvents(appState.networkEvents);
      }
    });

    const unsubscribe = window.uchat.onNetworkEvent((event) => {
      setEvents((current) => [event, ...current].slice(0, 5));
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const handleStubJoin = async (): Promise<void> => {
    const nextState = await window.uchat.joinRoom({
      roomName: 'Local room',
      passphrase: 'part-one-stub'
    });
    setState({ ...nextState });
    setEvents(nextState.networkEvents);
  };

  const nodeAccessAvailable = typeof window.require === 'function' || typeof window.process !== 'undefined';

  return (
    <main className="app-shell">
      <section className="hero-panel" aria-labelledby="app-title">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            U
          </div>
          <span>Linux LAN messenger</span>
        </div>

        <div className="hero-copy">
          <h1 id="app-title">Uchat</h1>
          <p>App shell loaded through Electron, Vite, React, TypeScript, and a typed preload bridge.</p>
        </div>

        <div className="status-grid" aria-label="Application shell status">
          <div>
            <span className="label">Renderer</span>
            <strong>React ready</strong>
          </div>
          <div>
            <span className="label">Preload API</span>
            <strong>{state ? 'Connected' : 'Loading'}</strong>
          </div>
          <div>
            <span className="label">Node in renderer</span>
            <strong>{nodeAccessAvailable ? 'Exposed' : 'Blocked'}</strong>
          </div>
        </div>

        <button type="button" onClick={handleStubJoin}>
          Join stub room
        </button>
      </section>

      <aside className="detail-panel" aria-label="Stubbed Uchat state">
        <div>
          <span className="label">Profile</span>
          <strong>{state?.profile.displayName ?? 'Loading'}</strong>
        </div>
        <div>
          <span className="label">Room</span>
          <strong>{state?.room.roomName ?? 'Not joined'}</strong>
        </div>
        <div>
          <span className="label">Ports</span>
          <strong>
            UDP {state?.room.udpPort ?? 47475} / TCP {state?.room.tcpPort ?? 47476}
          </strong>
        </div>
        <div>
          <span className="label">Peers</span>
          <strong>{state?.peers.length ?? 0} online</strong>
        </div>

        <div className="event-list">
          <span className="label">Network events</span>
          {events.map((event) => (
            <p key={event.id}>{event.message}</p>
          ))}
        </div>
      </aside>
    </main>
  );
};

