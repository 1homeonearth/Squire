# Squire contributor guide

Welcome to Squire! This document tells automation agents how to work inside this repository. It applies to the entire project tree.

## Quick project tour
- **Runtime:** Node.js 22+, ECMAScript modules (`type": "module"`).【F:package.json†L1-L28】
- **Entry point:** `src/index.js` bootstraps config, logger, database, and dynamically loads every feature under `src/features/*/index.js`.【F:src/index.js†L1-L65】【F:src/core/loader.js†L1-L57】
- **Core services:** Live in `src/core/` (Discord client, config loader, logger, LokiJS helpers, slash-command utilities).【F:src/index.js†L1-L65】
- **Features:** Each folder exports an async `init(ctx)` that wires listeners using `{ client, config, logger, db }` and should clean up after itself when possible.【F:src/core/loader.js†L17-L54】
- **Tests:** Vitest suites reside in `tests/` and exercise feature behaviour using lightweight stubs/mocks.【F:tests/auto-bouncer.test.js†L1-L81】

## Coding conventions
- Stick to modern JavaScript with async/await. Avoid callbacks when a Promise-based API exists.
- Preserve the existing formatting: 4-space indentation, semicolons, and trailing commas only where already present.
- Keep imports sorted in logical blocks: Node built-ins, third-party packages, then local modules. Use extensionless relative paths only when the target is a directory index; otherwise include `.js`.
- Never wrap `import` declarations in `try/catch` blocks.
- Prefer descriptive logger messages and include a module prefix in square brackets (e.g. `[auto-bouncer]`). Use the provided `logger` instead of `console.*`.
- When mutating the persisted LokiJS collections, use helper utilities from `src/core/db.js` instead of accessing `.data` directly to keep indexes healthy.
- Configuration goes through `config` passed in the shared context. Respect overrides from environment variables (see `config.sample.json`) and avoid hardcoding secrets or guild IDs.
- Features should guard their event handlers with cheap predicate checks before performing expensive I/O so the bot remains responsive.
- New feature modules must export `init(ctx)` and should return early with a log warning when disabled by config so that `loadFeatures` continues cleanly.【F:src/core/loader.js†L23-L54】

## Testing & QA
- Always run `npm run lint` and `npm test` before committing when you touch source or test files. Add/update Vitest suites alongside new behaviour.【F:package.json†L9-L22】
- If TypeScript type definitions matter for your change, run `npm run build` (which invokes `tsc -p .`) to catch declaration errors, even though the project ships JavaScript sources.【F:package.json†L9-L17】
- Prefer unit or integration tests under `tests/` that stub Discord.js objects using light `EventEmitter` mocks (see existing suites for patterns).【F:tests/auto-bouncer.test.js†L8-L81】

## Documentation & operational notes
- When you add or modify configuration fields, mirror the change in `config.sample.json` and extend the README configuration tables as appropriate.【F:README.md†L27-L140】
- Keep the README feature descriptions accurate whenever you introduce or deprecate a module.【F:README.md†L1-L90】
- Avoid committing secrets. Use environment variables or `.env` files kept out of version control.

## Commit & PR etiquette
- Write conventional, present-tense commit messages (e.g. `feat: add bridge metrics`). Group related changes together.
- After committing, use the `make_pr` tool with a concise summary and a bullet list of highlights. Mention tests you executed.
- Ensure every automated change is reproducible; document manual steps in commit messages or PR notes when unavoidable.
