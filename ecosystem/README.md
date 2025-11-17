# Ecosystem hub

This folder holds the Rust core that coordinates bots. It keeps all Discord and cross-bot communication in Rust while Python modules inside each bot stay offline. Bots start in the repo root; when you want the hub to manage them, place a bot or another ecosystem inside this folder’s `Discovery/` directory. The file-based handshake keeps everything auditable and prevents Python from opening sockets.

## What the hub does
- Discovers entities by looking at sibling folders in the repo root and any entries inside `Discovery/` folders. An entity is any directory that contains its own `Discovery/` folder.
- Writes `Discovery/ecosystem_presence.txt` into each discovered entity to signal “safe to talk” and signs it with a SipHash digest based on `ECOSYSTEM_PRESENCE_KEY`. Gateways ignore unsigned markers so local processes cannot short-circuit the isolation barrier.
- Reads `Discovery/gateway_queue.log` inside each entity to collect messages that Rust would forward to Discord.

## Running
Compile with the standard library only:
```bash
cd ecosystem
rustc rust/central_comm.rs -o target/central_comm
./target/central_comm
```
Run from this folder so the hub can find sibling bots; adjust the working directory if you run a nested ecosystem.

## Cargo workspace target
The `ecosystem-hub` Cargo target mirrors the handwritten gateway so offline builds have a binary to stage:
```bash
cargo build --offline --release -p ecosystem-hub
```
The placeholder writes `Discovery/ecosystem_presence.txt` during the build so students can see where presence markers live. Replace it with the full coordinator logic when you wire real Discord flows.
