import { describe, expect, it } from 'vitest';
import { buildBrowserUrls, buildReplyBody, parsePeerSimulatorArgs } from './peerSimulator';

describe('peer simulator helpers', () => {
  it('builds browser URLs for localhost and LAN interfaces', () => {
    expect(
      buildBrowserUrls(8_787, [
        { name: 'wlan0', address: '192.168.18.80' },
        { name: 'eth0', address: '10.0.0.11' }
      ])
    ).toEqual(['http://127.0.0.1:8787', 'http://192.168.18.80:8787', 'http://10.0.0.11:8787']);
  });

  it('expands reply templates with the inbound body text', () => {
    expect(buildReplyBody('echo: {body}', 'hello from the app')).toBe('echo: hello from the app');
  });

  it('parses positional and flag-based CLI arguments', () => {
    const options = parsePeerSimulatorArgs([
      '--display-name',
      'Bot',
      '--web',
      '--peer-id',
      'peer-123',
      'Lab Room',
      'secret pass'
    ]);

    expect(options).toMatchObject({
      roomName: 'Lab Room',
      passphrase: 'secret pass',
      displayName: 'Bot',
      httpPort: 8787,
      targetPeerId: 'peer-123'
    });
  });

  it('ignores a leading pnpm separator when parsing CLI arguments', () => {
    const options = parsePeerSimulatorArgs(['--', '--room', 'Lab', '--passphrase', 'secret']);

    expect(options).toMatchObject({
      roomName: 'Lab',
      passphrase: 'secret'
    });
  });
});
