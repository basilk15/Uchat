import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { DEFAULT_DISCOVERY_PORT, DEFAULT_TCP_PORT } from '@shared/defaults';
import {
  createDiscoveryPacket,
  validateDiscoveryPacket,
  type DiscoveryPacket,
  type DiscoveryPacketType,
  type DiscoveryPeerIdentity
} from '@shared/discovery';
import type { NetworkEvent, Peer } from '@shared/types';

export const DEFAULT_DISCOVERY_BROADCAST_ADDRESS = '255.255.255.255';
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
export const DEFAULT_STALE_TIMEOUT_MS = 15_000;

export interface UdpDiscoveryServiceConfig {
  localPeer: DiscoveryPeerIdentity;
  udpPort?: number;
  broadcastAddress?: string;
  heartbeatIntervalMs?: number;
  staleTimeoutMs?: number;
}

export interface UdpDiscoveryServiceEvents {
  onPeerUpdated?(peer: Peer): void;
  onPeerRemoved?(peerId: string): void;
  onNetworkEvent?(message: string, level?: NetworkEvent['level']): void;
}

export interface PeerRegistryEntry {
  peer: Peer;
  lastSeenMs: number;
}

const toPeer = (packet: DiscoveryPacket, remoteInfo: RemoteInfo, nowMs: number): Peer => ({
  id: packet.peer.id,
  displayName: packet.peer.displayName.trim(),
  status: packet.peer.status,
  address: remoteInfo.address,
  udpPort: packet.peer.udpPort,
  tcpPort: packet.peer.tcpPort,
  publicKey: packet.peer.publicKey,
  roomFingerprint: packet.peer.roomFingerprint,
  capabilities: packet.peer.capabilities,
  lastSeenAt: new Date(nowMs).toISOString()
});

const serializePacket = (packet: DiscoveryPacket): Buffer => Buffer.from(JSON.stringify(packet));

export class DiscoveryPeerRegistry {
  private readonly peers = new Map<string, PeerRegistryEntry>();

  constructor(private readonly staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS) {}

  upsert(packet: DiscoveryPacket, remoteInfo: RemoteInfo, nowMs = Date.now()): Peer | null {
    if (packet.type === 'peer.goodbye') {
      this.remove(packet.peer.id);
      return null;
    }

    const peer = toPeer(packet, remoteInfo, nowMs);
    this.peers.set(peer.id, { peer, lastSeenMs: nowMs });
    return peer;
  }

  remove(peerId: string): boolean {
    return this.peers.delete(peerId);
  }

  pruneStale(nowMs = Date.now()): Peer[] {
    const stalePeers: Peer[] = [];

    for (const [peerId, entry] of this.peers) {
      if (nowMs - entry.lastSeenMs >= this.staleTimeoutMs) {
        stalePeers.push(entry.peer);
        this.peers.delete(peerId);
      }
    }

    return stalePeers;
  }

  list(): Peer[] {
    return Array.from(this.peers.values()).map((entry) => entry.peer);
  }
}

export class UdpDiscoveryService {
  private socket: Socket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private readonly registry: DiscoveryPeerRegistry;
  private readonly config: Required<UdpDiscoveryServiceConfig>;

  constructor(
    config: UdpDiscoveryServiceConfig,
    private readonly events: UdpDiscoveryServiceEvents = {}
  ) {
    const udpPort = config.udpPort ?? config.localPeer.udpPort ?? DEFAULT_DISCOVERY_PORT;

    this.config = {
      localPeer: {
        ...config.localPeer,
        udpPort
      },
      udpPort,
      broadcastAddress: config.broadcastAddress ?? DEFAULT_DISCOVERY_BROADCAST_ADDRESS,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      staleTimeoutMs: config.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS
    };
    this.registry = new DiscoveryPeerRegistry(this.config.staleTimeoutMs);
  }

