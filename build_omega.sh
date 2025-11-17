#!/usr/bin/env bash
# Build script for the Sentry Omega workspace. It keeps everything offline and uses environment
# variables defined in .env to decide which Sentry binaries to stage.

set -o errexit
set -o nounset
set -o pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_SAMPLE="$ROOT_DIR/.env.sample"
ENV_FILE="$ROOT_DIR/.env"

if [[ ! -f "$ENV_SAMPLE" ]]; then
  echo "Missing .env.sample at the repository root." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Create a .env file next to .env.sample before running this script." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

required_vars=()
while IFS= read -r line; do
  case "$line" in
    ''|'#'*) continue ;;
    *) required_vars+=("${line%%=*}") ;;
  esac
done < "$ENV_SAMPLE"

missing=()
for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    missing+=("$var_name")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing required environment variables: ${missing[*]}" >&2
  exit 1
fi

if [[ -z "${SENTRY_COUNT:-}" ]]; then
  echo "SENTRY_COUNT must be set to 1, 2, or 3 in .env." >&2
  exit 1
fi

if ! [[ "$SENTRY_COUNT" =~ ^[1-3]$ ]]; then
  echo "SENTRY_COUNT must be 1, 2, or 3." >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/vendor" ]]; then
  echo "vendor/ directory is required for offline builds." >&2
  exit 1
fi

if [[ ! -f "$ROOT_DIR/.cargo/config.toml" ]]; then
  echo "Missing .cargo/config.toml; set vendored sources before building." >&2
  exit 1
fi

STAGE_DIR="$ROOT_DIR/build/stage"
BIN_DIR="$ROOT_DIR/build/bin"
RELEASES_DIR="$ROOT_DIR/releases"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
cp -r "$ROOT_DIR/ecosystem" "$STAGE_DIR/"
mkdir -p "$STAGE_DIR/ecosystem/Discovery"

for entry in "$ROOT_DIR"/*; do
  [[ -d "$entry" ]] || continue
  name="$(basename "$entry")"
  case "$name" in
    build|vendor|.git|releases|assets|target|.github) continue ;;
    ecosystem) continue ;;
  esac

  if [[ -f "$entry/AGENTS.md" && -f "$entry/README.md" ]]; then
    cp -r "$entry" "$STAGE_DIR/ecosystem/Discovery/$name"
  fi
done

rm -rf "$BIN_DIR"
mkdir -p "$BIN_DIR"
mkdir -p "$RELEASES_DIR"

BUILD_FLAGS=(--offline --release)
if [[ "$SENTRY_COUNT" -eq 3 ]]; then
  cargo build "${BUILD_FLAGS[@]}" --workspace --features blue
else
  cargo build "${BUILD_FLAGS[@]}" --workspace
fi

# Always ensure the blue wrapper exists when explicitly requested.
if [[ "$SENTRY_COUNT" -eq 3 ]]; then
  cargo build "${BUILD_FLAGS[@]}" -p sentry-omega --features blue --bin sentry-blue
fi

copy_bin() {
  local binary_name="$1"
  local source_path="$ROOT_DIR/target/release/$binary_name"
  if [[ ! -f "$source_path" ]]; then
    echo "Expected binary $binary_name was not built at $source_path" >&2
    exit 1
  fi
  cp "$source_path" "$BIN_DIR/"
}

copy_bin "ecosystem-hub"
copy_bin "squire-gateway"
copy_bin "bard-gateway"
copy_bin "sentry-omega"
copy_bin "sentry-yellow"

if [[ "$SENTRY_COUNT" -ge 2 ]]; then
  copy_bin "sentry-red"
fi

if [[ "$SENTRY_COUNT" -eq 3 ]]; then
  copy_bin "sentry-blue"
fi

"$BIN_DIR/sentry-omega" build --bins-dir "$BIN_DIR" --releases-dir "$RELEASES_DIR" --release-id "${OMEGA_RELEASE_ID:-omega-dev}"

echo "Binaries staged in $BIN_DIR"
echo "Release artifacts updated in $RELEASES_DIR"
