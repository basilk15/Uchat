# Local LAN Test Harness

This harness tests the LAN protocol from one laptop. It does not change firewall rules and stays outside the production app.

## What it does

- Joins the same room as the desktop app.
- Starts real UDP discovery and encrypted TCP sessions.
- Auto-connects to discovered same-room peers.
- Acknowledges incoming chat frames so the desktop app can mark messages delivered.
- Optionally exposes a small browser page that a phone can open on the same Wi-Fi.

## Terminal test

1. Start the desktop app:

   ```bash
   pnpm dev
   ```

2. In the app, join a room with a name and passphrase you can reuse in the simulator.

3. Start the simulator in another terminal:

   ```bash
   pnpm peer:sim --room "Uchat Lab" --passphrase "demo" --send "hello from the laptop"
   ```

4. To expose the browser bridge, add `--web`:

   ```bash
   pnpm peer:sim --room "Uchat Lab" --passphrase "demo" --web
   ```

5. To push a message after the peer is connected:

   ```bash
   curl -X POST http://127.0.0.1:8787/api/message \
     -H 'content-type: application/json' \
     -d '{"body":"hello from curl"}'
   ```

## Phone browser test

1. Start the simulator with `--web`.
2. Open the printed `http://<laptop-lan-ip>:8787` URL on your phone.
3. Use the page to send direct or broadcast messages into the Uchat room.

If you need the laptop IP, run `hostname -I` or `ip -4 addr show scope global`.

## Port notes

- Discovery UDP port: `47475`
- Uchat TCP port: `47476`
- Simulator TCP port: ephemeral by default, so it does not collide with the app.
- If discovery is already in use, run both sides on another matching UDP port.

## Expected results

- The app discovers the simulator without an IP address.
- The simulator receives messages sent by the app.
- The app shows delivered state after the simulator acknowledges a frame.
- The phone browser can send messages using the laptop LAN IP.
