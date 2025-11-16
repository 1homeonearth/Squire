# Squire (Rust rewrite bootstrap)

This repository now begins the Rust rewrite of Squire. The current state focuses on
secure bootstrapping without any third-party crates: configuration parsing,
environment variable expansion using the `$ENV{VAR}` convention, and SHA-256
fingerprinting are all implemented by hand so every byte is reviewable.

## Project layout

- `src/main.rs` — entrypoint that loads `config.json` (or `SQUIRE_CONFIG`) and prints
  SHA-256 hashes for both the config file and the compiled binary using the
  internal hashing engine.
- `src/config.rs` — hand-written JSON parser plus config loader that replaces
  `$ENV{...}` placeholders with environment variables, failing fast when required
  values are missing.
- `src/integrity.rs` — dependency-free SHA-256 implementation used to fingerprint
  inputs and outputs for manual verification.
- `config.sample.json` — template showing the expected configuration structure.

## Building and validating

1. Install Rust (pinned toolchains are recommended for reproducible builds).
2. Build the binary:
   ```bash
   cargo build --release
   ```
   The build uses only the Rust standard library—no external crates are pulled
   from the network.
3. Capture fingerprints you can compare on the target host:
   ```bash
   sha256sum target/release/squire
   sha256sum config.json
   ```

Run the binary to confirm the hashes it observes match your expectations:
```bash
./target/release/squire
```

## Configuration

Copy `config.sample.json` to `config.json` and replace values as needed. Secrets
should remain as `$ENV{VAR_NAME}` placeholders so they can be supplied through the
environment rather than stored on disk. The loader will resolve placeholders
recursively and stop execution if any required variable is missing.

Key settings:
- `discord_token` — `$ENV{DISCORD_TOKEN}`
- `application_id` — `$ENV{DISCORD_APPLICATION_ID}`
- `public_key` — `$ENV{DISCORD_PUBLIC_KEY}`
- `database_path` — file path for the embedded datastore
- `feature_flags` — toggles for subsystems while the Rust rewrite grows

## Deployment

All GitHub Actions workflows have been removed to keep automation off remote
infrastructure. Build and deploy from a trusted workstation instead:

1. `cargo build --release`
2. Verify the fingerprints locally with `sha256sum target/release/squire` and your
   `config.json`.
3. Copy the artifacts to the server using your preferred secure channel and repeat
   the hash verification before running the binary.
