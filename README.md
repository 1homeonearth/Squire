# Squire — Utility Bot for The Unbreakable Crown
<!-- simple -->
![Squire](assets/Squire.png)

## Security logging
- IP access events are recorded in an append-only log at `security/ip-access-log.md`.
- Entries must be signed, and sensitive details can be encrypted using the shared recipient keys documented in `security/keys/README.md`.

## Rust rewrite and secret handling
- The `rust/` directory contains the Rust-based rewrite for Squire's cryptography and configuration loader.
- Password-like credentials use Argon2id via `crypto::passwords::hash_password` and `verify_password`, keeping the hashing policy centralized.
- Decryptable secrets (Discord tokens, API keys, application IDs) are stored as AEAD envelopes (`nonce`, `ciphertext`, `tag`) and decrypted at runtime with `crypto::secrets::SecretVault`.
- Integrity helpers live in `crypto::integrity` for SHA-256, HMAC, and HKDF tasks without mixing concerns with password hashing or encryption.
- Configuration files should only contain encrypted values for secrets. The `vault` block documents how to provide the symmetric key (environment variable, key file, or passphrase + salt).

### Configuration expectations
- `config.sample.json` now documents encrypted secrets under `encryptedSecrets` alongside the `vault` block describing how the Rust loader fetches the key material.
- Keep the `SQUIRE_VAULT_KEY` environment variable (base64-encoded 32-byte key) or `SQUIRE_VAULT_PASSPHRASE_ENV` + `SQUIRE_VAULT_SALT_B64` available to decrypt values at runtime. These values can be stored encrypted in-repo (for example, GPG-armored) so auditors can verify them against published public keys.
- Plaintext fields remain for legacy Node paths, but new Rust code should rely on the encrypted envelopes only.

### CLI usage (Rust)
- Build and run from `rust/`:
  - `cargo run -- hash-password "plaintext"` → prints an Argon2id hash.
  - `cargo run -- verify-password "plaintext" "<argon2-hash>"` → prints `match` or `no-match`.
  - `SQUIRE_VAULT_KEY=<base64key> cargo run -- encrypt-secret SQUIRE_VAULT_KEY "secret"` → emits the JSON envelope to embed under `encryptedSecrets`.
  - `SQUIRE_VAULT_KEY=<base64key> cargo run -- decrypt-secret SQUIRE_VAULT_KEY '<envelope-json>'` → prints the plaintext.
  - `cargo run -- hash-bytes "data"` → prints the SHA-256 hex digest.
  - `cargo run -- load-config ./config.json` → loads a JSON config with encrypted secrets and prints non-sensitive fields.

All cryptographic operations are confined to Rust crates; no external runtimes are required.
