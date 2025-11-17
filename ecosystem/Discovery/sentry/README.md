![Sentry emblem](assets/squire.png)

```
  _____                 _
 / ____|               (_)
| (___   ___ _ ____   ___  ___  _ __
 \___ \ / _ \ '__\ \ / / |/ _ \| '_ \
 ____) |  __/ |   \ V /| | (_) | | | |
|_____/ \___|_|    \_/ |_|\___/|_| |_|
```

# Sentry bot — safety-focused stub

This folder now contains Sentry Omega, the Rust crate responsible for reproducible builds and verification across the ecosystem. Sentry now lives inside the ecosystem hub’s `Discovery/` directory so the coordinator enrolls it immediately; you can move the folder into another entity’s `Discovery/` directory when you want a different hub to coordinate it. Keep explanations beginner-friendly.

All scaffolding here uses only standard-library capabilities so beginners can follow every line without external imports. The legacy Python and Rust stubs remain for reference, but the Cargo targets focus on Sentry Omega’s build and verification duties.

## Sentry Omega runtime modes
- **Blue (air-gapped builder):** compiles the workspace offline, writes manifests under `releases/`, and signs artifacts before exporting them.
- **Yellow (ecosystem verifier):** runs beside the hub, verifies itself against the omega manifest, and checks all bots discovered under `ecosystem/Discovery/`.
- **Red (independent verifier):** runs on a separate host, compares its own findings with Yellow’s signed summaries, and logs disagreements for follow-up.

Wrapper binaries pin these defaults:
- `sentry-omega` (defaults to yellow unless `--mode` overrides)
- `sentry-yellow` (yellow by default)
- `sentry-red` (red by default)
- `sentry-blue` (blue, only compiled when the `blue` feature is enabled)

## Building with Cargo
The workspace is defined at the repository root. Build Sentry Omega offline with the vendored settings in `.cargo/config.toml`:
```bash
cargo build --offline --release -p sentry-omega
```
Enable the blue wrapper when you are on the air-gapped builder:
```bash
cargo build --offline --release -p sentry-omega --features blue --bin sentry-blue
```
The helper script `build_omega.sh` automates the full offline build, staging binaries under `build/bin/` and writing manifests to `releases/` based on `SENTRY_COUNT` in `.env`.

## Operating the CLI
All binaries forward to the same CLI. Common commands:
- `sentry-omega build --bins-dir build/bin --releases-dir releases --release-id omega-dev`
- `sentry-omega verify --bins-dir build/bin --manifest releases/omega-omega-dev/manifest.txt`
- `sentry-omega daemon --bins-dir build/bin --manifest releases/omega-omega-dev/manifest.txt --interval-seconds 60`

Outputs are JSON strings suitable for log collectors. Hashes use a deterministic placeholder until a vendored cryptographic hash is added; the manifest includes a detached-signature placeholder so YubiKey-backed signing can be performed on Sentry Blue.

## TODO usage
See `TODO.md` for deferred work. Add user requests or agent suggestions there so future sessions stay aligned with the Creator’s instructions.
