This is the operating manual for coding agents (Copilot agent-mode, OpenAI/Codex-style agents, Cursor, Aider, etc.). Read it end-to-end before running anything.
Secrets never live in git; they come from the server environment at deploy.

## Project overview
— Domain: Discord bot with two modules: a logging pipeline and a rainbow-bridge relay.
— Critical behavior: preserve native YouTube playback (do not ‘pretty up’ YouTube; let Discord unfurl the raw link).
— Runtime: Node.js 22.x in production (Node 20 tested locally).
— Config model: derived from server env; no plaintext secrets in the repo.

## Setup panel architecture primer
- The `/setup` slash command lives in `src/features/setup/index.js`. During `init` it instantiates each module’s factory (for example `createLoggingSetup`, `createWelcomeSetup`, etc.) from the module’s `setup.js` file and hands them shared helpers such as `panelStore`, `saveConfig`, and `fetchGuild`.
- Every module-specific factory must return at least `prepareConfig`, `buildView`, and `handleInteraction`. The setup feature calls `prepareConfig` inside `ensureConfigShape` before interactions start so each module’s expected config shape is normalised.
- When a user opens a module from the home panel, the setup feature calls that module’s `buildView(...)` to render the initial embed/components and caches the resulting message + state in `panelStore` under a `${userId}:${module}` key.
- Subsequent component or modal submissions include the module name inside `customId`. `extractModuleFromInteraction` resolves it and dispatches to the module’s `handleInteraction(...)`, passing the cached state from `panelStore` so the module can update the UI and persist config changes via `saveConfig`.
- When you add a new feature module, ship a `setup.js` with that factory signature, update the module selector in `buildHomeView`, and rely on the shared helpers in `src/features/setup/shared.js` for consistent formatting and ID hygiene.

## Local dev & checks
Use Node.js 22 locally. Install deps with `npm ci`. Keep `package.json` scripts exactly as:

```
{
  "scripts": {
    "lint": "eslint .",
    "test": "vitest run",
    "build": "tsc -p . || true",
    "start": "node index.js"
  }
}
```

PRs are acceptable only if `npm run lint`, `npm test`, and `npm run build` all pass.

## Configuration contract
- Ship `config.sample.json` with placeholders using the `$ENV{VAR_NAME}` syntax for every secret or deployment-specific value.
- Implement `scripts/render-config.mjs` so that it deep-merges any existing `config.json` defaults, resolves `$ENV{...}` from `process.env`, fails loudly when required env vars are absent, and writes `config.json` atomically.
- When introducing new settings or secrets, add keys to `config.sample.json` with `$ENV{...}` placeholders and document them in this manual. Never commit real secret values.

### Setup configuration quickstart
1. Export the required environment variables (tokens, webhook URLs, JSON overrides) and run `node scripts/render-config.mjs`. The script merges `config.sample.json` with any existing `config.json`, replaces `$ENV{VAR}` placeholders (parsing JSON strings automatically), and rewrites `config.json` atomically or exits if a variable is missing.
2. Treat `config.json` at the repo root as the live source of truth. The `/setup` module calls `saveConfig(...)` to persist edits immediately, so avoid manual edits while setup is open to prevent stomping changes.
3. Populate shared metadata before opening `/setup`:
   - `loggingServerId` — guild that hosts the logging channels.
   - `mainServerIds` — array of guild IDs displayed in the setup dropdowns.
   - Any exclusion lists or sampling overrides consumed by logging/forwarding modules.
4. Seed module sections with the expected shapes (empty objects are fine — setup will backfill defaults):
   - **Autobouncer (`config.autoban`)**: supports `enabled`, `blockedUsernames` (string array), `notifyChannelId`, `notifyWebhookUrls` (array of Discord webhook URLs), `deleteMessageSeconds`, `scanBio`, and `testRoleMap` (guild ID → role ID). Names are normalised to lowercase; missing keys adopt safe defaults.
   - **Rainbow Bridge (`config.rainbowBridge`)**: top-level `forwardBots` boolean plus a `bridges` map. Each bridge contains a `name`, optional `forwardBots` override, and `forms` keyed by guild ID with `{ guildId, channelId, threadId?, parentId?, webhookUrl, name? }`. Legacy `channels` arrays are accepted and normalised.
   - **Experience (`config.experience`)**: map of guild IDs to `{ activeRuleId?, rules: [...] }`. Each rule exposes `id`, `name`, `message`/`voice`/`reaction` blocks (with `enabled`, amount, cooldown), `resets`, `multiplier`, `channelBlacklist`, `roleBlacklist`, `levelUpChannelId`, a `leaderboard` object, and a global `blacklist` with `channels`/`categories`. Missing rules trigger auto-generation of the default rule template.
   - **Embed Builder (`config.embedBuilder`)**: `{ guildId?, channelId?, preface, embed: { color, title, description }, buttons: [{ label, url }, …] }`. Buttons must use HTTPS URLs and there can be at most five.
   - **Playlists (`config.playlists`)**: configure Spotify (`clientId`, `clientSecret`, `refreshToken`, `playlistId`, optional `skipDupes`) and YouTube (`clientId`, `clientSecret`, `refreshToken`, `playlistId`) credentials for the `/add` command. Populate values via `$ENV{...}` placeholders — secrets never live in git.
