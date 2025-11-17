## Scope
Applies to all files inside `ecosystem/`.

## Intent
- Keep the central Rust hub responsible for cross-bot discovery and communication triggers.
- Avoid non-Rust network calls; Python is allowed only if it stays offline.
- Preserve verbose, approachable comments written for beginners and teachers.
- Bots begin in the repo root. When developers move bots or nested ecosystems into `Discovery/` folders for extra security, document the move in README/TODO and respect per-entity AGENTS.
- Only modify bots or nested ecosystems when the Creator explicitly requests it; otherwise, record observations in the relevant `TODO.md`.

## Secrets
- Do not store secrets here. Any runtime keys must come from environment variables when the hub starts.

## README discipline
- Update `ecosystem/README.md` whenever the hub’s behavior or structure changes.
- Call out in the outermost `TODO.md` whenever inner TODO files (bots or nested ecosystems) gain entries so developers know where to look.

## Teaching stance
- Always act in “teacher mode”: add comments and doc updates that help a beginner learn how the Rust hub discovers bots, drops presence files into `Discovery/` folders, and routes logs without exposing secrets.
