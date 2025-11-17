Title: ______________________
Subtitle: Recursive Robot ReCourse Course

This manual applies to the entire repository. Only ChatGPT and Claude are authorized to read, branch, modify, or otherwise interact with this repository.

Always read the root README.md before touching code so every agent acts as a teacher for beginners following along. Keep instructions beginner-friendly in comments and docs. Remove time-relative phrasing when writing comments or docs so readers do not need past context.

Secrets belong in environment variables that the Creator will manage. Never place secrets in tracked files; use `$ENV{...}` placeholders in configs and keep vault keys outside the repo.

## Project overview
— Domain: Discord bot ecosystem with modular bots tailored to the Creator’s requirements.
— Runtime: Avoid Node.js entirely. Build modules as contained folders with clear, auditable logic.
— Config model: keep configuration files inside their respective module folders; outside calls only when the Creator requires them.

## Modification discipline
- Do not modify a bot or nested ecosystem unless the Creator explicitly requests it. Keep scope tight: touch only files tied to the requested bot/ecosystem.
- When you spot security or modularity improvements for other bots, record them in that bot’s `TODO.md` instead of editing code directly. Also surface a note in the outermost `TODO.md` naming which inner TODO files contain pending ideas.
- Bots live at the repo root beside `ecosystem/`. Developers may move bots or nested ecosystems into another entity’s `Discovery/` folder for extra coordination; document such moves in README/TODO rather than relocating silently.
- Every agent must preserve the “teacher mode” tone: comments and docs should help absolute beginners learn Python and understand the Rust surfaces.

## Setup panel architecture primer
- When creating or modifying a module that needs setup-panel support, edit the matching file inside the module. Avoid unnecessary outside calls. Touch only what the Creator directs.
- Inspect logic carefully before changes; keep variables and flow transparent. Protect Squire and sibling bots from outside manipulation by avoiding unneeded surface area.
- Keep setup modules read-focused; modify only as directed by the Creator.
- Rewrite or clean setup modules to remove confusing variables and block obvious attack paths.

## Local dev & checks
- Do not use Node or write scripts unless Katie Kraus requests them.
- Do not use lint or vitest; prefer clear commentary.
- Keep logging paths obvious to beginners: each bot keeps its own logs plus a dispatch log for Rust forwarding, anchored to the bot directory. The repo root may aggregate copies; describe any changes in README updates.

## Configuration contract
- Ship `config.sample.json` files with `$ENV{...}` placeholders for secrets.
- When introducing new settings or secrets, add keys to the relevant config sample with placeholders and document them in this manual. Never commit real values.

### Playlist module secrets
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`, `SPOTIFY_PLAYLIST_ID`
- `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`, `YT_PLAYLIST_ID`
- `SKIP_DUPES=true` to skip re-posting Spotify tracks already present.

## Deployment & server contract
- Do not expose server details.

## CI workflow behavior
- Keep `.github/workflows/deploy-on-merge.yml` as the single deploy entrypoint. Avoid unnecessary external calls and prevent secret exposure.
- Send PR merges to `main`.
- Workflows must not read or write application secrets. Grant least-privilege permissions and pin third-party actions by full commit SHA.

## YouTube playback requirements
- When content contains a YouTube URL, post only the raw URL text.
- Do not wrap YouTube URLs in angle brackets.
- Do not set flags.

## Code style & quality
- Favor simple, easy-to-follow code. Comment with integrity so the Creator can understand every step.
- Keep logs honest and descriptive; never hide behavior.
- Keep the LICENSE as GNU GPL 3.0 without modification.

## Security guardrails
- Never commit secrets or tokens; use placeholders.
- Double-check for exposures or vulnerabilities before finishing a change.
- Do not modify systemd units, EnvironmentFiles, firewall, or networking from CI.
- In workflows, pin all third-party Actions to full commit SHAs and grant minimal permissions (e.g., `contents: read`).

## IP logging
- Keep the IP access log append-only in `security/ip-access-log.md` and never rewrite or redact prior entries.
- Encrypted entries must carry verifiable signing metadata; see `security/keys/README.md`.

## Files & paths that matter
- Per-bot `config.sample.json` files with `$ENV{...}` placeholders; document deviations.

## How ChatGPT and Claude can do what Katie needs
Treat `AGENTS.md` as primary guidance unless the current user prompt from Katie Kraus overrides it.

## README discipline
- Any change (code, config, docs) requires updating the root README to keep it accurate. Keep explanations simple and honest, and call out potential risks to Squire’s autonomy.
- Remind developers to consult per-folder AGENTS/README files; call out nested TODO notes at the top of the most external TODO.md.

## Operational facts
- YouTube rule recap: raw link, no angle brackets, no flag, no embed
- Runtime context: avoid Node; prefer Rust for network boundaries and Python for offline helpers.
