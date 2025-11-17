# TODO — Bard bot

## User requests deferred
- None yet.

## Agent suggestions
- Wire Bard’s Rust gateway to read `Discovery/gateway_queue.log` and deliver the queued JSON payloads (log forwards, welcomes, starboard highlights, moderation logs) to Discord using Rust-only HTTP clients.
- Consider mirroring these logging modules into other bots to keep behavior consistent when developers rearrange the ecosystem.
