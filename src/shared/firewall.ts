import { isValidPort, MAX_PORT, MIN_PORT } from './validation';

export type FirewallProtocol = 'udp' | 'tcp';

export interface FirewallPortConfig {
  udpPort: number;
  tcpPort: number;
}

export interface UfwAllowCommand {
  protocol: FirewallProtocol;
  port: number;
  command: string;
}

const assertValidPort = (port: number, label: string): void => {
  if (!isValidPort(port)) {
    throw new RangeError(`${label} must be an integer from ${MIN_PORT} to ${MAX_PORT}.`);
  }
};

export const createUfwAllowCommand = (port: number, protocol: FirewallProtocol): UfwAllowCommand => {
  assertValidPort(port, `${protocol.toUpperCase()} port`);

  return {
    protocol,
    port,
    command: `sudo ufw allow ${port}/${protocol}`
  };
};

export const createUfwAllowCommands = (config: FirewallPortConfig): UfwAllowCommand[] => [
  createUfwAllowCommand(config.udpPort, 'udp'),
  createUfwAllowCommand(config.tcpPort, 'tcp')
];

export const createCopyableUfwAllowScript = (config: FirewallPortConfig): string =>
  createUfwAllowCommands(config)
    .map(({ command }) => command)
    .join('\n');
