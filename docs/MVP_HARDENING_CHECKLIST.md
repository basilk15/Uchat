# Uchat MVP Hardening Checklist

Use this checklist before tagging a LAN-testable MVP build. It is intentionally Linux-first and does not ask the app to mutate firewall rules.

## Production Packaging

- Current build command: `pnpm build`.
- Packaging status: not enabled in this pass because the project does not yet include a packaging dependency, and adding one changes the dependency graph beyond the existing green MVP baseline.
- Next packaging evaluation: run `pnpm add -D electron-builder`, then add a `dist:linux` script such as `pnpm build && electron-builder --linux AppImage dir`.
- Suggested package metadata to evaluate with `electron-builder`: `appId=local.uchat.app`, `productName=Uchat`, `directories.output=release`, and Linux targets `AppImage` plus unpacked `dir`.
- Icon follow-up: add a 512x512 PNG at `build/icon.png` and point the Linux packaging config at that path.

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
