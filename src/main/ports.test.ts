import { createSocket } from 'node:dgram';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkTcpPortAvailable,
  checkUdpPortAvailable,
  describePortUnavailable,
  getUsableLanInterfaces
} from './ports';

const tcpServers: Server[] = [];
const udpSockets: ReturnType<typeof createSocket>[] = [];

const listenTcp = (): Promise<{ server: Server; port: number }> =>
  new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      tcpServers.push(server);
      resolve({
        server,
        port: (server.address() as AddressInfo).port
      });
    });
  });

const listenUdp = (reuseAddr = false): Promise<{ socket: ReturnType<typeof createSocket>; port: number }> =>
  new Promise((resolve, reject) => {
    const socket = createSocket({ type: 'udp4', reuseAddr });

    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      udpSockets.push(socket);
      resolve({
        socket,
        port: (socket.address() as AddressInfo).port
      });
    });
  });

afterEach(async () => {
  await Promise.all(
    tcpServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        })
    )
  );

  await Promise.all(
    udpSockets.splice(0).map(
      (socket) =>
        new Promise<void>((resolve) => {
          socket.close(() => resolve());
        })
    )
  );
});

describe('port availability helpers', () => {
  it('rejects invalid runtime port values before attempting a bind', async () => {
    await expect(checkTcpPortAvailable(0)).rejects.toThrow('TCP port must be an integer from 1 to 65535.');
    await expect(checkUdpPortAvailable('47475' as never)).rejects.toThrow(
      'UDP port must be an integer from 1 to 65535.'
    );
  });

  it('reports an occupied TCP port as unavailable', async () => {
    const { port } = await listenTcp();

    await expect(checkTcpPortAvailable(port, '127.0.0.1')).resolves.toEqual(
      expect.objectContaining({
        protocol: 'tcp',
        port,
        available: false,
        code: 'EADDRINUSE'
      })
    );
  });

  it('reports an occupied UDP port as unavailable', async () => {
    const { port } = await listenUdp();

    await expect(checkUdpPortAvailable(port, '127.0.0.1')).resolves.toEqual(
      expect.objectContaining({
        protocol: 'udp',
        port,
        available: false,
        code: 'EADDRINUSE'
      })
    );
  });

  it('accepts a UDP port shared with another discovery peer', async () => {
    const { port } = await listenUdp(true);

    await expect(checkUdpPortAvailable(port, '127.0.0.1')).resolves.toEqual(
      expect.objectContaining({
        protocol: 'udp',
        port,
        available: true
      })
    );
  });

  it('describes the next action without running any firewall command', () => {
    expect(
      describePortUnavailable({
        protocol: 'tcp',
        port: 47476,
        available: false,
        code: 'EADDRINUSE'
      })
    ).toBe('TCP port 47476 is unavailable. Close the app using 47476/tcp or choose a different TCP port.');
  });

  it('filters usable LAN IPv4 interfaces', () => {
    expect(
      getUsableLanInterfaces({
        lo: [
          {
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: true,
            cidr: '127.0.0.1/8'
          }
        ],
        wlan0: [
          {
            address: '192.168.18.80',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:11:22:33:44:55',
            internal: false,
            cidr: '192.168.18.80/24'
          }
        ]
      })
    ).toEqual([{ name: 'wlan0', address: '192.168.18.80' }]);
  });
});
