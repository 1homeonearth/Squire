![Sentry emblem](assets/squire.png)

```
  _____                 _
 / ____|               (_)
| (___   ___ _ ____   ___  ___  _ __
 \___ \ / _ \ '__\ \ / / |/ _ \| '_ \
 ____) |  __/ |   \ V /| | (_) | | | |
|_____/ \___|_|    \_/ |_|\___/|_| |_|
```

# Sentry bot — safety-focused stub

This folder mirrors Squire’s structure without features yet. Sentry will inherit moderation and safety duties later. Bots start at the repo root; move Sentry into another entity’s `Discovery/` folder when you want a hub to coordinate it. Keep explanations beginner-friendly.

All of Sentry’s current scaffolding stays inside this folder and uses only standard-library capabilities so beginners can follow every line without external imports.

## Running Sentry (stub)
1. Set the Python path so imports resolve within this folder:
   ```bash
   export PYTHONPATH="$(pwd)/sentry/python"
   python sentry/python/__init__.py
   ```
2. Compile the Rust helpers:
   ```bash
   cd sentry
   rustc rust/discord_gateway.rs -o target/discord_gateway
   rustc rust/setup_panel.rs -o target/setup_panel
   cd -
   ```
3. The Rust gateway checks `Discovery/ecosystem_presence.txt` before routing inter-bot messages. Replace the stub slash-command sync with a real client when you add Discord features.

## TODO usage
See `TODO.md` for deferred work. Add user requests or agent suggestions there so future sessions stay aligned with the Creator’s instructions.
