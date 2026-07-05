# Uchat Local Test Harness

This harness is only for testing the LAN protocol from one laptop. It does not change firewall rules and it stays outside the production app.

## What It Does

- Joins the same room as the desktop app.
- Starts a real UDP discovery service and encrypted TCP session manager.
- Auto-connects to discovered same-room peers.
- Acks incoming chat frames so the desktop app can mark messages delivered.
- Optionally exposes a tiny browser page that your phone can open on the same Wi-Fi.

## Terminal Test

1. Start the desktop app:

   ```bash
   pnpm dev
   ```

2. In the app, join a room with a name and passphrase you can reuse in the simulator.

3. Start the simulator in another terminal:

   ```bash
   pnpm peer:sim --room "Uchat Lab" --passphrase "demo" --send "hello from the laptop"
   ```

4. If you want the simulator to keep a browser page available for your phone, add `--web`:

   ```bash
   pnpm peer:sim --room "Uchat Lab" --passphrase "demo" --web
   ```

   The simulator also accepts the `--` separator form if you prefer it:

   ```bash
   pnpm peer:sim -- --room "Uchat Lab" --passphrase "demo" --web
   ```

5. To push a message after the peer is connected:

   ```bash
   curl -X POST http://127.0.0.1:8787/api/message \
     -H 'content-type: application/json' \
     -d '{"body":"hello from curl"}'
   ```

## Phone Browser Test

1. Start the simulator with the browser bridge:

   ```bash
   pnpm peer:sim --room "Uchat Lab" --passphrase "demo" --web
   ```

2. Read the printed LAN URLs. Open the `http://<laptop-lan-ip>:8787` URL on your phone.

3. If you need the laptop IP directly, `hostname -I` or `ip -4 addr show scope global` will show it.

4. Use the page to send direct or broadcast messages into the Uchat room.

## Port Notes

- Default discovery UDP port: `47475`
- Default TCP port for Uchat: `47476`
- Simulator TCP port defaults to an ephemeral port so it does not collide with the app.
- If discovery is already taken by another test process, run both sides on a different matching UDP port.

## Good Signs

- The app discovers the simulator without typing an IP address.
- The simulator prints an incoming message when the app sends one.
- The app shows delivered state after the simulator acks the frame.
- The phone page can send messages using the laptop LAN IP.