  start(): Promise<void> {
    if (this.socket) {
      return Promise.resolve();
    }

    this.socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (message, remoteInfo) => this.handleMessage(message, remoteInfo));
    this.socket.on('error', (error) => {
      this.emitNetworkEvent(`UDP discovery error: ${error.message}`, 'error');
    });

    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('UDP discovery socket was not created.'));
        return;
      }

      this.socket.once('error', reject);
      this.socket.bind(this.config.udpPort, () => {
        if (!this.socket) {
          reject(new Error('UDP discovery socket closed before bind completed.'));
          return;
        }

        this.socket.off('error', reject);
        this.socket.setBroadcast(true);
        this.emitNetworkEvent(`UDP discovery listening on ${this.config.udpPort}.`);
        void this.send('peer.hello');
        this.heartbeatTimer = setInterval(() => {
          void this.send('peer.heartbeat');
        }, this.config.heartbeatIntervalMs);
        this.staleTimer = setInterval(() => {
          this.pruneStalePeers();
        }, this.config.staleTimeoutMs);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }

    if (!this.socket) {
      return;
    }

    await this.send('peer.goodbye');

    const socket = this.socket;
    this.socket = null;

    await new Promise<void>((resolve) => {
      socket.close(() => resolve());
    });
  }

  listPeers(): Peer[] {
    return this.registry.list();
  }

  handleMessage(message: Buffer, remoteInfo: RemoteInfo, nowMs = Date.now()): void {
    const validation = validateDiscoveryPacket(message, this.config.localPeer.roomFingerprint);

    if (!validation.ok) {
      if (validation.reason !== 'room-fingerprint-mismatch') {
        this.emitNetworkEvent(`Ignored discovery packet: ${validation.reason}.`, 'warning');
      }
      return;
    }

    if (validation.packet.peer.id === this.config.localPeer.id) {
      return;
    }

    if (validation.packet.type === 'peer.goodbye') {
      const removed = this.registry.remove(validation.packet.peer.id);
      if (removed) {
        this.events.onPeerRemoved?.(validation.packet.peer.id);
        this.emitNetworkEvent(`${validation.packet.peer.displayName} left the LAN room.`);
      }
      return;
    }

    const peer = this.registry.upsert(validation.packet, remoteInfo, nowMs);
    if (peer) {
      this.events.onPeerUpdated?.(peer);
    }
  }

  pruneStalePeers(nowMs = Date.now()): Peer[] {
    const stalePeers = this.registry.pruneStale(nowMs);

    for (const peer of stalePeers) {
      this.events.onPeerRemoved?.(peer.id);
      this.emitNetworkEvent(`${peer.displayName} went offline.`, 'warning');
    }

    return stalePeers;
  }

  private send(type: DiscoveryPacketType): Promise<void> {
    if (!this.socket) {
      return Promise.resolve();
    }

    const packet = serializePacket(createDiscoveryPacket(type, this.config.localPeer));

    return new Promise((resolve, reject) => {
      this.socket?.send(packet, this.config.udpPort, this.config.broadcastAddress, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private emitNetworkEvent(message: string, level: NetworkEvent['level'] = 'info'): void {
    this.events.onNetworkEvent?.(message, level);
  }
}

export const createLocalDiscoveryPeer = (input: {
  id: string;
  displayName: string;
  status: DiscoveryPeerIdentity['status'];
  roomFingerprint: string;
  publicKey: string;
  udpPort?: number;
  tcpPort?: number;
  capabilities?: string[];
}): DiscoveryPeerIdentity => ({
  id: input.id,
  displayName: input.displayName,
  status: input.status,
  udpPort: input.udpPort ?? DEFAULT_DISCOVERY_PORT,
  tcpPort: input.tcpPort ?? DEFAULT_TCP_PORT,
  publicKey: input.publicKey,
  roomFingerprint: input.roomFingerprint,
  capabilities: input.capabilities ?? []
});
