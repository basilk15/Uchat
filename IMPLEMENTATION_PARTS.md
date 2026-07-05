# Uchat Implementation Parts

This breaks Uchat into practical checkpoints. Each part should leave the project runnable or at least testable before moving on.

## Part 1: Project Scaffold

Goal: create the base Electron app without networking yet.

Deliverables:

- pnpm project with Electron, Vite, React, TypeScript, and Vitest.
- Separate `main`, `preload`, and `renderer` source folders.
- One Linux desktop window that loads the React app.
- Strict preload bridge with a stubbed `window.uchat` API.
- Basic app scripts: `dev`, `build`, `test`, `typecheck`, and `lint` if practical.

Acceptance:

- `pnpm install` works.
- `pnpm dev` opens Uchat.
- Renderer cannot directly access Node APIs.
- `pnpm test` and `pnpm typecheck` pass.

## Part 2: UI Shell

Goal: build the three-pane desktop interface with local mock state.

Deliverables:

- Left pane with profile, LAN status, peers, and broadcast room.
- Main chat pane with message history, composer, and send button.
- Right pane with peer details, room security, port status, and network events.
- Responsive behavior for smaller laptop widths.
- Light, compact Linux desktop styling based on the approved concept.

Acceptance:

- App is usable with mock peers and mock messages.
- Selecting peers changes the active conversation.
- Sending a message updates local UI state.
- No networking is required yet.

## Part 3: Core Domain and Storage

Goal: define the app data model and persistence boundary before real networking.

Deliverables:

- Shared TypeScript types for peers, conversations, messages, settings, and network events.
- Storage interface used by the main process.
- SQLite-backed implementation under Electron `userData`.
- Message delivery states: `sending`, `sent`, `delivered`, `failed`, and `unsent`.
- Tests for persistence and state transitions.

Acceptance:

- Messages survive app restart.
- Profile and port settings survive app restart.
- Tests prove storage can create, list, and update conversations/messages.

## Part 4: Crypto and Room Identity

Goal: create the security primitives without connecting them to real sockets yet.

Deliverables:

- Room key derivation using `crypto.scrypt`.
- Room fingerprint generation for discovery filtering.
- X25519 key generation and shared secret derivation.
- HKDF-derived per-peer session keys.
- AES-256-GCM encrypt/decrypt helpers.
- Tests for successful decrypt and wrong-key failure.

Acceptance:

- Two generated peers can derive the same session key.
- Encrypted frames decrypt only with the correct room/session material.
- Wrong passphrase produces a different fingerprint and fails decryption.

## Part 5: UDP Discovery

Goal: detect peers on the same LAN without sending chat messages yet.

Deliverables:

- UDP discovery service in the main process.
- Default discovery port `47475`, with user-configurable override.
- `peer.hello`, `peer.heartbeat`, and `peer.goodbye` packets.
- Peer stale timeout logic.
- Discovery packet validation and version checks.
- IPC events from main to renderer for peer updates and network events.

Acceptance:

- Two local Uchat instances with the same room passphrase discover each other.
- Instances with different passphrases ignore each other.
- Peer list updates when one instance exits.
- Unit tests cover packet validation and stale timeout behavior.

## Part 6: TCP Session and Framing

Goal: establish reliable peer connections and exchange encrypted protocol frames.

Deliverables:

- TCP server on default port `47476`, with fallback/configurable port handling.
- TCP client connection manager.
- Length-prefixed frame encoder and decoder.
- Session handshake messages: `session.hello`, `session.ready`, and `session.error`.
- Encrypted frame transport after session setup.
- Tests for frame parsing, partial frames, multiple frames, and invalid frame sizes.

Acceptance:

- Two local peer services can establish a session after discovery.
- Session fails cleanly when room/session crypto does not match.
- Frame parser handles chunked TCP data correctly.

## Part 7: Chat Delivery

Goal: make real messages flow between peers.

Deliverables:

- `sendMessage({ conversationId, body })` implementation.
- `chat.message`, `chat.ack`, and optional `chat.typing` messages.
- Direct one-to-one chat.
- Broadcast chat to all currently online room peers.
- Delivery state updates in storage and UI.
- Unsent state for offline peers.

Acceptance:

- Two machines or two local app instances can exchange messages.
- Broadcast sends to all online peers in the same room.
- UI shows sent, delivered, failed, and unsent states correctly.
- Received messages persist locally.

## Part 8: Ports, Firewall UX, and Reliability

Goal: make the app understandable when LAN networking is blocked or misconfigured.

Deliverables:

- Port availability checks for UDP and TCP ports.
- Clear network event timeline in the right pane.
- Copyable `ufw` command for the selected ports.
- No automatic firewall modification.
- Better error states for port-in-use, no LAN interface, and discovery blocked.

Acceptance:

- If TCP port is occupied, the app reports it and suggests next action.
- If discovery is not working, the app shows a useful status instead of silently failing.
- The user can copy firewall commands but the app never runs them.

## Part 9: MVP Hardening

Goal: polish the app enough for real LAN testing.

Deliverables:

- App icon and Linux packaging path.
- Production build configuration.
- Startup and shutdown cleanup for UDP/TCP services.
- Basic accessibility checks for keyboard navigation and focus states.
- CPU and memory sanity checks while idle and while chatting.
- Final manual LAN test checklist.

Acceptance:

- Production build launches on Linux.
- App shuts down cleanly and sends `peer.goodbye`.
- Idle CPU usage stays low.
- Two Linux machines on the same WiFi pass the manual acceptance test.

## Recommended Build Order

Start with Parts 1 and 2 together because they create something visible and runnable. Then do Parts 3 and 4 to lock the data and security foundation. After that, build networking in order: discovery, TCP sessions, chat delivery, reliability.

Avoid starting with real LAN sockets before the app shell, storage boundary, and crypto helpers exist. It will be harder to debug because every failure could be UI, state, protocol, or network at the same time.
