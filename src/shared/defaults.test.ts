import { describe, expect, it } from 'vitest';
import { createInitialAppState, DEFAULT_DISCOVERY_PORT, DEFAULT_TCP_PORT } from './defaults';
import { UCHAT_IPC } from './ipc';

describe('Part 1 shared defaults', () => {
  it('creates an app shell state without joining a network room', () => {
    const state = createInitialAppState();

    expect(state.appName).toBe('Uchat');
    expect(state.room.joined).toBe(false);
    expect(state.room.udpPort).toBe(DEFAULT_DISCOVERY_PORT);
    expect(state.room.tcpPort).toBe(DEFAULT_TCP_PORT);
    expect(state.peers).toEqual([]);
  });

  it('keeps preload IPC channels unique', () => {
    const channels = Object.values(UCHAT_IPC);

    expect(new Set(channels).size).toBe(channels.length);
  });
});

