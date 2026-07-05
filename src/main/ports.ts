import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export type PortProtocol = 'udp' | 'tcp';

export interface ConfiguredPorts {
  udpPort: number;
  tcpPort: number;
}

export interface PortAvailabilityResult {
  protocol: PortProtocol;
  port: number;
  available: boolean;
  code?: string;
  message?: string;
}

export interface ConfiguredPortAvailability {
  udp: PortAvailabilityResult;
  tcp: PortAvailabilityResult;
}

export interface LanInterfaceSummary {
  name: string;
  address: string;
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error;

const unavailableResult = (
  protocol: PortProtocol,
  port: number,
  error: unknown
): PortAvailabilityResult => {
  const nodeError = isNodeError(error) ? error : undefined;

  return {
    protocol,
    port,
    available: false,
    code: nodeError?.code,
    message: nodeError?.message ?? 'Unknown bind failure.'
  };
};

export const checkTcpPortAvailable = (port: number, host?: string): Promise<PortAvailabilityResult> =>
  new Promise((resolve) => {
    const server = createServer();
    let settled = false;

    server.unref();

    const finish = (result: PortAvailabilityResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(result);
    };

    server.once('error', (error) => {
      finish(unavailableResult('tcp', port, error));
    });

    server.listen({ port, host }, () => {
      server.close(() => {
        finish({
          protocol: 'tcp',
          port,
          available: true
        });
      });
    });
  });

export const checkUdpPortAvailable = (port: number, host?: string): Promise<PortAvailabilityResult> =>
  new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: false });
    let settled = false;

    socket.unref();

    const finish = (result: PortAvailabilityResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(result);
    };

    socket.once('error', (error) => {
      finish(unavailableResult('udp', port, error));
    });

    socket.bind(port, host, () => {
      socket.close(() => {
        finish({
          protocol: 'udp',
          port,
          available: true
        });
      });
    });
  });

export const checkConfiguredPortAvailability = async (
  ports: ConfiguredPorts
): Promise<ConfiguredPortAvailability> => {
  const [udp, tcp] = await Promise.all([
    checkUdpPortAvailable(ports.udpPort),
    checkTcpPortAvailable(ports.tcpPort)
  ]);

  return { udp, tcp };
};

export const getUsableLanInterfaces = (
  interfaces = networkInterfaces()
): LanInterfaceSummary[] =>
  Object.entries(interfaces).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((entry): entry is NetworkInterfaceInfo =>
        Boolean(entry && entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'))
      )
      .map((entry) => ({
        name,
        address: entry.address
      }))
  );

export const describePortUnavailable = (result: PortAvailabilityResult): string => {
  const protocolLabel = result.protocol.toUpperCase();
  const nextAction =
    result.code === 'EADDRINUSE'
      ? `Close the app using ${result.port}/${result.protocol} or choose a different ${protocolLabel} port.`
      : 'Check local network permissions or choose a different port.';

  return `${protocolLabel} port ${result.port} is unavailable. ${nextAction}`;
};
