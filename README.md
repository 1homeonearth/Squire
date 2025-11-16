# Squire — Utility Bot for The Unbreakable Crown
<!-- simple -->
![Squire](assets/Squire.png)

## Security logging
- IP access events are recorded in an append-only log at `security/ip-access-log.md`.
- Entries must be signed, and sensitive details can be encrypted using the shared recipient keys documented in `security/keys/README.md`.

## Data backup
- A read-only backup branch named `backup-data` was created from commit `20affdfa38f68391766a464e2aa04f06df2a2674` to preserve the current repository state without merging it into `main`.
