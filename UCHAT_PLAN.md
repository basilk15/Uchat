# Uchat LAN Messenger Plan

## Summary

Build Uchat as a lightweight Linux Electron desktop app for people on the same WiFi or LAN. The first implementation should scaffold the app cleanly with Electron, Vite, React, TypeScript, and pnpm.

Existing LAN messengers point to the same core pattern: serverless local discovery plus direct peer communication. References checked:

- BeeBEEP: serverless LAN chat with encryption.
- Squiggle: peer discovery via multicast and direct local communication.
- iptux: intranet auto-detection plus message and file send.

Target UI direction:

![Uchat desktop UI concept](/home/basil/.codex/generated_images/019f31d6-876e-7293-bdcf-d62e5a7d1914/ig_0ddfbf1e96dcf660016a4a331f20d08191b4386251b7cff81a.png)

## Architecture

Create a three-process Electron structure:

- `main`: networking, crypto, database, and app lifecycle.
- `preload`: small typed IPC bridge only.
- `renderer`: React UI with no direct socket access.

Use one Electron `BrowserWindow` and keep the app Linux-first for v1.

## Networking

Use UDP multicast or broadcast only for discovery and presence.

- Default discovery port: `47475`.
- Broadcast peer identity, TCP port, status, capabilities, protocol version, public key, and room fingerprint.
- Send heartbeats every few seconds.
- Mark peers stale after missed heartbeats.

Use TCP for actual chat delivery.

- Default TCP port: `47476`.
- Use length-prefixed encrypted frames.
- Avoid raw newline-delimited JSON for the transport.
- Reuse one peer connection per remote device for direct and broadcast messages.

## Security

Use passphrase-secured rooms for the MVP.

- User enters a room name and passphrase on launch.
- Derive a room key with Node `crypto.scrypt`.
- Use X25519 key exchange plus HKDF to derive per-peer session keys.
- Encrypt message frames with AES-256-GCM.
- Do not store the passphrase by default.

The v1 security goal is practical LAN privacy, not enterprise-grade identity management.

## Persistence

Add local persistence under Electron `userData`.

- Store peers, conversations, messages, delivery status, and settings.
- Keep history local-only.
- Do not add cloud sync.
- Do not promise offline delivery in v1.

SQLite is the intended database for the full app. During early phases, an in-memory adapter or simple local JSON-backed adapter may be used only if it is isolated behind the same storage interface and replaced before MVP completion.

## User Interface

Build a compact three-pane desktop UI.

- Left pane: local profile, LAN status, peers, and broadcast room.
- Main pane: active conversation, message list, composer, and send state.
- Right pane: peer details, room security, current port, and network events.

Keep the UI practical, dense, and readable. Do not build a marketing landing page.

## Renderer API

Expose the app API through preload:

- `getAppState()`
- `setProfile({ displayName, status })`
- `joinRoom({ roomName, passphrase, udpPort?, tcpPort? })`
- `listPeers()`
- `listConversations()`
- `sendMessage({ conversationId, body })`
- `onPeerUpdated(callback)`
- `onMessageReceived(callback)`
- `onNetworkEvent(callback)`

The renderer must not access Node sockets or filesystem APIs directly.

## Protocol Families

Discovery messages:

- `peer.hello`
- `peer.goodbye`
- `peer.heartbeat`

TCP session messages:

- `session.hello`
- `session.ready`
- `session.error`

Chat messages:

- `chat.message`
- `chat.ack`
- `chat.typing`

## MVP Behavior

- Broadcast chat means sending to every currently online peer in the same room.
- If a peer is offline, messages are marked unsent rather than queued forever.
- If ports are blocked by the Linux firewall, show the exact port status and a copyable `ufw` command.
- The app must not modify firewall rules automatically.

## Lightweight Constraints

- One Electron window.
- No heavy UI framework or large component kit.
- React plus plain CSS or CSS modules.
- Use lucide icons only where useful.
- Tune idle networking timers to avoid constant CPU churn.
- No file sharing, voice, screen sharing, tray background mode, account system, or cross-subnet bridging in v1.

## Test Plan

Unit tests:

- Discovery packet validation and version mismatch handling.
- Room fingerprint matching and rejection.
- TCP frame encoding and decoding.
- Crypto round trip and failed decrypt path.
- Message persistence and delivery status transitions.

Integration tests:

- Start two local peer services on loopback with different ports.
- Verify discovery, session handshake, message send, ack, and peer timeout.
- Verify wrong passphrase peers are ignored.

App tests:

- Launch Electron app.
- Join room.
- Show LAN status and configured ports.
- Render peers, conversations, and messages correctly.
- Verify renderer cannot access Node sockets directly.

Manual LAN acceptance:

- Run Uchat on two Linux machines on the same WiFi.
- Both discover each other without typing IPs.
- Send direct and broadcast messages.
- Restart one app and confirm local history remains.
- Confirm wrong passphrase prevents communication.

## Assumptions

- First version targets Linux desktop only.
- Electron is fixed as the desktop framework even though Tauri would be lighter.
- MVP is serverless P2P, not host-room based.
- UDP is for discovery and presence.
- TCP is for reliable chat.
- File transfer, voice, screen sharing, cross-subnet bridging, mobile support, and account systems are deferred.
- Passphrase encryption is good enough for v1 LAN privacy, but not marketed as enterprise-grade security.
