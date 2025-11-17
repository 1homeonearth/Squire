"""
Moderator logging module.

This file records moderation actions (warnings, kicks, bans) and prepares
structured messages for the Rust gateway to deliver to a logging channel. It is
self-contained so you can copy it into any bot folder without edits.
"""

import json
from pathlib import Path
from typing import Dict

import core.logger as logger

BOT_ROOT = Path(__file__).resolve().parents[2]
MOD_LOG = BOT_ROOT / "logs" / "moderation.log"
DISPATCH_PATH = BOT_ROOT / "Discovery" / "gateway_queue.log"


def _write_local(entry: Dict[str, str]) -> None:
    """Append a moderation entry to the local log file for auditing."""
    MOD_LOG.parent.mkdir(parents=True, exist_ok=True)
    with MOD_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


def _queue_for_rust(entry: Dict[str, str]) -> None:
    """Append the same entry to the dispatch queue for Rust delivery."""
    DISPATCH_PATH.parent.mkdir(parents=True, exist_ok=True)
    with DISPATCH_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


def log_action(action: str, moderator: str, subject: str, reason: str) -> None:
    """
    Record a moderation action.

    Parameters
    ----------
    action: str
        Type of action, such as "warn", "kick", or "ban".
    moderator: str
        Who performed the action.
    subject: str
        Who the action targeted.
    reason: str
        Plain-language explanation that will help with later reviews.
    """

    entry = {
        "kind": "moderation_log",  # Rust can route logs using this marker.
        "action": action,
        "moderator": moderator,
        "subject": subject,
        "reason": reason,
    }

    logger.info(
        f"Moderation action captured: {action} by {moderator} on {subject} because {reason}"
    )
    _write_local(entry)
    _queue_for_rust(entry)
