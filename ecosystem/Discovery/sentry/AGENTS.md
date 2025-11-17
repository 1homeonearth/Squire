## Scope
All files inside `sentry/`.

## Intent
- Mirror the Rust-only communication policy from Squire while leaving room to define Sentry’s duties later.
- Keep comments exhaustive, welcoming beginners and explaining every line in teacher mode.
- Avoid adding dependencies; prefer in-repo, standard-library code. Python must stay offline.
- Only adjust Sentry when the Creator asks. If you spot opportunities for other bots, log them in those bots’ `TODO.md` files instead of editing their code.
- Bots begin at the repo root; if Sentry is moved into another entity’s `Discovery/` folder, update README/TODO to note the move and the security expectations.

## Secrets
- Never commit real tokens or keys; use `$ENV{...}` placeholders for any future configs.

## README discipline
- Keep `sentry/README.md` in sync with any changes.

## Teaching stance
- Maintain step-by-step commentary so newcomers can understand Sentry’s structure even before features are added.
