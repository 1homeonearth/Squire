## Scope
This file governs all files inside `squire/`.

## Intent
- Keep Squire self-contained: no Node.js, no external package downloads, and no network calls from Python.
- All Discord and cross-bot communication must travel through Rust files in this folder.
- Preserve verbose, beginner-friendly comments; do not remove them. Act as a teacher to newcomers reading the code.
- Only modify this bot when the Creator asks for Squire-specific work. If you notice security or modularity ideas for other bots, write them into those bots’ `TODO.md` files rather than changing code directly.
- Bots live at the repo root. When a developer moves Squire into another entity’s `Discovery/` folder, document the move in README/TODO and keep presence-path settings accurate.

## Secrets
- Never commit real secrets. Use `$ENV{...}` placeholders in `config.sample.json` and environment variables at runtime.
- Vault keys and salts must stay outside the repo.

## README discipline
- Update `squire/README.md` whenever behavior or structure changes.

## Logging
- Ensure log output can be routed to console, per-bot files, and the central dispatch file for Rust forwarding. Keep paths anchored to this bot’s directory (including `Discovery/gateway_queue.log`) and describe any changes in the README so beginners can follow along.
