## Scope
Covers everything under `bard/`.

## Intent
- Keep the structure aligned with Squire’s Rust-first design while Bard specializes in logging-server duties.
- Preserve the comment-rich, teacher-mode style now that Bard ships logging forwarder, welcome card, starboard, and moderation logging modules.
- No external dependencies or Node.js usage. Keep all Discord I/O in Rust.
- Only modify Bard when the Creator requests it. Capture improvement ideas for other bots in their `TODO.md` files instead of changing their code.
- Bots start at the repo root and may be moved into another entity’s `Discovery/` folder for added security. Document such moves in README/TODO.

## Secrets
- Do not add real secrets. Future configs must use `$ENV{...}` placeholders, with keys supplied at runtime.

## README discipline
- Update `bard/README.md` alongside structural or behavioral changes.

## Teaching stance
- Write and preserve comments that help beginners learn how Bard mirrors the ecosystem layout and how its Rust gateway will eventually forward logs securely.
