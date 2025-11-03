# Squire — Utility Bot for The Unbreakable Crown

Squire is a multi-feature Discord bot that keeps the Unbreakable Crown server network in sync. It forwards activity into a central "Queen's Court" hub, greets new arrivals with bespoke welcome cards, keeps linked channels mirrored across servers, and automatically bans the wave of "mega/link" spam bots that have been raiding the community.

The project is written in modern ECMAScript modules on top of [`discord.js` v14](https://discord.js.org/#/docs/discord.js/main/general/welcome) and runs on Node.js 22 or newer. Feature modules live in `src/features/*` and are dynamically discovered at startup so that functionality can grow without touching the core runtime.

## Getting the code

Clone the repository with Git:

```bash
export SQUIRE_REPO="https://github.com/Unbreakable-Crown/Squire.git"
git clone "$SQUIRE_REPO"
cd Squire
```

Or fetch an archive without Git:

```bash
export SQUIRE_TARBALL="https://github.com/Unbreakable-Crown/Squire/archive/refs/heads/main.tar.gz"
curl -L "$SQUIRE_TARBALL" | tar -xz
cd Squire-main
```

## Features

- **Logging forwarder** (`src/features/logging-forwarder/`)
  - Mirrors channel activity from each source guild into mapped webhooks in the Queen's Court.
  - Respects per-guild channel/category exclusion lists and a configurable sampling rate.
  - Fully managed through the `/setup` overview — designate the logging server, mark the main servers, and from any guild link them to logging channels (Squire creates/updates the webhooks), configure exclusions, toggle bot forwards, and adjust sampling without editing files.
- **Welcome cards** (`src/features/welcome-cards/`)
  - Builds Mee6-style welcome cards using [Canvacord](https://www.npmjs.com/package/canvacord) with avatar + banner overlays.
  - Posts reminder text pointing newcomers to the rules/roles/verification channels (with configurable channel mentions) and announces departures.
- **Auto bouncer** (`src/features/auto-bouncer/`)
  - Instantly bans unverified accounts whose username, display name, or global name contains known spam terms (mega/megas/link/links by default).
  - Optional notification channel/webhooks + verified-role exemptions so trusted members or staff can bypass the filter.
  - Persists every decision (success, permission failure, unexpected error) to the LokiJS database for auditability.
- **Rainbow Bridge** (`src/features/rainbow-bridge/`)
  - Mirrors messages, edits, and deletions across linked channels spanning multiple guilds.
  - Supports per-bridge overrides for bot forwarding, friendly bridge names, and automatic embed cleanup for rich media.
- **Setup panel** (`src/features/setup/`)
  - Provides the `/setup` slash command that gives admins an in-Discord control panel for every module.
  - Manages logging destinations, welcome channel reminders, rainbow bridge links, and autobouncer keywords without editing `config.json` manually.

## Module setup integration

The `/setup` command is orchestrated by `src/features/setup/index.js`. During `init` it instantiates the `createLoggingSetup`, `createWelcomeSetup`, `createRainbowBridgeSetup`, and `createAutobouncerSetup` factories (one per feature module) and hands them shared helpers such as `panelStore`, `saveConfig`, `fetchGuild`, and `collectManageableGuilds`. Each factory must return at least three functions:

- `prepareConfig(config, context?)` — coerce/normalise config values the module expects. The setup feature calls this inside `ensureConfigShape(...)` so every module sees consistent data before any interaction fires.
- `buildView({ config, client, ... })` — render the embed + component rows for the current panel state. When an admin selects a module from the home screen, setup calls this function and caches the resulting Discord message plus view state inside `panelStore` under a `${userId}:${module}` key.
- `handleInteraction({ interaction, entry, ... })` — react to button/select/modal events, mutating the config (via `saveConfig`) and updating the stored view state. Interaction `customId` values embed the module name so `extractModuleFromInteraction(...)` can route each submission to the right handler.

Shared UI helpers (`appendHomeButtonRow`, channel/role formatting, ID sanitation, webhook validation, etc.) live in `src/features/setup/shared.js` so feature authors can reuse consistent building blocks. When you add a new module with settings, include a companion `setup.js` that exports `create<Module>Setup`, update the module dropdown in `buildHomeView(...)`, and lean on the shared helpers for consistent UX. With that file in place, the setup command automatically recognises the module and populates its panels with your custom view/interaction logic.

## Repository layout

```
src/
  index.js              # Bootstraps config, logger, DB, client, and dynamically loads features
  core/                 # Shared services (Discord client, config loader, feature loader, LokiJS database, CLI helpers)
  features/             # Independent feature modules (loaded automatically)
    logging-forwarder/
    welcome-cards/
    auto-bouncer/
    rainbow-bridge/
    setup/
config.sample.json      # Template resolved by scripts/render-config.mjs using environment variables
squire.db.json          # LokiJS JSON dump (created on first run if not present)
```

## Development workflow

1. **Install prerequisites** — Node.js 22+ and npm 10+.
2. **Install dependencies** — `npm install`.
3. **Run linting & tests** — `npm run lint` and `npm test` before pushing changes.
4. **Type check (optional)** — `npm run build` invokes `tsc -p .` to surface declaration issues.
5. **Deploy slash commands** — `node deploy-commands.js` now publishes `/setup` (and any future commands) globally by default so
   production hosts stay in sync even when `devGuildId` exists in `config.json`. Pass `--dev` (or export `SQUIRE_DEPLOY_DEV=1`)
   to target the configured development guild for faster iteration.

For production hosts, the `squirectl` helper wraps deployment tasks (fetching from `origin/main`, running `npm ci`, rendering config from environment, and managing the systemd unit).

## Deployment tracks

### Track 1 — Local collaborator workstation

Local collaborators should keep secrets out of source control by exporting them into the current shell before rendering config and starting the bot:

```bash
export DISCORD_TOKEN="paste-your-discord-bot-token"
export DISCORD_APPLICATION_ID="paste-your-application-id"
export WEBHOOK_SERVER_1129906023084343346="https://discord.com/api/webhooks/..."
export WEBHOOK_SERVER_1391983429553492049="https://discord.com/api/webhooks/..."
export RAINBOW_BRIDGE_MAIN_ONE_WEBHOOK="https://discord.com/api/webhooks/..."
export RAINBOW_BRIDGE_MAIN_TWO_WEBHOOK="https://discord.com/api/webhooks/..."
export AUTOBAN_NOTIFY_WEBHOOK="https://discord.com/api/webhooks/..."
NODE_ENV=development npm ci
node scripts/render-config.mjs
npm start
```

The one-liner `NODE_ENV=development npm ci && node scripts/render-config.mjs && npm start` works once the exports are present. Re-run `node scripts/render-config.mjs` any time you change environment variables so the working `config.json` stays in sync.

### Track 2 — Codex cloud environment

The Codex cloud runner is intended for automated validation (lint + tests) without touching production secrets. Inject credentials through the task environment, then execute the CI-style pipeline:

```bash
export DISCORD_TOKEN="${DISCORD_TOKEN:?set in cloud secret store}"
export DISCORD_APPLICATION_ID="${DISCORD_APPLICATION_ID:?set in cloud secret store}"
export WEBHOOK_SERVER_1129906023084343346="${WEBHOOK_SERVER_1129906023084343346:?set in cloud secret store}"
export WEBHOOK_SERVER_1391983429553492049="${WEBHOOK_SERVER_1391983429553492049:?set in cloud secret store}"
export RAINBOW_BRIDGE_MAIN_ONE_WEBHOOK="${RAINBOW_BRIDGE_MAIN_ONE_WEBHOOK:?set in cloud secret store}"
export RAINBOW_BRIDGE_MAIN_TWO_WEBHOOK="${RAINBOW_BRIDGE_MAIN_TWO_WEBHOOK:?set in cloud secret store}"
export AUTOBAN_NOTIFY_WEBHOOK="${AUTOBAN_NOTIFY_WEBHOOK:?set in cloud secret store}"
NODE_ENV=production npm ci
node scripts/render-config.mjs
npm run lint && npm test && npm run build
```

The condensed Codex check-in command is:

```bash
NODE_ENV=production npm ci && node scripts/render-config.mjs && npm run lint && npm test && npm run build
```

Use `squirectl status` if you need to confirm the live deployment state from cloud automation without mutating it:

```bash
export SQUIRE_HOST="mcs.example.net"
ssh -p 123 squire@"$SQUIRE_HOST" "squirectl status"
```

### Track 3 — Systemd production host

On the Debian 13 production host, environment variables are sourced by systemd (for example via `/etc/systemd/system/squire.service.d/env.conf`). After editing the environment drop-in, reload systemd and use `squirectl` for lifecycle management:

```bash
sudo systemctl daemon-reload
sudo systemctl restart squire.service
```

Routine deployments use the helper directly:

```bash
export SQUIRE_HOST="mcs.example.net"
ssh -p 123 squire@"$SQUIRE_HOST" "squirectl deploy"
```

The script performs `git fetch --all --prune`, `git reset --hard origin/main`, `npm ci --omit=dev`, runs `node ./scripts/render-config.mjs`, and restarts the `squire` systemd unit while showing a concise status tail. Operators can check health without redeploying:

```bash
ssh -p 123 squire@"$SQUIRE_HOST" "squirectl status"
```

If you must restart without pulling new code, run:

```bash
ssh -p 123 squire@"$SQUIRE_HOST" "squirectl restart"
```

Always export new secret values into the unit environment before invoking any `squirectl` command so the render step can resolve them.

## Getting started

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Provide secrets via environment variables**

   ```bash
   export DISCORD_TOKEN="paste-your-discord-bot-token"
   export DISCORD_APPLICATION_ID="paste-your-application-id"
   export WEBHOOK_SERVER_1129906023084343346="https://discord.com/api/webhooks/..."
   export WEBHOOK_SERVER_1391983429553492049="https://discord.com/api/webhooks/..."
   export RAINBOW_BRIDGE_MAIN_ONE_WEBHOOK="https://discord.com/api/webhooks/..."
   export RAINBOW_BRIDGE_MAIN_TWO_WEBHOOK="https://discord.com/api/webhooks/..."
   export AUTOBAN_NOTIFY_WEBHOOK="https://discord.com/api/webhooks/..."
   ```

   Non-secret values (IDs, sampling values, etc.) can stay in `config.sample.json` or be overridden after rendering.

3. **Render `config.json` from the environment**

   ```bash
   node scripts/render-config.mjs
   ```

   The script deep-merges any existing `config.json`, resolves `$ENV{...}` placeholders, and fails fast if required env variables are missing. Update non-secret settings by editing `config.json` after rendering.

4. **Run the bot**

   ```bash
   npm start
   ```

   The process logs its status to stdout and gracefully handles `SIGINT`/`SIGTERM`.

## Configuration reference

All configuration lives in `config.json`, which is materialised by `scripts/render-config.mjs` using environment variables for every secret. Set secrets (tokens, webhooks, and other sensitive values) through the environment, then render the file. Relevant keys:

| Key | Description |
| --- | ----------- |
| `token` | Discord bot token (`DISCORD_TOKEN` env alternative). |
| `applicationId` | Bot application/client ID (`APPLICATION_ID`). |
| `devGuildId` | Optional guild ID used for dev-only slash command deploys when explicitly requested. |
| `dbPath` | Path to the LokiJS persistence file (defaults to `./squire.db.json`). |
| `loggingServerId` | Guild that receives forwarded logs and slash command deployments (`LOGGING_SERVER_ID`). |
| `sampleRate` | Float between 0 and 1 for the logging forwarder (fraction of messages forwarded). |
| `forwardBots` | Forward bot-authored messages when `true`. |
| `debugLevel` | `none`, `info`, or `verbose` to control console logging verbosity. |
| `mapping` | Object mapping **source guild IDs** to **destination webhook URLs** in the Queen's Court. |
| `loggingChannels` | Optional map of log categories (`messages`, `moderation`, `joins`, `system`) to dedicated channel IDs in the logging server. |
| `excludeChannels` | Per-guild arrays of source channel IDs to ignore while forwarding. |
| `excludeCategories` | Per-guild arrays of category IDs to ignore while forwarding. |
| `rainbowBridge` | Two-way bridge config block (see below). |
| `featureOrder` | Optional array of feature folder names to control load/listener registration order. |
| `autoban` | Auto-bouncer config block (see below). |
| `welcome` | Welcome card config block (see below). |

### Rainbow Bridge config

```json
"rainbowBridge": {
  "forwardBots": true,
  "bridges": {
    "main-halls": {
      "name": "Main Halls",
      "forms": {
        "123456789012345678": {
          "channelId": "234567890123456789",
          "webhookUrl": "https://discord.com/api/webhooks/..."
        },
        "987654321098765432": {
          "channelId": "876543210987654321",
          "webhookUrl": "https://discord.com/api/webhooks/..."
        }
      }
    }
  }
}
```

- `forwardBots` controls whether bot-authored posts are mirrored globally; individual bridges can override this with their own `forwardBots` flag.
- Each bridge lists guild-specific form entries that capture the channel ID and webhook URL for that server. Provide the channel's webhook URL so Squire can speak in that channel. Any form missing required data is ignored until complete.
- The Rainbow Bridge setup panel can automatically create webhooks when it has the **Manage Webhooks** permission, or you can paste an existing webhook URL.
- Add at least two channels per bridge for syncing to begin. Edits and deletions propagate between every linked channel.

### Auto-bouncer config

```json
"autoban": {
  "enabled": true,
  "blockedUsernames": ["mega", "megas", "link", "links"],
  "notifyChannelId": "CHANNEL_ID_FOR_LOGGING_ACTIONS",
  "notifyWebhookUrls": ["https://discord.com/api/webhooks/..."],
  "deleteMessageSeconds": 0
}
```

- Set `enabled` to `false` to disable the module without removing it.
- `blockedUsernames` is case-insensitive and deduplicated; supply any suspicious keywords you want to catch.
- `notifyChannelId` is optional; when set, the bot posts success/failure messages into that text channel.
- `notifyWebhookUrls` is optional; provide one or more webhook URLs to receive the same moderation log events inside a dedicated logging server.
- `deleteMessageSeconds` controls how far back Discord should purge the member's messages when banning (0 keeps history).

For CI/CD you can provide a full JSON blob through `AUTOBAN_CONFIG_JSON` to override the file at deploy time.

### Welcome card config

```json
"welcome": {
  "123456789012345678": {
    "channelId": "WELCOME_CHANNEL_ID",
    "message": "Welcome {{user}} to {{guild}}!\nPlease read our {{rules}}, select your {{roles}}, and then {{verify}} to unlock the full server.",
    "mentions": {
      "rules": "RULES_CHANNEL_ID",
      "roles": "ROLES_CHANNEL_ID",
      "verify": "VERIFY_CHANNEL_ID"
    }
  }
}
```

- Each key in the map is a guild ID. The optional `channelId` forces the welcome module to post into a specific text channel instead of auto-detecting one by name.
- The `mentions` block replaces the placeholder channel names in the welcome reminder text with proper clickable mentions for that guild.
- The optional `message` string customises the text sent alongside the welcome card. Leave it empty to fall back to the default.
- Supported placeholders inside the message template:
  - `{{user}}` — Mention of the new member.
  - `{{username}}` — Discord username of the new member.
  - `{{usertag}}` — Legacy username#discriminator tag when available.
  - `{{displayname}}` — Server display name or global name for the member.
  - `{{guild}}` — Name of the server the member just joined.
  - `{{rules}}`, `{{roles}}`, `{{verify}}` — Mentions (or fallbacks) to the configured channels.
  - `{{membercount}}` — Current cached member count for the server.

### In-Discord setup panel

The `/setup` command opens an overview for operators with the **Manage Server** permission:

- Pick the logging server and the list of “main” servers once, then jump into the Logging, Welcome Cards, or Autobouncer modules from any guild.
- Logging — select which main server to configure, link it to a logging channel inside the logging server, manage excluded channels/categories, assign dedicated logging categories, and tune the sampling/bot-forwarding options.
- Welcome Cards — choose a target server, set its welcome channel, and pick (or clear) the rules/roles/verify references individually.
- Rainbow Bridge — link channels across servers so messages, edits, and deletions stay in sync everywhere.
- Autobouncer — toggle the module, edit the blocked keyword list, and choose the logging server channel that receives autobounce notifications.

Every change is persisted to `config.json`, so redeploys and restarts keep the configured state without manual file edits.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Overrides `config.token`. |
| `APPLICATION_ID` | Overrides `config.applicationId`. |
| `LOGGING_SERVER_ID` | Overrides `config.loggingServerId`. |
| `MAPPING_JSON` | JSON string (object) that replaces `config.mapping`. |
| `LOGGING_CHANNELS_JSON` | JSON object overriding `config.loggingChannels`. |
| `EXCLUDE_CHANNELS_JSON` | JSON object overriding `config.excludeChannels`. |
| `EXCLUDE_CATEGORIES_JSON` | JSON object overriding `config.excludeCategories`. |
| `RAINBOW_BRIDGE_BRIDGES_JSON` | JSON object overriding `config.rainbowBridge.bridges`. |
| `MAIN_SERVER_IDS_JSON` | JSON array overriding `config.mainServerIds`. |
| `WELCOME_CONFIG_JSON` | JSON object overriding `config.welcome`. |
| `AUTOBAN_NOTIFY_CHANNEL_ID` | Channel ID string overriding `config.autoban.notifyChannelId`. |
| `AUTOBAN_CONFIG_JSON` | JSON object overriding the entire `config.autoban` block. |

## Managing slash commands

The repo ships with helper scripts for iterating on slash commands without waiting for global propagation:

- `node deploy-commands.js` – Publishes commands globally by default; pass `--dev` or set `SQUIRE_DEPLOY_DEV=1` to target
  `devGuildId` for instant dev testing.
- `npm run cmds:list` – Lists global + guild slash commands for quick inspection.
- `npm run cmds:wipe:guild` / `npm run cmds:wipe:global` – Removes commands without triggering Discord's entry-point errors.

All scripts read from env variables first, then fall back to `config.json`.

## Database

Squire uses [LokiJS](https://github.com/techfort/LokiJS) for lightweight storage. The default `squire.db.json` file is safe to commit if it does not contain secrets, but you can change the location via `dbPath` or point it at a proper database volume in production.

Moderation decisions from the auto-bouncer land in a `moderation_events` collection (with timestamps, matched term, guild, and status) so staff can investigate why a user was banned or why an action failed.

## Testing

Run the growing automated suite with:

```bash
npm test
```

The Node.js test runner covers high-risk logic such as the auto-bouncer’s moderation logging and the `/setup` control panel rendering. Add new `.test.js` files under `tests/` to extend coverage.

## Development tips

- Keep Node.js up to date (>= 18.17) so `discord.js` and `canvacord` native dependencies work correctly.
- Feature modules are standard ES modules that export an `init(ctx)` function. The loader passes `{ client, config, logger, db }`.
- Avoid deprecated Discord API options such as `deleteMessageDays`; the code base already uses the modern replacements.
- When adding new features, create a new folder under `src/features/` with an `index.js` export—no extra wiring needed.

## License

Licensed under the [GPL-3.0](./LICENSE).
