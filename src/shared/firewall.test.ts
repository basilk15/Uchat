import { describe, expect, it } from 'vitest';
import { DEFAULT_DISCOVERY_PORT, DEFAULT_TCP_PORT } from './defaults';
import { createCopyableUfwAllowScript, createUfwAllowCommand, createUfwAllowCommands } from './firewall';

describe('Part 8 firewall command helper', () => {
  it('creates copyable ufw allow commands for the configured UDP and TCP ports', () => {
    expect(
      createUfwAllowCommands({
        udpPort: DEFAULT_DISCOVERY_PORT,
        tcpPort: DEFAULT_TCP_PORT
      })
    ).toEqual([
      {
        protocol: 'udp',
        port: DEFAULT_DISCOVERY_PORT,
        command: `sudo ufw allow ${DEFAULT_DISCOVERY_PORT}/udp`
      },
      {
        protocol: 'tcp',
        port: DEFAULT_TCP_PORT,
        command: `sudo ufw allow ${DEFAULT_TCP_PORT}/tcp`
      }
    ]);
  });

  it('formats the combined copy text without running any firewall command', () => {
    expect(
      createCopyableUfwAllowScript({
        udpPort: 50000,
        tcpPort: 50001
      })
    ).toBe('sudo ufw allow 50000/udp\nsudo ufw allow 50001/tcp');
  });

  it('rejects invalid port values', () => {
    expect(() => createUfwAllowCommand(0, 'udp')).toThrow(RangeError);
    expect(() => createUfwAllowCommand(65536, 'tcp')).toThrow('TCP port must be an integer from 1 to 65535.');
    expect(() => createUfwAllowCommand(47475.5, 'udp')).toThrow('UDP port must be an integer from 1 to 65535.');
  });
});
