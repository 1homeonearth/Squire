# Squire — Utility Bot for The Unbreakable Crown

Squire is a multi-feature Discord bot that keeps the Unbreakable Crown server network in sync. It forwards activity into a central "Queen's Court" hub, greets new arrivals with bespoke welcome cards, and automatically bans the wave of "mega/link" spam bots that have been raiding the community.

The project is written in modern ECMAScript modules on top of [`discord.js` v14](https://discord.js.org/#/docs/discord.js/main/general/welcome) and runs on Node.js 18.17 or newer. Feature modules live in `src/features/*` and are dynamically discovered at startup so that functionality can grow without touching the core runtime.

## Features

- **Logging forwarder** (`src/features/logging-forwarder/`)
  - Mirrors channel activity from each source guild into mapped webhooks in the Queen's Court.
  - Respects per-guild channel/category exclusion lists and a configurable sampling rate.
  - Fully managed through the `/setup logging` panel — select the logging server, link guilds via dropdowns (with automatic webhook creation), configure exclusions, toggle bot forwards, and adjust sampling without editing files.
- **Welcome cards** (`src/features/welcome-cards/`)
  - Builds Mee6-style welcome cards using [Canvacord](https://www.npmjs.com/package/canvacord) with avatar + banner overlays.
  - Posts reminder text pointing newcomers to the rules/roles/verification channels (with configurable channel mentions) and announces departures.
- **Auto bouncer** (`src/features/auto-bouncer/`)
  - Instantly bans unverified accounts whose username, display name, or global name contains known spam terms (mega/megas/link/links by default).
  - Optional notification channel/webhooks + verified-role exemptions so trusted members or staff can bypass the filter.
  - Persists every decision (success, permission failure, unexpected error) to the LokiJS database for auditability.

## Repository layout

```
src/
  index.js              # Bootstraps config, logger, DB, client, and dynamically loads features
  core/                 # Shared services (Discord client, config loader, feature loader, LokiJS database, CLI helpers)
  features/             # Independent feature modules (loaded automatically)
    logging-forwarder/
    welcome-cards/
    auto-bouncer/
config.sample.json      # Copy to config.json and fill with production secrets
squire.db.json          # LokiJS JSON dump (created on first run if not present)
```

## Getting started

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create `config.json`**

   ```bash
   cp config.sample.json config.json
   ```

   Edit the file and populate it with your bot token, application ID, logging server, and per-guild webhook mapping. See the [configuration reference](#configuration-reference) for details on every field.

3. **Run the bot**

   ```bash
   npm start
   ```

   The process logs its status to stdout and gracefully handles `SIGINT`/`SIGTERM`.

## Configuration reference

All configuration lives in `config.json`. Secrets can alternatively be provided through environment variables (useful for CI/CD); environment values take precedence. Relevant keys:

| Key | Description |
| --- | ----------- |
| `token` | Discord bot token (`DISCORD_TOKEN` env alternative). |
| `applicationId` | Bot application/client ID (`APPLICATION_ID`). |
| `dbPath` | Path to the LokiJS persistence file (defaults to `./squire.db.json`). |
| `loggingServerId` | Guild that receives forwarded logs and slash command deployments (`LOGGING_SERVER_ID`). |
| `sampleRate` | Float between 0 and 1 for the logging forwarder (fraction of messages forwarded). |
| `forwardBots` | Forward bot-authored messages when `true`. |
| `debugLevel` | `none`, `info`, or `verbose` to control console logging verbosity. |
| `mapping` | Object mapping **source guild IDs** to **destination webhook URLs** in the Queen's Court. |
| `loggingChannels` | Optional map of log categories (`messages`, `moderation`, `joins`, `system`) to dedicated channel IDs in the logging server. |
| `excludeChannels` | Per-guild arrays of source channel IDs to ignore while forwarding. |
| `excludeCategories` | Per-guild arrays of category IDs to ignore while forwarding. |
| `featureOrder` | Optional array of feature folder names to control load/listener registration order. |
| `autoban` | Auto-bouncer config block (see below). |
| `welcome` | Welcome card config block (see below). |

### Auto-bouncer config

```json
"autoban": {
  "enabled": true,
  "blockedUsernames": ["mega", "megas", "link", "links"],
  "verifiedRoleIds": ["ROLE_ID_THAT_MARKS_VERIFIED_MEMBERS"],
  "notifyChannelId": "CHANNEL_ID_FOR_LOGGING_ACTIONS",
  "notifyWebhookUrls": ["https://discord.com/api/webhooks/..."],
  "deleteMessageSeconds": 0
}
```

- Set `enabled` to `false` to disable the module without removing it.
- `blockedUsernames` is case-insensitive and deduplicated; supply any suspicious keywords you want to catch.
- `verifiedRoleIds` lets you exempt members who already own the "Verified" role (or any trusted role) at join time.
- `notifyChannelId` is optional; when set, the bot posts success/failure messages into that text channel.
- `notifyWebhookUrls` is optional; provide one or more webhook URLs to receive the same moderation log events inside a dedicated logging server.
- `deleteMessageSeconds` controls how far back Discord should purge the member's messages when banning (0 keeps history).

For CI/CD you can provide a full JSON blob through `AUTOBAN_CONFIG_JSON` to override the file at deploy time.

### Welcome card config

```json
"welcome": {
  "channelId": "WELCOME_CHANNEL_ID",
  "mentions": {
    "rules": "RULES_CHANNEL_ID",
    "roles": "ROLES_CHANNEL_ID",
    "verify": "VERIFY_CHANNEL_ID"
  }
}
```

- `channelId` forces the welcome module to post into a specific text channel instead of auto-detecting one by name.
- `mentions` replaces the placeholder channel names in the welcome reminder text with proper clickable mentions.

### In-Discord setup panel

The `/setup` command exposes per-module configuration panes for operators with the **Manage Server** permission:

- `/setup logging` — choose the central logging server, link the current guild to a channel via dropdowns (Squire creates/updates the webhook automatically), manage excluded channels/categories, assign dedicated logging channels for different event types, and tune the sampling/bot-forwarding options.
- `/setup welcome` — pick the welcome/goodbye channel and the reminder jump points (rules, roles, verification) directly from channel lists.
- `/setup autobouncer` — toggle the module on/off and edit the blocked keyword list in-place via modal text input.

Every change is persisted to `config.json`, so redeploys and restarts keep the configured state without manual file edits.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Overrides `config.token`. |
| `APPLICATION_ID` | Overrides `config.applicationId`. |
| `LOGGING_SERVER_ID` | Overrides `config.loggingServerId`. |
| `MAPPING_JSON` | JSON string (object) that replaces `config.mapping`. |
| `EXCLUDE_CHANNELS_JSON` | JSON object overriding `config.excludeChannels`. |
| `EXCLUDE_CATEGORIES_JSON` | JSON object overriding `config.excludeCategories`. |
| `AUTOBAN_CONFIG_JSON` | JSON object overriding the entire `config.autoban` block. |

## Managing slash commands

The repo ships with helper scripts for iterating on slash commands without waiting for global propagation:

- `npm run deploy:commands` – Deploys commands to the logging server guild (fast, for testing).
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

[MIT](./LICENSE)
