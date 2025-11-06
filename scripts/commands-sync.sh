#!/usr/bin/env bash
set -euo pipefail

# Load env (DISCORD_TOKEN, APPLICATION_ID, etc.)
if [[ -f /etc/squire/squire.env ]]; then
  # shellcheck source=/etc/squire/squire.env
  source /etc/squire/squire.env
fi

: "${DISCORD_TOKEN:?Missing DISCORD_TOKEN}"
: "${APPLICATION_ID:?Missing APPLICATION_ID}"

# Defaults (override by exporting before calling this script)
: "${WIPE_GLOBAL:=true}"
: "${SET_GLOBAL:=true}"
: "${INCLUDE_DEV_COMMANDS:=false}"

cd /opt/squire/app

# Important: these flags are *environment variables*, not CLI args.
WIPE_GLOBAL="$WIPE_GLOBAL" node scripts/wipe-commands.js
SET_GLOBAL="$SET_GLOBAL" INCLUDE_DEV_COMMANDS="$INCLUDE_DEV_COMMANDS" node scripts/deploy-all-guilds.js
