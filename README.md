<div align="center">
  <h1>Uchat</h1>
  <p><img src="assets/uchat-logo.svg" alt="Uchat logo" width="180"></p>
</div>

Lightweight, private-by-design LAN messaging for Linux desktops. Uchat discovers peers on the local network and sends encrypted direct or broadcast messages without a central server.

> Early alpha: built for trusted LANs and active development.

## Highlights

- UDP peer discovery with heartbeat and goodbye handling
- Encrypted X25519/AES-GCM TCP sessions
- Direct and broadcast messaging with recipient-bound acknowledgements and delivery timeouts
- SQLite-backed conversations, messages, profiles, and network events
- Runtime validation at IPC, storage, discovery, TCP, and simulator boundaries
- Linux Electron desktop app with AppImage packaging and a peer simulator for testing

## Development

Requirements: Linux, Node.js 20+, and pnpm 9+.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm dev
```

Build a Linux package with:

```bash
pnpm dist:linux
```

The app uses UDP broadcast for discovery and TCP for encrypted sessions. Devices must be on the same LAN and permit the configured UDP/TCP ports through their firewall.

## Project layout

- `src/main` — Electron main process, discovery, TCP sessions, crypto, and SQLite storage
- `src/preload` — typed, narrow IPC bridge
- `src/renderer` — React desktop UI
- `src/dev` — LAN peer simulator and HTTP test bridge
- `scripts` — resilience and load checks

## License

Not yet licensed for redistribution. See the repository history for current development status.
