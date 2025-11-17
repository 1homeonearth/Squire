"""
Welcome card builder that avoids network calls.

Purpose
-------
- Shape a friendly welcome payload for a new member using only in-repo data.
- Keep output as plain dictionaries so any bot can hand them to its Rust gateway
  for delivery over Discord.
- Provide step-by-step comments for beginners moving the module between bots or
  ecosystems.
"""

import json
from pathlib import Path
from typing import Dict, Optional

import core.logger as logger

# ``BOT_ROOT`` points to the folder that owns this module, no matter where the
# folder is placed in an ecosystem. That makes the paths safe to relocate.
BOT_ROOT = Path(__file__).resolve().parents[2]

# ``TEMPLATE_PATH`` shows where a developer could place a JSON or text template
# for welcome messages. The module works without it; the file is optional.
TEMPLATE_PATH = BOT_ROOT / "data" / "welcome_template.txt"


def build_welcome_card(member_name: str, server_name: str, extra_note: Optional[str] = None) -> Dict[str, str]:
    """
    Create a dictionary representing a welcome card.

    The dictionary shape is intentionally simple so it can be serialized to JSON
    and passed through the Rust gateway without Python making HTTP requests.
    """

    greeting = f"Welcome to {server_name}, {member_name}!"
    body_lines = [greeting]
    if TEMPLATE_PATH.exists():
        template_text = TEMPLATE_PATH.read_text(encoding="utf-8")
        body_lines.append(template_text)
    if extra_note:
        body_lines.append(extra_note)

    payload = {
        "kind": "welcome_card",  # Rust can branch on this value.
        "title": greeting,
        "body": "\n".join(body_lines),
    }

    logger.info(f"Prepared welcome card for {member_name} in {server_name}")
    return payload


def queue_welcome_for_rust(payload: Dict[str, str]) -> None:
    """
    Append the payload to the dispatch queue so Rust can send it.

    The function writes JSON text into ``Discovery/gateway_queue.log`` where the
    Rust gateway already listens for instructions. Keeping the format consistent
    means you can move this file into another bot and it will behave the same.
    """

    dispatch_path = BOT_ROOT / "Discovery" / "gateway_queue.log"
    dispatch_path.parent.mkdir(parents=True, exist_ok=True)
    as_text = json.dumps(payload)
    with dispatch_path.open("a", encoding="utf-8") as handle:
        handle.write(as_text + "\n")
    logger.verbose(f"Enqueued welcome payload: {as_text}")
