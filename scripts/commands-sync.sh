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

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

if is_truthy "$WIPE_GLOBAL"; then
  echo "[commands-sync] Wiping global commands via src/core/commands-wipe.js"
  node ./src/core/commands-wipe.js --global
else
  echo "[commands-sync] Skipping global wipe (WIPE_GLOBAL=$WIPE_GLOBAL)"
fi

should_deploy_global=false
if is_truthy "$SET_GLOBAL"; then
  should_deploy_global=true
fi

should_deploy_dev=false
if is_truthy "$INCLUDE_DEV_COMMANDS"; then
  should_deploy_dev=true
fi

if [[ "$should_deploy_dev" == true ]]; then
  echo "[commands-sync] Deploying feature commands to the logging guild via src/core/commands-deploy.js"
  node ./src/core/commands-deploy.js
else
  echo "[commands-sync] Skipping guild deploy (INCLUDE_DEV_COMMANDS=$INCLUDE_DEV_COMMANDS)"
fi

if [[ "$should_deploy_global" == true ]]; then
  echo "[commands-sync] Deploying global commands via deploy-commands.js"
  node ./deploy-commands.js
else
  echo "[commands-sync] Skipping global deploy (SET_GLOBAL=$SET_GLOBAL)"
fi
