<div align="center">
  <h1>Uchat</h1>
  <p><img src="assets/uchat-icon.svg" alt="Uchat logo" width="180"></p>
</div>

Lightweight, private-by-design LAN messaging for Linux desktops. Uchat discovers peers on the local network and sends encrypted direct or broadcast messages without a central server.

> Early alpha: built for trusted LANs and active development.

## Highlights

- UDP peer discovery with heartbeat and goodbye handling
- Encrypted X25519/AES-GCM TCP sessions
- Direct and broadcast messaging with sender names, recipient-bound acknowledgements, and manual retry for unsent or failed messages
- Stable peer identity within each room and separate saved history across rooms
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

Run the packaged desktop smoke check against the unpacked build:

```bash
pnpm smoke:desktop release/linux-unpacked/uchat
```

It opens the real Electron package with a temporary profile and a local LAN peer simulator, then checks discovery, direct and broadcast delivery, restart history, and room isolation. A separate two-computer LAN check is still needed before release.

The app uses UDP broadcast for discovery and TCP for encrypted sessions. Devices must be on the same LAN and permit the configured UDP/TCP ports through their firewall.

Unsent and failed messages can be retried after reconnecting to the same room. Broadcast messages are not replayed automatically to people who join later. History written by older Uchat versions is kept as an archive because those records did not store a room identity; copy an archived unsent message into the intended chat to resend it.

## Project layout

- `src/main` — Electron main process, discovery, TCP sessions, crypto, and SQLite storage
- `src/preload` — typed, narrow IPC bridge
- `src/renderer` — React desktop UI
- `src/dev` — LAN peer simulator and HTTP test bridge
- `scripts` — resilience and load checks
- `docs/testing` — local LAN and peer-simulator testing
- `docs/maintainers` — release and MVP hardening checks

## Documentation

- [Local LAN testing](docs/testing/peer-simulator.md)
- [MVP hardening checklist](docs/maintainers/mvp-hardening-checklist.md)

## License

Not yet licensed for redistribution. See the repository history for current development status.
