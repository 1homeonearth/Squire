# Key management for IP access logging

This directory documents the signing and encryption material used for the IP access log. Store only public/verification material here; private keys belong in secure key stores managed by the team.

## Signing keys
- Approved signing key fingerprint: `<to be provided by ops>`.
- Purpose: sign every IP access log entry so reviewers can validate integrity.
- Distribution: keep the signing keypair in the team's hardware-backed store. Share only the public key in this directory when ready.
- Rotation: publish the replacement public key here before retiring the old one, and record rotation events as new log entries.

## Encryption recipients
Use one or both of the supported recipient sets when encrypting signed entries:
- **GPG recipients:** `<armored public keys or key IDs go here>`.
- **age recipients:** `<age public keys go here>`.

For each recipient set, include a short label (for example, `core-ops-2024`) so log entries can reference which set was used.

## Distribution and rotation practices
- Distribute new public keys via the team's secret manager or secure chat, then update this directory so future encryptions stay aligned.
- When rotating keys, keep the prior recipients listed until all historical entries have been re-encrypted or confirmed decryptable by the new set.
- Document key availability and retirement decisions directly in `security/ip-access-log.md` as signed entries.
