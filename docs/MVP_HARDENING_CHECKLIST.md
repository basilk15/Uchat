# Uchat MVP Hardening Checklist

Use this checklist before tagging a LAN-testable MVP build. It is intentionally Linux-first and does not ask the app to mutate firewall rules.

## Production Packaging

- Current build command: `pnpm build`.
- Unpacked Linux package command: `pnpm pack:linux`.
- AppImage plus unpacked Linux package command: `pnpm dist:linux`.
- Packaging tool: `electron-builder`.
- Package metadata: `appId=local.uchat.app`, `productName=Uchat`, `desktopName=Uchat`, `directories.output=release`, Linux category `Network`, and Linux targets `AppImage` plus unpacked `dir`.
- Packaging output directory: `release/`.
- Current artifact path after a successful `pnpm dist:linux`: `release/Uchat-0.1.0-x86_64.AppImage`.
- Current unpacked app path after a successful `pnpm dist:linux`: `release/linux-unpacked/uchat`.
- Native dependency note: `better-sqlite3` must stay external to the Electron main bundle, be included with its runtime helper packages, and have `.node` files unpacked from `app.asar`.
- Electron ABI note: `pnpm dist:linux` runs Electron Builder's native dependency rebuild for the packaged Electron runtime. `pnpm rebuild:sqlite-electron` also stages an Electron ABI copy under `native/` while restoring the local Node ABI for Vitest.
- Icon status: no custom icon is configured yet. The current packaging pass relies on the default Electron icon; add a 512x512 PNG at `build/icon.png` before a branded public release.

## Startup And Shutdown

- Join a room and confirm the network event timeline reports UDP discovery and TCP listener startup.
- Close the window and confirm the Electron `before-quit` path calls app cleanup.
- Confirm UDP shutdown sends `peer.goodbye` before closing the socket.
- Confirm TCP shutdown closes active peer sessions and the listener.
- Confirm local storage is closed after cleanup.

## Accessibility Smoke Check

- Tab through profile, room join, conversation selection, composer, firewall copy buttons, and network events without using a mouse.
- Confirm every focused button/input/select/textarea has a visible focus indicator.
- Confirm selected broadcast/direct conversations are announced as pressed buttons.
- Confirm the composer can be reached and submitted from the keyboard.
- Confirm network status and send state updates are visible without relying on color alone.

## CPU And Memory Sanity

- Idle check: start the app, join a room, leave it idle for 5 minutes, and record Electron CPU and RSS with `ps -o pid,pcpu,rss,comm -C electron`.
- Chat check: send direct and broadcast messages for 2 minutes, then run the same `ps` command.
- Expected MVP result: CPU should settle near idle between heartbeat intervals, memory should remain stable rather than climbing every message.
- If CPU stays high, inspect heartbeat/stale timers and repeated reconnect attempts first.

## Manual LAN Acceptance

- Machine A and Machine B are on the same WiFi or wired LAN.
- Both machines launch the production build.
- Both join the same room name and passphrase.
- Discovery: each machine appears in the peer list without typing an IP address.
- Direct chat: A sends to B, B receives it, and A sees the delivery state progress.
- Broadcast: A sends to broadcast, and all online same-room peers receive it.
- Persistence: restart one app and confirm prior local messages remain visible.
- Wrong passphrase: a third instance or one restarted app with a different passphrase does not appear in the room and cannot decrypt chat.
- Firewall UX: if discovery or TCP chat fails, the app displays UDP/TCP ports and copyable `ufw allow` commands, but does not run them.

## Single-Machine Peer Harness

- Run `pnpm peer:sim -- --room "Uchat Lab" --passphrase "demo" --web` on the laptop while `pnpm dev` is running.
- Confirm the desktop app discovers the simulator and can exchange direct messages with it.
- Confirm `curl -X POST http://127.0.0.1:8787/api/message -H 'content-type: application/json' -d '{"body":"hello"}'` sends a message into the app.
- Open the printed LAN URL on a phone browser and confirm the browser page can send a message to the app through the simulator.
- Confirm the harness only uses normal UDP/TCP sockets and does not modify firewall rules.
