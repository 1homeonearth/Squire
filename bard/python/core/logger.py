"""
Simple, beginner-friendly logging helpers for Bard.

Goals for this file:
- Stay dependency-free and readable so you can copy it into any bot.
- Keep all paths relative to the bot folder so logs remain contained even when
  the bot is moved into an ecosystem's `Discovery/` directory.
- Double-write important lines into `Discovery/gateway_queue.log` so the Rust
  gateway can forward them to a Discord logging channel without Python opening
  network sockets.
"""

import datetime  # Supplies human-readable timestamps without extra packages.
from pathlib import Path  # Lets us build file paths safely on any platform.

# ``BOT_ROOT`` always points to the folder two levels above this file. Because
# the module lives at ``bot/python/core/logger.py``, ``parents[1]`` gives us the
# bot root whether the bot sits at repo root or inside another bot's
# ``Discovery/`` directory.
BOT_ROOT = Path(__file__).resolve().parents[2]

# ``DEFAULT_LOG`` is where Bard records its own activity. The file lives inside
# the bot folder to avoid surprising writes elsewhere on a compromised host.
DEFAULT_LOG = BOT_ROOT / "logs" / "bard.log"

# ``DISPATCH_LOG`` is the queue the Rust gateway watches. The gateway runs all
# Discord network calls, so Python simply appends lines here for Rust to pick up.
DISPATCH_LOG = BOT_ROOT / "Discovery" / "gateway_queue.log"


def _timestamp() -> str:
    """Return an ISO-style timestamp string for consistent log lines."""
    return datetime.datetime.utcnow().isoformat() + "Z"


def _ensure_parent(path: Path) -> None:
    """Create parent directories if they do not yet exist."""
    if not path.parent.exists():
        path.parent.mkdir(parents=True, exist_ok=True)


def log(level: str, message: str, file_path: Path | None = None) -> None:
    """
    Write a single log line.

    Parameters
    ----------
    level: str
        A short label like "INFO" or "ERROR" to categorize the message.
    message: str
        The descriptive text to record.
    file_path: Path | None
        Optional override for the destination file. When omitted, ``DEFAULT_LOG``
        is used so beginners do not need extra configuration.

    Behavior
    --------
    - Always writes to the chosen file.
    - Also mirrors the same line to ``DISPATCH_LOG`` so the Rust gateway can
      forward it to an out-of-process logging server without exposing Python to
      the network.
    """

    target = file_path or DEFAULT_LOG
    line = f"[{_timestamp()}] {level.upper()}: {message}"

    _ensure_parent(target)
    _ensure_parent(DISPATCH_LOG)

    # Write to the primary log file.
    with target.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")

    # Mirror to the dispatch queue for Rust forwarding.
    with DISPATCH_LOG.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def info(message: str) -> None:
    """Record a low-stakes informational line."""
    log("INFO", message)


def warn(message: str) -> None:
    """Record something that might need attention soon."""
    log("WARN", message)


def error(message: str) -> None:
    """Record an error without hiding any details."""
    log("ERROR", message)


def verbose(message: str) -> None:
    """Record chatty detail for readers who want to trace control flow."""
    log("VERBOSE", message)
