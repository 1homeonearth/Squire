# IP access log

This document records IP-related access events in an append-only format. Every entry must remain verifiable via signatures, even when the content is encrypted.

## How to append entries
1. Draft the entry using the template in this file.
2. Sign the entry with the approved signing key before storing it (for example, using GPG clearsign or a detached signature).
3. If encryption is required, encrypt the signed payload to the shared recipients listed in `security/keys/README.md`.
4. Append the signed (or signed-then-encrypted) payload to the appropriate section below without modifying any existing content.

### Plaintext entries (legacy)
Use only when encryption is not required. Maintain the exact formatting of prior entries and never edit historical records.

```
#### <YYYY-MM-DD HH:MM UTC> — <context>
IP(s): <IP address list>
Action: <access/grant/revocation>
Signed-by: <signing key fingerprint>
Signature: <attached signature block or path to detached signature>
```

### Encrypted entries (preferred)
Use encrypted entries when IP details or associated context should stay confidential. The append-only constraint still applies—do not overwrite or remove prior ciphertext blocks.

Encryption steps:
1. Prepare the plaintext entry using the template above.
2. Sign the plaintext entry with the approved signing key.
3. Encrypt the signed content to the recipients documented in `security/keys/README.md` using team-managed GPG public keys or age recipients.
4. Add a new block to this section that captures the metadata needed for later verification, followed by the ciphertext.

Entry placeholder (replace with real values and ciphertext):
```
#### <YYYY-MM-DD HH:MM UTC> — <context>
Recipients: <recipient set label from security/keys/README.md>
Signed-by: <signing key fingerprint used before encryption>
Verification-notes: Decrypt, then verify signature before trust.
<--- begin encrypted log entry (GPG or age) --->
[encrypted payload]
<--- end encrypted log entry --->
```

### Verification and review
- Decrypt encrypted entries with the matching shared key material, then verify the signature against the trusted signing key before treating the entry as valid.
- Retain detached signatures and fingerprints alongside entries so future reviewers can validate integrity without guessing key provenance.
- Never delete or rewrite prior entries; add a new entry to record corrections or revocations.
