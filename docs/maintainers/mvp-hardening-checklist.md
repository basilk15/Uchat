# MVP Hardening Checklist

Use this checklist before tagging a LAN-testable MVP build. It is Linux-first and does not ask the app to mutate firewall rules.

## Production packaging

- Build: `pnpm build`
- Unpacked Linux package: `pnpm pack:linux`
- AppImage and unpacked package: `pnpm dist:linux`
- Packaging tool: `electron-builder`
- Linux targets: AppImage and unpacked `dir`
- Native dependency: `better-sqlite3` must remain external to the Electron main bundle and its `.node` files must be unpacked.
- Electron ABI: packaging rebuilds native dependencies for Electron; `pnpm rebuild:sqlite-electron` stages the local native binding.
- A branded `build/icon.png` should be added before a production release.

## Startup and shutdown

- Joining a room reports UDP discovery and TCP listener startup.
- Closing the window runs app cleanup.
- UDP shutdown sends `peer.goodbye` before closing the socket.
- TCP shutdown closes active sessions and the listener.
- Local storage closes after cleanup.

## Accessibility smoke check

- Tab through profile, room join, conversations, composer, firewall controls, and network events.
- Confirm every focused control has a visible focus indicator.
- Confirm selected conversations are announced as pressed buttons.
- Confirm the composer can be reached and submitted from the keyboard.
- Confirm network and send-state updates do not rely on color alone.

## CPU and memory sanity

- Leave the app idle for five minutes and record Electron CPU/RSS.
- Send direct and broadcast messages for two minutes and record CPU/RSS again.
- CPU should settle near idle between heartbeat intervals, and memory should remain stable.
- If CPU stays high, inspect heartbeat/stale timers and reconnect attempts first.

## Manual LAN acceptance

- Two machines are on the same Wi-Fi or wired LAN.
- Both launch the production build and join the same room.
- Discovery works without entering an IP address.
- Direct and broadcast messages are delivered and show their delivery states.
- Message history survives an app restart.
- A wrong passphrase does not discover or decrypt chat with the room.
- Firewall failures show copyable `ufw allow` commands without changing firewall rules.

## Single-machine peer harness

- Run `pnpm peer:sim -- --room "Uchat Lab" --passphrase "demo" --web` alongside `pnpm dev`.
- Confirm discovery, direct chat, acknowledgements, and the phone browser bridge.
- Confirm the harness uses normal UDP/TCP sockets and does not modify firewall rules.
