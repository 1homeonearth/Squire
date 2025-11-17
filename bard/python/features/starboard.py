"""
Starboard (Spotlight Gallery) module.

This module watches for messages that earn enough positive reactions and prepares
summaries for the Rust gateway to post in a highlight channel. It never touches
Discord directly; it only writes structured instructions for Rust to send.
"""

import json
from pathlib import Path
from typing import Dict, List

import core.logger as logger

BOT_ROOT = Path(__file__).resolve().parents[2]
STARBOARD_LOG = BOT_ROOT / "logs" / "starboard.log"
DISPATCH_PATH = BOT_ROOT / "Discovery" / "gateway_queue.log"


def _serialize(payload: Dict[str, str]) -> str:
    """Convert a payload dictionary into a JSON string."""
    return json.dumps(payload)


def record_reaction(message_id: str, author: str, content: str, reactors: List[str], threshold: int = 3) -> None:
    """
    Handle a reaction update and queue a starboard post if the threshold is met.

    Parameters
    ----------
    message_id: str
        Identifier of the original message to spotlight.
    author: str
        Display name or ID of the message author.
    content: str
        The text content to highlight.
    reactors: List[str]
        The users who have reacted so far.
    threshold: int
        Minimum number of reactions to trigger a starboard entry.
    """

    count = len(reactors)
    logger.verbose(f"Starboard check for message {message_id}: {count} reactions")

    if count < threshold:
        logger.info("Threshold not met; recording only in local log.")
    else:
        payload = {
            "kind": "starboard",  # Rust can route by this value.
            "message_id": message_id,
            "author": author,
            "content": content,
            "reactor_count": count,
        }
        _write_logs(payload)
        _queue_for_rust(payload)
        return

    _write_logs({
        "kind": "starboard_preview",
        "message_id": message_id,
        "reactor_count": count,
        "note": "Below threshold; keeping local for now.",
    })


def _write_logs(entry: Dict[str, object]) -> None:
    """Append a dictionary to the starboard log for human auditing."""
    STARBOARD_LOG.parent.mkdir(parents=True, exist_ok=True)
    with STARBOARD_LOG.open("a", encoding="utf-8") as handle:
        handle.write(_serialize({k: str(v) for k, v in entry.items()}) + "\n")


def _queue_for_rust(payload: Dict[str, object]) -> None:
    """
    Append the payload to ``gateway_queue.log`` so the Rust gateway can post it.
    """
    DISPATCH_PATH.parent.mkdir(parents=True, exist_ok=True)
    with DISPATCH_PATH.open("a", encoding="utf-8") as handle:
        handle.write(_serialize({k: str(v) for k, v in payload.items()}) + "\n")
    logger.info(f"Queued starboard spotlight for message {payload.get('message_id')}")
