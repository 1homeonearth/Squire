![Bard emblem](assets/squire.png)

```
  _____                 _
 / ____|               (_)
| (___   ___ _ ____   ___  ___  _ __
 \___ \ / _ \ '__\ \ / / |/ _ \| '_ \
 ____) |  __/ |   \ V /| | (_) | | | |
|_____/ \___|_|    \_/ |_|\___/|_| |_|
```

# Bard bot — logging-focused reference

Bard now carries beginner-ready modules for logging-forwarder duties, welcome cards, starboard highlights, and moderation logging. Bots start at the repo root; move Bard into another entity’s `Discovery/` folder when you want a hub to coordinate it. Comments stay verbose so a new reader can follow every step.

All helpers used by Bard live in this folder and rely only on the standard libraries, so anyone can audit the code without pulling in outside imports.

## Running Bard
1. Set the Python path so imports resolve within this folder:
   ```bash
   export PYTHONPATH="$(pwd)/bard/python"
   python bard/python/main.py
   ```
2. Compile the Rust helpers:
   ```bash
   cd bard
   rustc rust/discord_gateway.rs -o target/discord_gateway
   rustc rust/setup_panel.rs -o target/setup_panel
   cd -
   ```
3. The Rust gateway checks `Discovery/ecosystem_presence.txt` before routing inter-bot messages. Replace the stub slash-command sync with a real client when you add Discord features.

The Cargo workspace includes a placeholder binary named `bard-gateway` so offline builds have a staging target:
```bash
cargo build --offline --release -p bard-gateway
```
It writes `Discovery/gateway_queue.log` to show where the logging dispatcher will push events once the real gateway code is wired up.

## Feature tour
- `python/features/logging_forwarder.py` captures server events and queues them for Rust to forward to a logging channel.
- `python/features/welcome_card.py` builds friendly welcome payloads without network calls.
- `python/features/starboard.py` (formerly spotlight gallery) spotlights popular messages after a reaction threshold.
- `python/features/moderation_logging.py` records moderation actions and prepares them for Rust delivery.

All modules resolve their paths relative to this folder, so you can copy them into another bot with no changes.

## Config sample
`config.sample.json` lists the vault placeholders and feature settings Bard expects. Secrets stay in environment variables using `$ENV{...}` markers.

## TODO usage
See `TODO.md` for deferred work. Add user requests or agent suggestions there so future sessions stay aligned with the Creator’s instructions.
