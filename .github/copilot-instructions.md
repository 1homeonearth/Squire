# Copilot instructions

- Always read and obey `/AGENTS.md`; treat it as the authoritative source for build, test, run, deployment, and security rules unless the current user prompt explicitly overrides it.
- Never suggest committing secrets or editing systemd/firewall configuration; reference `$ENV{...}` placeholders and the deploy workflow instead.
- Prefer solutions that keep YouTube links as raw URLs to preserve Discord's native playback per the YouTube section in `AGENTS.md`.
- When suggesting CI changes, pin third-party actions by full commit SHA and grant only the minimal permissions described in `AGENTS.md`.
