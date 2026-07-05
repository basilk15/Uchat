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

const MIN_PORT = 1;
const MAX_PORT = 65535;

const assertValidPort = (port: number, label: string): void => {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
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