5. Use raw Discord snowflake IDs (strings) for channels, roles, guilds, and threads. Do not rely on names; setup stores exact IDs.
6. Before running `/setup`, confirm `config.json` renders without missing variables, double-check destination IDs/webhooks, and restart the bot so every feature re-reads the new config.

### Playlist module secrets
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`, `SPOTIFY_PLAYLIST_ID`
- `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`, `YT_PLAYLIST_ID`
- Optional: `PLAYLISTS_SKIP_DUPES=true` to skip re-posting Spotify tracks already present.
- Use `node scripts/spotify-refresh-token.mjs` or `node scripts/youtube-refresh-token.mjs` to exchange authorization codes or refresh existing tokens when rotating credentials.

## Deployment & server contract
- Remote host: MCS (Debian 13), SSH port 123, key-based auth only.
- Server repo path: `/opt/squire/app` owned by user `squire`.
- Managed via a systemd unit running as `squire`. CI must not modify systemd units, firewall rules, or any secrets.
- Server operations are executed with `squirectl deploy|start|restart|status`.

### What `squirectl deploy` guarantees
1. `git fetch --all --prune` and `git reset --hard origin/main` as user `squire`.
2. `npm ci --omit=dev`.
3. `node ./scripts/render-config.mjs` to materialize `config.json` from environment variables.
4. Restart (or start) the systemd unit.
5. Print a concise status tail.

This is how new secrets/environment variables are picked up automatically at deploy—never edit `config.json` by hand.

## CI workflow behavior
- Keep `.github/workflows/deploy-on-merge.yml` as the single deploy entrypoint.
- Trigger on PR merges to `main` and direct pushes to `main`.
- The job must SSH to MCS on port 123 using Actions secrets and run exactly `squirectl deploy`.
- Workflows must not read or write application secrets. Grant least-privilege permissions and pin third-party actions by full commit SHA.

## YouTube playback requirements (hard fail if broken)
- When content contains a YouTube URL, post only the raw URL text.
- Do not wrap YouTube URLs in angle brackets; that suppresses the native preview.
- Do not set flags that suppress embeds (such as `SuppressEmbeds`).
- Do not attach competing custom embeds when forwarding YouTube links; let Discord unfurl the native player.
- Provide `src/lib/youtube.ts` with:
  - `isYouTubeUrl(text): boolean` — detect `youtube.com/watch?v=...` and `youtu.be/...` forms.
  - `prepareForNativeEmbed(text): string` — remove any angle-bracket wrapping if present.
- Both bot modules must call a shared helper so that when `isYouTubeUrl(content)` is true the bot posts only the cleaned content with `allowedMentions: { parse: [] }` and no embeds or suppression flags.

## Code style & quality
- Favor small, pure functions with explicit return types.
- Keep logs concise; never print environment variable values.
- Add or update tests for every user-visible or reliability-impacting change.
- Keep the root `LICENSE` canonical and ensure `package.json#license` contains a matching, valid SPDX identifier.

## Commits & versioning
- Use Conventional Commits (e.g. `feat(bridge): forward YouTube links as plain URLs`, `fix(logging): avoid suppressing embeds on YT`, `chore(ci): pin ssh action to commit SHA`).
- Follow SemVer: major for breaking changes (note with `BREAKING CHANGE:`), minor for features, patch for fixes. Bump versions whenever public behaviour changes.

## Security guardrails
- Never commit secrets or tokens; use `$ENV{...}` placeholders exclusively.
- Do not modify systemd units, EnvironmentFiles, firewall, or networking from CI.
- In workflows, pin all third-party Actions to full commit SHAs and grant minimal permissions (e.g. `contents: read`).

## Files & paths that matter
- `.github/workflows/deploy-on-merge.yml` — CI entrypoint that only runs `squirectl deploy` over SSH.
- `scripts/render-config.mjs` — renders `config.json` from environment variables on deploy.
- `config.sample.json` — authoritative configuration keys; secrets referenced via `$ENV{VAR}`.
- `src/lib/youtube.ts` — helpers that preserve native YouTube playback.
- `LICENSE` + `package.json#license` — must match and remain SPDX-valid.

## How Copilot and other agents should consume this file
Treat `AGENTS.md` as the highest-priority repository guidance unless the current user prompt explicitly overrides it.

## Operational facts
- Server: MCS (Debian 13, systemd), SSH port 123, key-auth only.
- Users: `root` (units/env), `squire` (owns `/opt/squire/app`), `sysadmin` (no sudo), `filegirl` (SFTP drop).
- Deploy verb: `squirectl deploy` (fetch/reset → install → render-config → restart).
- YouTube rule recap: raw link, no angle brackets, no suppression flags, no custom embed.
- License: keep canonical and SPDX-valid.
- Runtime context: production on Node 22.x; review periodically against Node LTS/maintenance windows.
