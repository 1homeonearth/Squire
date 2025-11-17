![Squire emblem](assets/squire.png)

```
  _____                 _
 / ____|               (_)
| (___   ___ _ ____   ___  ___  _ __
 \___ \ / _ \ '__\ \ / / |/ _ \| '_ \
 ____) |  __/ |   \ V /| | (_) | | | |
|_____/ \___|_|    \_/ |_|\___/|_| |_|
```

# Squire bot — reference implementation

This folder is a self-contained version of Squire. It includes Python logic, a Rust Discord gateway, a Rust setup panel, an AGENTS guide, a TODO list, and copied assets. Everything needed to understand or rebuild the bot lives here so you can compile and run it without touching sibling bots or parent ecosystems. Squire now lives inside the ecosystem hub’s `Discovery/` directory so the central coordinator sees it immediately; you can still move the folder into another entity’s `Discovery/` directory if you want to nest it elsewhere.

Every function used by Squire sits inside this folder with no outside dependencies beyond the Python and Rust standard libraries, so beginners can read every line without chasing imports elsewhere.

## Running Squire
1. Set the Python path so imports resolve within this folder:
   ```bash
   cd ecosystem/Discovery/squire
   export PYTHONPATH="$(pwd)/python"
   python python/main.py
   ```
   If you move Squire into a different `Discovery/` folder, update the paths accordingly.
2. Compile the Rust helpers:
   ```bash
   cd ecosystem/Discovery/squire
   rustc rust/discord_gateway.rs -o target/discord_gateway
   rustc rust/setup_panel.rs -o target/setup_panel
   cd -
   ```
3. Slash commands: the gateway’s `sync_slash_commands` runs during `flush()` to keep commands current. Swap the stub with a real Discord client while keeping tokens in environment variables.

The Cargo workspace also exposes a placeholder binary named `squire-gateway` so offline builds have a target to stage:
```bash
cargo build --offline --release -p squire-gateway
```
It writes `Discovery/gateway_queue.log` with a friendly marker so students can see where the Rust gateway will read messages.

## Secrets and vault
- Keep vault keys and salts only in environment variables (e.g., `SQUIRE_VAULT_KEY`, `SQUIRE_VAULT_SALT`).
- `config.sample.json` stores only `nonce`/`ciphertext`/`tag` triples for the Discord token. Without your key, the ciphertext is useless.
- The vault uses HKDF + ChaCha20-Poly1305 in Python for authenticated encryption; see `python/crypto/secrets.py` for narrated math.

## Logging
`python/core/logger.py` can write to:
- The console with timestamps.
- A per-bot log file (optional path argument).
- A central dispatch file (`Discovery/gateway_queue.log`) so the Rust gateway can forward logs to a secure Discord logging channel without Python opening sockets.
All defaults are anchored to this bot’s directory so logs do not leak elsewhere; point the environment variables to a ramdisk if you prefer ephemeral storage on a compromised host. The Rust gateway adds a redacted HTTPS summary to `Discovery/secure_transport.log` so sensitive payloads stay out of stdout.

## Inter-bot awareness
Squire waits for the ecosystem hub to drop a signed `Discovery/ecosystem_presence.txt` before exchanging bot-to-bot messages. The signature is a SipHash digest derived from the `ECOSYSTEM_PRESENCE_KEY` environment variable, so local processes cannot forge presence without the shared key. Until the signature validates, only Discord-bound payloads are prepared for the Rust gateway.

## Learning path
- Start with `python/crypto/passwords.py` and `python/crypto/secrets.py` to see scrypt hashing and ChaCha20-Poly1305.
- Review `python/config_loader.py` and `python/main.py` to watch the end-to-end config and vault flow.
- Explore `python/features/*.py` for autoban, experience, embed builder, moderation commands, rainbow bridge, and setup helpers—all heavily commented.
- Inspect `rust/discord_gateway.rs` to see how all external Discord calls remain in Rust.

## TODO usage
See `TODO.md` for deferred user requests and agent suggestions. Add new work there so future sessions stay aligned with the Creator’s instructions.

## Why a config loader exists
`python/config_loader.py` serves as a teaching tool that shows how to read
`config.sample.json`, pull vault material from environment variables, decrypt
secrets, and validate password hashes. It keeps the main bot logic simple and
lets readers experiment without risk. The same patterns can be reused for the
live bot processes so there is no duplicate logic.
