![Squire emblem](squire/assets/squire.png)

```
  _____                 _
 / ____|               (_)
| (___   ___ _ ____   ___  ___  _ __
 \___ \ / _ \ '__\ \ / / |/ _ \| '_ \
 ____) |  __/ |   \ V /| | (_) | | | |
|_____/ \___|_|    \_/ |_|\___/|_| |_|
```

# Course on Robot Recourse — modular, auditable Discord bot ecosystem

Bots live directly in the repository root beside the `ecosystem/` folder. Developers can run each bot on its own or move bots and even entire ecosystems into another bot or ecosystem. The layout is intentionally symmetrical: every bot and ecosystem carries a `Discovery/` directory where presence markers and message queues live so cross-communication never leaves Rust control.

All code is fully in-repo: Python and Rust files only rely on the standard library or locally defined helpers, and any behavior that once depended on an import has been copied verbatim into this repository so beginners can audit everything without external downloads.

## Folder map (recursively composable)
- `squire/`, `bard/`, `sentry/` — standalone bot folders. Drop any bot into an ecosystem’s `Discovery/` folder (or inside another bot) to enroll it; the Rust hub writes presence markers inside each `Discovery/` directory to signal when communication is allowed.
- `ecosystem/` — central Rust hub with its own `Discovery/` folder. It scans sibling bots in the repo root and any nested entries inside `Discovery/` folders to cascade presence markers.
- `assets/` — shared ASCII art (`squire_ascii.txt`) so the emblem stays reviewable without binary files.
- `security/` — security notes and the append-only IP access log.

Every folder with code has an `AGENTS.md` for behavior rules and a `TODO.md` for deferred work. The outermost TODO lists which inner TODO files contain notes so branch developers and beginners know where to look next.

## Running and compiling (no external downloads)
1. **Python path setup (per bot):** from repo root
   ```bash
   export PYTHONPATH="$(pwd)/squire/python"
   python squire/python/main.py
   ```
   Adjust the path if you run Bard or Sentry, or if you relocate a bot inside an ecosystem’s `Discovery/` folder.

2. **Rust compilation (per bot):**
   ```bash
   cd squire
   rustc rust/discord_gateway.rs -o target/discord_gateway
   rustc rust/setup_panel.rs -o target/setup_panel
   cd -
   ```
   Swap `squire` for `bard` or `sentry` to build the stubs. The ecosystem hub builds similarly when you activate the central coordinator:
   ```bash
   cd ecosystem
   rustc rust/central_comm.rs -o target/central_comm
   cd -
   ```

3. **Cargo workspace targets:** the repository now exposes a Rust workspace so offline builds have consistent binaries to stage. Build the placeholder gateways and Sentry Omega without network access:
   ```bash
   cargo build --offline --workspace --release
   ```
   Enable the `blue` feature when compiling on the air-gapped builder to include the `sentry-blue` wrapper:
   ```bash
   cargo build --offline --workspace --release --features blue -p sentry-omega --bin sentry-blue
   ```
   The helper script `build_omega.sh` enforces the offline workflow: it checks `.env` against `.env.sample`, stages bots into `build/stage/`, runs Cargo, copies binaries into `build/bin/`, and calls `sentry-omega build --bins-dir build/bin --releases-dir releases` to write the omega manifest.

4. **Slash-command sync:** each Rust gateway exposes a `sync_slash_commands` stub during `flush()` to remind operators to register slash commands. Replace the stub with a real Discord HTTP client while keeping tokens in environment variables so Python never touches the network.

5. **Logging:** Python-side loggers write to per-bot log files and a `Discovery/gateway_queue.log` dispatch file for Rust to forward. Operators can point these paths to ramdisk locations to limit exposure on compromised hosts. The root folder may collect copies for auditing; update README/AGENTS if you change paths.

## Security posture for hostile hosts
- **Secrets:** all secrets stay in environment variables. Config files store only base64 `nonce`/`ciphertext`/`tag` triples from the vault. Never place real secrets in tracked files.
- **Vault necessity:** the vault keeps Discord tokens encrypted with HKDF + ChaCha20-Poly1305 so tampering is detected before any plaintext is released.
- **Inter-bot comms:** the Rust hub writes `ecosystem_presence.txt` inside each `Discovery/` directory. Bots and nested ecosystems remain inert until that marker appears, keeping Python offline-only.
- **Hardening ideas:** keep vault keys in env vars or hardware-backed stores, zeroize buffers after use, run Rust gateways with least privilege, and use tmpfs for logs and queues.

## Recursive modular model
- Drop a **bot** into an ecosystem or another bot by placing its folder inside the host’s `Discovery/` directory. The hub then writes presence markers inside the guest’s `Discovery/` folder.
- Drop an **ecosystem** into another ecosystem or bot the same way; its own hub will cascade presence markers to anything inside its `Discovery/` folder.
- Because every entity relies on `Discovery/` folders, you can nest bots and ecosystems repeatedly while keeping each one isolated until a Rust hub acknowledges it.

## Portable feature modules (logging, welcomes, starboard, moderation logs)
- Bard carries Python modules for logging-forwarder duties, welcome cards, starboard highlights, and moderation logging. Each module resolves its paths relative to the folder it lives in, so you can copy it into another bot without edits.
- The modules never open sockets; they only write to per-bot logs and the `Discovery/gateway_queue.log` dispatch file that the Rust gateway relays to Discord. This keeps the security boundary in Rust even when bots are nested.

## Python crash course (for readers of the comments)
- **Variables:** `name = "Squire"` binds text; `count = 3` binds a number.
- **Functions:** `def greet(person):` defines reusable steps; `return` hands back a result.
- **Lists and dicts:** `[1, 2, 3]` is a list; `{ "key": "value" }` is a dictionary (like JSON objects).
- **Control flow:** `if`, `elif`, and `else` choose branches; `for item in items:` loops; `while condition:` repeats until the condition is false.
- **Imports:** standard-library modules (like `json`, `os`, `hashlib`) are allowed because they ship with Python and are visible in this repo. No third-party packages are needed.
- **Strings and bytes:** text is `str`; binary data is `bytes`. Use `.encode("utf-8")` to turn text into bytes and `.decode("utf-8")` to reverse it.
- **Error handling:** `try/except` blocks catch errors; this code often uses explicit `if` checks to keep reasoning simple.

## Learning path in this repo
Start with `squire/README.md` for the concrete bot. Read the comments in `squire/python/crypto/secrets.py` and `passwords.py` to see AEAD and scrypt. Then explore `squire/python/features/*.py` for feature modules. Finally, open the Rust gateways (`squire/rust/discord_gateway.rs` and `ecosystem/rust/central_comm.rs`) to see how cross-bot and Discord communication stay confined to Rust. Bots moved into an ecosystem keep the same internal paths relative to their folder.

## Why keep `__init__.py` small?
`python/__init__.py` files mark packages for Python’s import system. They carry short explanations for readers; removing them would break relative imports when reorganizing modules. Keeping them, even with only comments, preserves clarity across nested layouts.

## TODO files and agent workflow
Each `TODO.md` starts with usage guidance. The outermost `TODO.md` lists which bot or ecosystem TODO files contain notes so branch developers know where to look before changing code. Each nested TODO repeats the pattern for its children. Add user requests or suggestions there so future sessions stay aligned with the Creator’s instructions. Agents should always read the root README plus per-folder AGENTS before coding so beginners can follow along.
