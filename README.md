# Squire — Utility Bot for The Unbreakable Crown
<!-- simple -->
![Squire](assets/Squire.png)

Squire is a multi-feature Discord bot that keeps the Unbreakable Crown server network in sync. It forwards activity into a central "Queen's Court" hub, greets new arrivals with bespoke welcome cards, keeps linked channels mirrored across servers, and automatically bans the wave of "mega/link" spam bots that have been raiding the community.

The project is written in modern ECMAScript modules on top of [`discord.js` v14](https://discord.js.org/#/docs/discord.js/main/general/welcome) and runs on Node.js 22 or newer. Feature modules live in `src/features/*` and are dynamically discovered at startup so that functionality can grow without touching the core runtime.

Squire persists runtime state in a LokiJS database. During shutdown it now waits for the database save callback to finish before exiting so recent writes are not lost when the process stops.

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
- **Moderation commands** (`src/features/moderation-commands/`)
  - Ships `/ban`, `/unban`, `/kick`, and `/timeout` slash commands so staff can moderate without leaving Discord.
  - `/ban` and `/unban` continue to propagate across every managed server, while `/kick` and `/timeout` act on the invoking guild with detailed success/failure reporting.
  - Access is restricted to moderator roles selected in `/setup` (with **Manage Server**/**Administrator** as a fallback) so only approved staff can execute the commands.
- **Moderation logging** (`src/features/moderation-logging/`)
  - Streams moderator discipline (bans, unbans, kicks, timeouts) into a dedicated actions channel inside the logging server.
  - Captures category lifecycle changes (create/update/delete) with executor + reason context pulled from the audit log.
  - Configure action/category destinations inside `/setup` to keep staff updates separate from the main message forwarder.
- **Rainbow Bridge** (`src/features/rainbow-bridge/`)
  - Mirrors messages, edits, and deletions across linked channels spanning multiple guilds.
  - Supports per-bridge overrides for bot forwarding, friendly bridge names, one-way mirroring, and automatic embed cleanup for rich media.
- **Experience system** (`src/features/experience/`)
  - Awards XP for messages, reactions, and voice activity using per-guild rule sets with cooldowns, multipliers, and blacklists.
  - Ships the `/xp set` moderator command for adjusting a member's total and persists totals in LokiJS collections.
- **Embed builder** (`src/features/embed-builder/`)
  - Lets staff compose reusable announcement embeds (preface text, color, title, description) and up to five HTTPS buttons directly from `/setup`.
  - Supports multiple named presets per guild so announcements can be saved, duplicated, renamed, and deleted without losing older layouts.
  - Stores the latest configuration in `config.embedBuilder` so announcements can be posted consistently across guilds.
- **Spotlight gallery** (`src/features/spotlight-gallery/`)
  - Reposts standout messages into a dedicated highlights channel once they collect a configurable number of matching reactions.
  - Supports per-guild emoji triggers, thresholds, and optional self-reaction counting so each server can tune what deserves a spotlight.
  - Keeps native YouTube playback intact by mirroring the original link text alongside the curated embed preview.
- **Playlist relay** (`src/features/playlists/`)
  - Adds the `/add` command for piping Spotify tracks or YouTube videos into shared playlists using OAuth credentials.
  - Mirrors the cleaned link back into the invoking channel via managed webhooks while preserving Discord's native YouTube player.
  - Attempts to mirror each submission onto the opposite platform when the artist/title can be matched exactly (Spotify ↔ YouTube), reporting when a match cannot be found.
  - Configure Spotify/YouTube client credentials and the duplicate-skipping toggle directly from the `/setup` panel instead of editing JSON by hand.
- **Setup panel** (`src/features/setup/`)
  - Provides the `/setup` slash command that gives admins an in-Discord control panel for every module.
  - Manages logging destinations, welcome channel reminders, rainbow bridge links, autobouncer keywords, experience rules, and embed builder presets without editing `config.json` manually.

## Exporting the Bard/Sentry bundle

To offload Squire's logging, moderation logging, and spotlight gallery duties into a separate bot (Bard or Sentry), run the exporter:

```bash
node scripts/export-bard-modules.mjs
```

The script creates `exports/bard/` containing:

- The three feature folders (`logging-forwarder`, `moderation-logging`, `spotlight-gallery`).
- Shared support files (`src/lib/youtube.js`, `src/lib/poll-format.js`, `src/lib/display.js`, `src/core/db.js`) needed for those features to run independently.
- A trimmed `exports/bard/config.json` that copies the relevant config keys (logging server/channels, mappings, exclusions, sampling, moderation logging destinations, and spotlight gallery settings) from your local `config.json` if present, otherwise from `config.sample.json`.

You can drop the `exports/bard/` tree into the new bot as a starting point without hunting for scattered dependencies.

## Module setup integration

The `/setup` command is orchestrated by `src/features/setup/index.js`. During `init` it instantiates the `createLoggingSetup`, `createWelcomeSetup`, `createRainbowBridgeSetup`, and `createAutobouncerSetup` factories (one per feature module) and hands them shared helpers such as `panelStore`, `saveConfig`, `fetchGuild`, and `collectManageableGuilds`. Each factory must return at least three functions:

- `prepareConfig(config, context?)` — coerce/normalise config values the module expects. The setup feature calls this inside `ensureConfigShape(...)` so every module sees consistent data before any interaction fires.
- `buildView({ config, client, ... })` — render the embed + component rows for the current panel state. When an admin selects a module from the home screen, setup calls this function and caches the resulting Discord message plus view state inside `panelStore` under a `${userId}:${module}` key.
- `handleInteraction({ interaction, entry, ... })` — react to button/select/modal events, mutating the config (via `saveConfig`) and updating the stored view state. Interaction `customId` values embed the module name so `extractModuleFromInteraction(...)` can route each submission to the right handler.

Shared UI helpers (`appendHomeButtonRow`, channel/role formatting, ID sanitation, webhook validation, etc.) live in `src/features/setup/shared.js` so feature authors can reuse consistent building blocks. When you add a new module with settings, include a companion `setup.js` that exports `create<Module>Setup`, update the module dropdown in `buildHomeView(...)`, and lean on the shared helpers for consistent UX. With that file in place, the setup command automatically recognises the module and populates its panels with your custom view/interaction logic.

The central `src/features/setup/index.js` no longer exposes per-module view builders or interaction handlers; tests and follow-up features should import each module's `setup.js` factory directly when they need to exercise individual workflows.

Whenever you modify an existing module or introduce a new one, ship any required setup wiring in the same change. That means ensuring the module's `setup.js` factory exposes the right hooks, registering it with the `/setup` selector, and backfilling defaults so the panel stays functional without additional follow-up work.

## Setup panel workflows by module

Each `/setup` view ships with focused controls tailored to its feature module. Use the notes below as a quick-reference while configuring a server:

### Logging forwarder
1. Open `/setup` → **Logging forwarder** and pick a source guild from the "Select a main server…" menu. Only IDs listed under `mainServerIds` appear here.
2. Click **Link this server** to choose the logging hub channel. Squire fetches text channels and writes the mapping to `config.mapping[guildId]`.
3. Use **Configure categories** to assign dedicated channels for each logging category (messages, moderation, joins, system). The follow-up menu lists the hub categories with `⚠️` markers where a destination is missing.
4. Click **Manage exclusions** to blacklist noisy channels or whole categories per guild — the selections hydrate `config.excludeChannels`/`excludeCategories`.
5. Flip **Enable/Disable bot forwards** and **Set sample rate** to manage volume. Sample rates accept `0-1` decimals (e.g. `0.25` for 25%).
6. Use **Refresh view** after large edits or webhook maintenance to re-sync the summary embed.

### Welcome cards
1. Open `/setup` → **Welcome cards** and select a guild from the dropdown.
2. Toggle **Enable module/Disable module** to control whether join cards post for that server.
3. Tap **Configure channels** to pick welcome/leave channels and the optional rules/reminder jump links.
4. Use **Edit welcome message** to launch the modal for the text template. The preview embed updates instantly.
5. The roles sub-panel lets you mark auto-role grants and the "recent arrivals" role via the **Refresh roles** button if Discord roles were added after `/setup` launched.

### Rainbow Bridge
1. Open `/setup` → **Rainbow bridge**. Press **Create bridge** to open the modal — supply a unique bridge ID (letters/numbers/-/_), optional display name, and description.
2. Pick a bridge from the select menu and click **Manage bridge** to view its per-guild forms.
3. Use **Add channel** to provide a guild ID, channel ID, and optional webhook override. Existing forms show a ✅ status per guild.
4. Click **Remove channel** to prune a guild from the bridge — removed entries are fully unlinked so they do not reappear after saving — or **Delete bridge** to tear it down entirely (confirmation required).
5. Toggle **Enable/Disable bot mirroring** to override the default `forwardBots` flag per bridge.
6. Switch between **Switch to one-way**/**Switch to two-way** to decide whether every server mirrors messages or only designated source servers broadcast outward. When one-way mode is active, use **Edit source servers** to pick which guilds should originate mirrored posts — receivers keep their local messages untouched.
7. When a bridge mirrors a message, Squire deletes the source message before the webhook posts so only the mirrored copy remains.

### Auto bouncer
1. Open `/setup` → **Autobouncer** and pick a guild.
2. Toggle **Enable/Disable** to control whether the filter runs and **Enable/Disable bio scan** to include bio checks.
3. Tap **Edit keywords** to edit the newline-separated block list. The modal normalises to lowercase and trims duplicates.
4. Use the channel dropdown to pick a notification channel and the webhook modal to add external webhooks if desired.
5. The **Refresh roles** button reloads Discord roles so you can assign test roles for dry runs; clear individual test role assignments with **Clear test role**.

### Experience system
1. Open `/setup` → **Experience** and pick the guild to manage. Rules display in the top select menu.
2. Use **Add rule set**/**Delete rule set** to manage rule templates per guild (one active rule minimum). Each rule contains toggles for message/voice/reaction XP, reset policies, and channel blacklists.
3. Click **Edit general** for XP amounts/cooldowns, **Edit rewards** for level rewards, **Edit blacklists** for channel/role exclusions, and **Edit display** for leaderboard settings.
4. **Use current channel** captures the invoking channel ID for the level-up announcer shortcut.

### Embed builder
1. Open `/setup` → **Embed builder**. The **Select embed preset…** menu lists named presets; use **Create preset**, **Rename preset**, or **Delete preset** options from the same select to manage them. Every preset keeps its own guild/channel.
2. Pick a server in **Select target server…** and click **Set channel** to choose the posting destination (text channels only).
3. Use **Set pre-text**, **Set title**, and **Set content** to open modals for each field. Color selection lives under **Select embed color…**.
4. Manage buttons via **Manage buttons** → **Add link button** or **Clear buttons** (max five HTTPS buttons). The removal multi-select trims selected entries.
5. Click **Post embed** to send the embed immediately to the configured channel. Squire logs failures and replies with the status.

### Spotlight gallery

1. Open `/setup` → **Spotlight gallery** and choose a main server to manage.
2. Toggle **Enable module/Disable module** to control whether highlights post for that guild.
3. Use **Set channel/Change channel** to pick the highlight destination; the panel lists every text channel in the selected server.
4. Tap **Edit emojis** to provide the comma- or newline-separated list of reaction emoji that should count toward the threshold (custom emoji are supported via `<:name:id>` syntax).
5. Hit **Set threshold** to choose how many matching reactions are required and **Allow/Disallow self-reactions** to decide whether the author’s own reaction should count.

### Playlists
1. Open `/setup` → **Playlists**. The top section shows credential health for Spotify and YouTube.
2. Hit **Configure Spotify credentials** or **Configure YouTube credentials** to enter client IDs/secrets, refresh tokens, and fallback playlist IDs in modal fields.
3. Toggle **Skip duplicates: On/Off** to determine whether Spotify skips tracks already present before posting.
4. Pick a main server from the dropdown to edit per-guild playlist IDs, then click **Set Spotify playlist** or **Set YouTube playlist** to save the IDs for that server.
   - You can paste either the raw playlist ID or a full playlist URL — Squire normalises URLs to IDs automatically when saving.
5. Once both platforms are configured, `/add` mirrors submissions to both playlists whenever an exact artist/title match is found (reporting when matches cannot be located).

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
3. **Run linting & tests** — `npm run lint` and `npm test` before pushing changes. Use `npm run test:watch` while developing to keep Vitest running between edits.
4. **Type check (optional)** — `npm run build` invokes `tsc -p .` to surface declaration issues.
5. **Deploy slash commands** — `scripts/commands-sync.sh` now wraps the deployment helpers in `src/core/`. Export `WIPE_GLOBAL`,
   `SET_GLOBAL`, or `INCLUDE_DEV_COMMANDS` before running it to choose whether to wipe global commands, redeploy the production
   set from `deploy-commands.js`, and/or push feature modules to the logging guild via `src/core/commands-deploy.js`.

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

## Setup configuration guide

Follow these steps to create a `config.json` that the `/setup` module can read and update safely:

1. **Render a working file** — run `node scripts/render-config.mjs` after exporting the required environment variables. The script combines `config.sample.json` with any existing `config.json`, resolves `$ENV{VAR}` placeholders (including JSON strings for nested objects/arrays), writes the result atomically to `config.json`, and exits if any variables are missing.
2. **Locate the config** — the bot always reads `config.json` in the repository root. `/setup` mutations write back to this file via `saveConfig(...)`, so treat it as the single source of truth after rendering. Keep `config.sample.json` checked in with placeholder values only.
3. **Prime global metadata** — populate `loggingServerId`, `mainServerIds`, and any per-environment overrides (sampling rates, excluded channels, etc.). These keys gate which guilds appear inside `/setup` selectors.
4. **Fill module sections** — the `setup` factories normalise data at boot, but supplying the right shape keeps validation warnings away. Required/optional keys per module are documented below.

### Module keys the setup panel expects

All IDs must be Discord snowflakes represented as strings (e.g. `'123456789012345678'`).

#### Autobouncer (`config.autoban`)

| Key | Type | Required? | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | Optional (default `true`) | Toggle the feature without deleting the block list. |
| `blockedUsernames` | string[] | Optional (defaults to `['mega','megas','link','links']`) | Strings are normalised to lowercase. |
| `notifyChannelId` | string \| null | Optional | Target channel for human-readable ban logs. |
| `notifyWebhookUrls` | string[] | Optional | Each entry must be a Discord webhook URL; duplicates are removed. |
| `deleteMessageSeconds` | integer | Optional (default `0`) | Number of seconds of message history to purge when banning. |
| `scanBio` | boolean | Optional (default `true`) | When `true`, `/setup` allows enabling profile bio scanning. |
| `testRoleMap` | object | Optional | Maps guild IDs to "test" role IDs so `/setup` can seed overrides. |

Autobouncer also consults `config.welcome` to find fallback announcement channels for ban notices.

#### Rainbow Bridge (`config.rainbowBridge`)

| Key | Type | Required? | Notes |
| --- | --- | --- | --- |
| `forwardBots` | boolean | Optional (default `true`) | Global switch; per-bridge overrides inherit from this. |
| `bridges` | object | Optional | Map of bridge IDs to configuration objects. Each bridge requires at least two channel definitions. |

Each bridge entry supports:

- `name` (string, optional): friendly label in `/setup`.
- `forwardBots` (boolean, optional): overrides the global setting.
- `forms` (object, optional): keyed by guild ID with `{ guildId, channelId, threadId?, parentId?, webhookUrl, name? }` payloads. `/setup` maintains this shape when you edit a bridge in-place.
- `channels` (array, optional): legacy array of the same objects; normalised into `forms` at boot.

#### Experience (`config.experience`)

`config.experience` maps guild IDs to XP rule collections. Every guild entry contains:

- `rules` (array): If empty or missing, a default rule is created automatically. Each rule exposes:
  - `id` (string) and `name` (string).
  - `message`, `voice`, and `reaction` blocks with `enabled`, amount, and cooldown fields.
  - `resets` (`onLeave`, `onBan` booleans).
  - `multiplier` (number).
  - `channelBlacklist`/`roleBlacklist` (string ID arrays).
  - `levelUpChannelId` (string ID).
  - `levelUpMessage` (string template; supports `{user}`, `{level}`, `{xp}`, `{channel}`).
  - `leaderboard` block (`customUrl`, `autoChannelId`, `showAvatar`, `stackRoles`, `giveRoleOnJoin`, `statCooldownSeconds`).
  - `blacklist` block containing `channels` and `categories` arrays used across all earning sources.
- `activeRuleId` (string, optional): If omitted, the first rule is activated automatically.

#### Embed Builder (`config.embedBuilder`)

`config.embedBuilder` stores a library of named embed presets that the `/setup` panel can edit and post. The object exposes:

- `activeKey` (string): preset key that opens by default in `/setup`.
- `embeds` (object): map of preset keys to preset definitions. Each preset contains:
  - `name` (string): display name shown in the preset selector.
  - `guildId` (string \| null): default guild whose channels appear in the selector for this preset.
  - `channelId` (string \| null): target channel used when "Post embed" is pressed.
  - `preface` (string): optional message content sent before the embed (2,000 character limit).
  - `embed` (object): `{ color, title, description }` where `color` accepts hex or named swatches and text fields trim to Discord limits.
- `buttons` (array): up to five link buttons with `{ label, url }` payloads (HTTPS required).

#### Playlists (`config.playlists`)

The playlist relay keeps Spotify and YouTube credentials alongside per-guild playlist targets.

- `spotify`
  - `clientId`, `clientSecret`, `refreshToken`: OAuth credentials (sourced from the environment).
  - `playlistId`: optional fallback playlist used when a guild override is missing.
    - Accepts either a raw playlist ID or a full Spotify playlist URL; URLs are normalised to IDs automatically.
  - `skipDupes`: string/boolean flag honoured by `/setup` and the runtime when checking for duplicates.
  - `guilds`: map of guild IDs to `{ playlistId, name? }` entries. Blank IDs are valid placeholders until configured via `/setup`.
- `youtube`
  - `clientId`, `clientSecret`, `refreshToken`: OAuth credentials.
  - `playlistId`: optional fallback playlist ID.
    - Accepts either a raw playlist ID or a full YouTube playlist URL; URLs are normalised to IDs automatically.
  - `guilds`: map of guild IDs to `{ playlistId, name? }` entries.

### Using the `/setup` module

Every module exposes a guided workflow inside `/setup`. The key behaviours are:

#### Autobouncer

- Choose the module and pick a server from the dropdown to configure server-specific overrides.
- Use **Enable/Disable** to toggle the bouncer, and **Toggle bio scanning** to include or ignore profile bios when matching usernames.
- Click **Edit blocked keywords** to open a modal—enter one keyword per line; they are stored in lowercase automatically.
- The **Manage test roles** view lets you fetch guild roles and assign a temporary “test” role via a select menu; clearing the assignment removes the override.
- Channel/webhook pickers allow you to route ban notifications; any updates save immediately.

#### Embed Builder

- The preset selector at the top lists every saved embed. Use the action options in the menu to create, rename, or delete presets. Each preset keeps its own guild, channel, preface text, embed body, and buttons.
- Buttons underneath manage the embed content: set target channel, edit pre-text/title/description, adjust colours, and manage up to five link buttons.
- The **Post embed** action delivers the current preset to the configured channel. Changes are written to `config.json` as soon as they are made.

#### Experience

- Pick a guild to load its XP rules. The overview lists existing rules with options to activate, duplicate, or remove them.
- Editing a rule opens dedicated sub-views for message, voice, and reaction gains, cooldowns, level-up messaging, leaderboards, and blacklists. Each sub-view saves instantly when you toggle switches or submit modals.
- Use the rule actions to add new blocks, reorder entries, or reset to defaults; the setup module normalises IDs and cooldown values for you.

#### Logging Forwarder

- Select a source guild to view or create its mapping to the logging server. **Link this server** opens a channel picker scoped to the logging guild so you can choose a destination channel.
- The **Manage categories** flow lets you assign per-category output channels for message, moderation, join, and system logs.
- **Manage exclusions** surfaces modal-driven lists for channel/category exclusions so noisy sources can be ignored.
- Use **Forward bot messages** and **Sampling rate** to control global behaviour. All selectors enforce Discord permissions and prevent picking channels the bot cannot see.

#### Moderation Commands

- Pick any guild the bot can manage. The role multi-select lists all available roles (with missing-role markers when necessary) so you can grant or revoke access to moderation slash commands.
- The view shows a live summary of selected roles and reminds you that Administrator/Manage Server users always retain access.

#### Playlists

- Select one of the configured `mainServerIds` to focus the editor. The embed lists credential health plus the Spotify/YouTube playlist IDs currently associated with that guild.
- Use **Set Spotify playlist** or **Set YouTube playlist** to open per-guild modals where you can paste the playlist ID (leave blank to clear).
- Configure platform credentials through their respective modals and toggle Spotify duplicate detection as needed. The home row returns to the setup selector.

#### Rainbow Bridge

- The overview lists existing bridges with controls to rename them, toggle bot forwarding, or delete them.
- Opening a bridge reveals per-guild forms where you can select source channels, threads, and webhook endpoints. The module normalises IDs and backfills missing forms for any guilds in `mainServerIds`.
- Use the **Add form** action to connect new guilds, and the provided buttons to copy webhook templates or remove obsolete entries.
- The **Manage bridge** button now reveals a dropdown selector so you can pick a bridge without typing its ID.
- Inside a bridge, the **Remove channel** action displays a multi-select dropdown of linked channels instead of requiring pasted IDs.
- When someone posts in a bridged channel, Squire now reposts the message through the bridge webhook for every linked destination **including the originating channel** and then removes the member's original post so each copy stays visually identical across servers.

#### Welcome Cards

- Choose a guild to edit, then step through the tabs to configure welcome channel, role assignments, and the welcome message template.
- Channel and role selections use filtered dropdowns. Editing the message opens a modal with placeholder hints (`{username}`, `{server}`, etc.); the preview updates instantly once you submit.
- Buttons are provided to toggle the module, reset to defaults, or return to the guild selector.

### Examples

Minimal module config stub (after rendering from environment):

```json
{
  "loggingServerId": "123456789012345678",
  "mainServerIds": ["123456789012345678"],
  "autoban": {},
  "rainbowBridge": { "bridges": {} },
  "experience": {},
  "embedBuilder": {}
}
```

Full example with explicit overrides:

```json
{
  "autoban": {
    "enabled": true,
    "blockedUsernames": ["mega", "rblx"],
    "notifyChannelId": "112233445566778899",
    "notifyWebhookUrls": ["https://discord.com/api/webhooks/..."],
    "deleteMessageSeconds": 60,
    "scanBio": true,
    "testRoleMap": { "123456789012345678": "998877665544332211" }
  },
  "rainbowBridge": {
    "forwardBots": false,
    "bridges": {
      "rules-updates": {
        "name": "Rules sync",
        "forms": {
          "123456789012345678": {
            "guildId": "123456789012345678",
            "channelId": "223344556677889900",
            "webhookUrl": "https://discord.com/api/webhooks/..."
          },
          "223344556677889900": {
            "guildId": "223344556677889900",
            "channelId": "334455667788990011",
            "webhookUrl": "https://discord.com/api/webhooks/...",
            "name": "Partner rules"
          }
        }
      }
    }
  },
  "experience": {
    "123456789012345678": {
      "activeRuleId": "default",
      "rules": [
        {
          "id": "default",
          "name": "Default",
          "message": { "enabled": true, "amount": 10, "cooldownSeconds": 60 },
          "voice": { "enabled": false, "amountPerMinute": 5 },
          "reaction": { "enabled": true, "amount": 3, "cooldownSeconds": 30 },
          "resets": { "onLeave": true, "onBan": true },
          "multiplier": 1.0,
          "levelUpChannelId": "445566778899001122",
          "levelUpMessage": "{user} just reached level {level}! 🎉",
          "leaderboard": { "autoChannelId": "556677889900112233" },
          "blacklist": { "channels": ["667788990011223344"], "categories": [] }
        }
      ]
    }
  },
  "embedBuilder": {
    "activeKey": "announcements",
    "embeds": {
      "announcements": {
        "name": "Announcements",
        "guildId": "123456789012345678",
        "channelId": "889900112233445566",
        "preface": "@here Patch notes are live!",
        "embed": {
          "color": "#5865F2",
          "title": "Season Update",
          "description": "Highlights and fixes for this release."
        },
        "buttons": [
          { "label": "Read more", "url": "https://example.com/patch" }
        ]
      }
    }
  },
  "playlists": {
    "spotify": {
      "clientId": "$ENV{SPOTIFY_CLIENT_ID}",
      "clientSecret": "$ENV{SPOTIFY_CLIENT_SECRET}",
      "refreshToken": "$ENV{SPOTIFY_REFRESH_TOKEN}",
      "playlistId": "$ENV{SPOTIFY_PLAYLIST_ID}",
      "skipDupes": "$ENV{PLAYLISTS_SKIP_DUPES}",
      "guilds": {
        "123456789012345678": {
          "playlistId": "5AbCDeFgHiJkLmNo",
          "name": "Main soundtrack"
        }
      }
    },
    "youtube": {
      "clientId": "$ENV{YT_CLIENT_ID}",
      "clientSecret": "$ENV{YT_CLIENT_SECRET}",
      "refreshToken": "$ENV{YT_REFRESH_TOKEN}",
      "playlistId": "$ENV{YT_PLAYLIST_ID}",
      "guilds": {
        "123456789012345678": {
          "playlistId": "PLabc123XYZ",
          "name": "Video digest"
        }
      }
    }
  }
}
```

### Validation and boot behaviour

- Autobouncer, Rainbow Bridge, Experience, and Embed Builder each normalise their configuration during `init`, filling in defaults and trimming invalid entries. `/setup` uses the same helpers when persisting changes, so supplying the documented shapes prevents silent drops.
- When `/setup` writes updates, it immediately saves `config.json`. Keep backups or commit changes before editing live environments.
- Arrays supplied via environment variables (`RAINBOW_BRIDGE_BRIDGES_JSON`, `WELCOME_CONFIG_JSON`, etc.) must be valid JSON strings; the render script parses them before the bot boots.

### Checklist before running `/setup`

1. Render `config.json` from the latest environment.
2. Confirm `loggingServerId` and the `mainServerIds` list reference guilds the bot can manage.
3. Ensure each module section is present (even if empty objects) so `/setup` can hydrate defaults.
4. Double-check destination channel/role IDs and webhook URLs for typos.
5. Restart or reload the bot so `init` picks up the new configuration before launching `/setup`.

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
| `moderationLogging` | Optional object with `categoryChannelId`/`actionChannelId` for moderator category and action logs. |
| `excludeChannels` | Per-guild arrays of source channel IDs to ignore while forwarding. |
| `excludeCategories` | Per-guild arrays of category IDs to ignore while forwarding. |
| `rainbowBridge` | Two-way bridge config block (see below). |
| `featureOrder` | Optional array of feature folder names to control load/listener registration order. |
| `autoban` | Auto-bouncer config block (see below). |
| `welcome` | Welcome card config block (see below). |
| `experience` | Experience/XP rule definitions (normalised per guild). |
| `embedBuilder` | Saved embed preset used by the setup panel. |
| `playlists` | Spotify/YouTube playlist credentials for the `/add` command. |

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

### Playlist relay config

The playlist module reads OAuth credentials for Spotify and YouTube from `config.playlists`. Provide credentials for either (or both) platforms; missing blocks simply disable that provider while keeping `/add` available for the other one.

```json
"playlists": {
  "spotify": {
    "clientId": "${SPOTIFY_CLIENT_ID}",
    "clientSecret": "${SPOTIFY_CLIENT_SECRET}",
    "refreshToken": "${SPOTIFY_REFRESH_TOKEN}",
    "playlistId": "${SPOTIFY_PLAYLIST_ID}",
    "skipDupes": false
  },
  "youtube": {
    "clientId": "${YT_CLIENT_ID}",
    "clientSecret": "${YT_CLIENT_SECRET}",
    "refreshToken": "${YT_REFRESH_TOKEN}",
    "playlistId": "${YT_PLAYLIST_ID}"
  }
}
```

- Spotify credentials mirror the [Client Credentials + refresh token flow](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens). Set `skipDupes` to `true` (or `PLAYLISTS_SKIP_DUPES=1`) to avoid reposting tracks already in the playlist.
- YouTube credentials use the Data API v3 OAuth flow. Refresh tokens can be created with `node scripts/youtube-refresh-token.mjs`.
- The `/add` slash command validates each pasted link, adds it to the target playlist, and mirrors the cleaned URL back into the invoking channel using a managed `Squire Relay` webhook. Grant **Manage Webhooks** so Squire can create/update the relay.
- Mirrored messages post only the raw URL with `allowedMentions: { parse: [] }` so Discord unfurls the native Spotify preview or YouTube player without custom embeds.
- Failed API requests surface actionable error strings (quota exceeded, playlist not found, invalid link) inside the ephemeral reply, helping moderators correct issues quickly.

Use `node scripts/spotify-refresh-token.mjs` or `node scripts/youtube-refresh-token.mjs` to exchange auth codes for long-lived refresh tokens when rotating secrets.

### In-Discord setup panel

The `/setup` command opens an overview for operators with the **Manage Server** permission:

- Pick the logging server and the list of “main” servers once, then jump into the Logging, Moderation Logging, Welcome Cards, or Autobouncer modules from any guild.
- Logging — select which main server to configure, link it to a logging channel inside the logging server, manage excluded channels/categories, assign dedicated logging categories, and tune the sampling/bot-forwarding options.
- Moderation Logging — assign dedicated channels in the logging server for staff actions and category updates, keeping discipline chatter separate from message mirrors.
- Welcome Cards — choose a target server, set its welcome channel, and pick (or clear) the rules/roles/verify references individually.
- Rainbow Bridge — link channels across servers so messages, edits, and deletions stay in sync everywhere.
- Autobouncer — toggle the module, edit the blocked keyword list, and choose the logging server channel that receives autobounce notifications.
- Experience — curate rule sets per guild (message/voice/reaction gains, leaderboards, level-up channels) and preview XP settings before saving.
- Embed Builder — design the saved embed, edit preface text, and manage up to five HTTPS buttons for quick announcements.

Every change is persisted to `config.json`, so redeploys and restarts keep the configured state without manual file edits.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Overrides `config.token`. |
| `APPLICATION_ID` | Overrides `config.applicationId`. |
| `LOGGING_SERVER_ID` | Overrides `config.loggingServerId`. |
| `MAPPING_JSON` | JSON string (object) that replaces `config.mapping`. |
| `LOGGING_CHANNELS_JSON` | JSON object overriding `config.loggingChannels`. |
| `MODERATION_LOGGING_JSON` | JSON object overriding `config.moderationLogging`. |
| `EXCLUDE_CHANNELS_JSON` | JSON object overriding `config.excludeChannels`. |
| `EXCLUDE_CATEGORIES_JSON` | JSON object overriding `config.excludeCategories`. |
| `RAINBOW_BRIDGE_BRIDGES_JSON` | JSON object overriding `config.rainbowBridge.bridges`. |
| `MAIN_SERVER_IDS_JSON` | Overrides `config.mainServerIds`. Accepts a JSON array or a comma/space separated list of guild IDs. |
| `WELCOME_CONFIG_JSON` | JSON object overriding `config.welcome`. |
| `AUTOBAN_NOTIFY_CHANNEL_ID` | Channel ID string overriding `config.autoban.notifyChannelId`. |
| `AUTOBAN_CONFIG_JSON` | JSON object overriding the entire `config.autoban` block. |
| `AUTOBAN_NOTIFY_WEBHOOK` | Single webhook URL injected into the default `notifyWebhookUrls` list. |
| `AUTOBAN_TEST_ROLE_MAP_JSON` | JSON map of guild IDs to role IDs for the autobouncer test harness. |
| `MODERATION_ROLE_MAP_JSON` | JSON object overriding `config.moderationCommands.roleMap`. |
| `EXPERIENCE_CONFIG_JSON` | JSON object replacing `config.experience` wholesale. |
| `PLAYLISTS_SKIP_DUPES` | Truthy string/number enabling duplicate suppression for Spotify imports. |
| `SPOTIFY_CLIENT_ID` | Spotify application client ID used when rendering `config.playlists.spotify`. |
| `SPOTIFY_CLIENT_SECRET` | Spotify application client secret. |
| `SPOTIFY_REFRESH_TOKEN` | Refresh token granting write access to the target Spotify playlist. |
| `SPOTIFY_PLAYLIST_ID` | Playlist ID that receives new Spotify tracks. |
| `YT_CLIENT_ID` | YouTube Data API OAuth client ID. |
| `YT_CLIENT_SECRET` | YouTube Data API OAuth client secret. |
| `YT_REFRESH_TOKEN` | Refresh token with access to the YouTube playlist. |
| `YT_PLAYLIST_ID` | Playlist ID that receives new YouTube videos. |

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

- Keep Node.js up to date (>= 22.x) so `discord.js` and `canvacord` native dependencies work correctly.
- Feature modules are standard ES modules that export an `init(ctx)` function. The loader passes `{ client, config, logger, db }`.
- Avoid deprecated Discord API options such as `deleteMessageDays`; the code base already uses the modern replacements.
- When adding new features, create a new folder under `src/features/` with an `index.js` export—no extra wiring needed.

## License

Licensed under the [GPL-3.0](./LICENSE).
