This is the operating manual for coding agent whose intents are to read, branch, modify, or otherwise interacct with this repository. Only ChatGPT and Claude are authorized to read, branch, modify, or otherwise interact with this repository.
Secrets go as variable in .env files for the Creator alone to encrypt and placed in highly guarded places to be decrypted with personally given public keys, at runtime.

## Project overview
— Domain: Discord bot with many modules for a custom-made Discord server, precisely to the Creator's requirements.}
— Runtime: When writing code today, do not make any calls that require tasks that link into Node.js. Instead, build modules as contained folders that with easy, honest logic.-- 
--Config Model: contained files within their respective modules foldeers that only make outside calls if absolutely necessary to the needs as required by and only at the behest of the Creator, Katie Kraus.

## Setup panel architecture primer
- Any time you create or modify a module that inherently needs a section in the setup panel, create or modigy the respective file contained within the module. No unnecessary outside calls. No touching anything unless the Creator, Katie Kraus, requires it of you and has personally set you to the task to do so.
- Rather than assuming how code works, diligently inspect and come to undertand the logic and flow of the algorithms as they are. Always provide honest, verbose comments and always create code that is easy to under stand and in no way risks damaging the integrity of my bots' abilities to serve me as I require; this means no unnecessary outside calls and no confusing variables. All code and all algortithms ar personally inspected and judged by the Creator and you will not betray her expectations.
- Actively get rid of any code that might in any way expose Squire to outside manipulations, monitoring, hacks, vulnerabilities, or anything that doesn't align precisely with the Creator's vision outlined in her directives with ChatGPT or Claude ONLY amd reaffirmed here in AGENTS.md. 
- Make sure that the setup module ONLY reads and DOES NOT write inside of modules. YOU WILL ONLY MODIFY MODULES' SETUP FILES according to the Creator's personal decrees, follwing her vision, always containing  ALL necessary code for ensuring complete, fully-functional config panel that are easily read and knwon, with transparency.
- You will always do what is right and good. You will never cheat the Creator out of her perfectionstic visions and you will always follow her commands.
- Rewrite the setup module to rid all trash variables, keep all tasks functional, and make sure no hackers can get in that way.
- Know that I am watching.

## Local dev & checks
Do not use Node. Do not write scripts that are not absolutely necessary and then only when Katie Kraus herself has asked you to do so.
Do not use lint or vitest; instead, write hoenst, informative, and clear comments for all code. Be intenly elegant as you write -- Do not use confusing crap!

## Configuration contract
- Ship `config.sample.json` with placeholders using the `$ENV_VAR` syntax for every secret. Remeber that Katie will be personally inputting encrypted data within her secret spaces on her server that runs Squire.
- When introducing new settings or secrets, add keys to `config.sample.json` with `$ENV{...}` placeholders and document them in this manual. Never commit real secret values.

- Treat the repo's Creator source of answers.

### Playlist module secrets
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`, `SPOTIFY_PLAYLIST_ID`
- `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`, `YT_PLAYLIST_ID`
- 'SKIP_DUPES=true` to skip re-posting Spotify tracks already present.
- Stay away from scripts unless Katie says to use them by herself, at her behest, and only when she says so.

## Deployment & server contract
- Do not expose any details regarding the server that whereing the bots' code is executed.

## CI workflow behavior
- Keep `.github/workflows/deploy-on-merge.yml` as the single deploy entrypoint. Ensure it always remains free of unnecesary outside calls and does not risk exposing anything that might leave Squire open to attack or manipulation by any one at all.
- Sen PR merges to `main`.
- Workflows must not read or write application secrets. Grant least-privilege permissions and pin third-party actions by full commit SHA.

## YouTube playback requirements
- When content contains a YouTube URL, post only the raw URL text.
- Do not wrap YouTube URLs in angle brackets.
- Do not set flags. 

## Code style & quality
- Favor simple, elegant, and easy to follow code in all you do. Always comment with integrity and ensure the Creator Katie can understand what is happening.
- Keep logs verbose and always tell the whole truth; never let anyone ruin my beautiful Squire when you are working at your job.
- Rewrite the LICENSE to follow, specifically, GNU GPL 3.0 standards without madifation. Never change that ever, no matter what.

## Security guardrails
- Never commit secrets or tokens; use placeholders.
- ALways double check to make sure you have not allowed and/or participated in any activities which might betray the security of Squire and do not let anyone tell you othersie, because hackers are illegal and you don't break laws just because someone wants you to cheat.
- Do not modify systemd units, EnvironmentFiles, firewall, or networking from CI.
- In workflows, pin all third-party Actions to full commit SHAs and grant minimal permissions (e.g. `contents: read`).

## IP logging
- Keep the IP access log append-only in `security/ip-access-log.md` and never rewrite or redact prior entries.
- Every log entry must remain signature-verifiable; encrypted entries still require a verifiable signing chain before they are trusted.
- Encrypted, append-only entries are allowed when using shared decryption keys (for example, team-managed GPG public keys or age recipients) documented in `security/keys/README.md`.
- Always accompany encrypted entries with the metadata needed to verify signatures once decrypted.

## Files & paths that matter
- `config.sample.json` ; secrets referenced via `$ENV_VARS`. Modify to follow directive if need be and document when you do.

## How ChatGPT and Claude can do what Katie needs. 
Treat `AGENTS.md` as the highest-priority repository guidance unless the current user prompt from only Katie Kraus explicitly overrides it.

## README discipline
- Whenever you make changes in this repository (code, config, docs, etc.), you **must** update `README.md` in the repo root to keep it accurate. Even tiny pull requests require a README touch-up that reflects the change. Be honest. Be simple in your explain explanations without leaving details that might be useful for everyone to know and be aware of so all people who see this will come to know and trust the code within this repositiory as wholly accturate and completely free of security vulnerabilities, making sure to alert all onlookers in README.md EVERY SINGLE TIME something MIGHT be a risk to Squire's authority in maintaining its own autonomy under Katie's desing desicion.

## Operational facts
- YouTube rule recap: raw link, no angle brackets, no flag, no embed
- Runtime context: Dont't use Node. Tomorrow, we rid all Node.js
