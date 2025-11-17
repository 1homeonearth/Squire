"""
Logging forwarder module that can be copied into any bot.

Purpose
-------
- Collect structured log events from Discord servers without Python ever
  touching the network.
- Write human-readable lines to the bot's own log file and to the dispatch queue
  inside ``Discovery/`` for Rust to forward to a centralized logging channel.
- Keep all paths relative so the same file works whether it sits in Bard,
  Squire, or a new bot dropped into any ecosystem.
"""

import json  # Only used to turn dictionaries into strings for file queues.
from pathlib import Path
from typing import Dict

import core.logger as logger  # Local, fully visible logging helper.

# ``BOT_ROOT`` anchors file paths so moving the module keeps behavior intact.
BOT_ROOT = Path(__file__).resolve().parents[2]

# ``EVENT_LOG`` is a dedicated file for server events Bard processes.
EVENT_LOG = BOT_ROOT / "logs" / "logging_forwarder.log"

# ``DISPATCH_PATH`` is where the Rust gateway looks for outbound messages. The
# gateway alone will contact Discord, so Python only writes instructions here.
DISPATCH_PATH = BOT_ROOT / "Discovery" / "gateway_queue.log"


def _write_dispatch(payload: Dict[str, str]) -> None:
    """
    Append a JSON line to the dispatch queue for the Rust gateway.

    The payload is intentionally tiny so that even beginners can read it. A
    typical payload might look like:
    ``{"kind": "log", "server": "123", "text": "User joined"}``
    """

    DISPATCH_PATH.parent.mkdir(parents=True, exist_ok=True)
    with DISPATCH_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload) + "\n")


def record_server_event(server_id: str, channel_id: str, message: str) -> None:
    """
    Store a server event and enqueue a forwarding instruction.

    Parameters
    ----------
    server_id: str
        The Discord server identifier that generated the event.
    channel_id: str
        The channel the event should be forwarded to once Rust hands it to
        Discord.
    message: str
        Human-readable text to preserve.
    """

    line = f"server={server_id} channel={channel_id} note={message}"
    logger.info(f"Logging forwarder captured: {line}")

    EVENT_LOG.parent.mkdir(parents=True, exist_ok=True)
    with EVENT_LOG.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")

    _write_dispatch({
        "kind": "log",  # Signals to Rust this is a log forward request.
        "server": server_id,
        "channel": channel_id,
        "text": message,
    })


def summarize_queue() -> str:
    """
    Return a short string explaining where logs are being stored.

    Beginners can print this to verify paths without opening the files.
    """

    return (
        f"Event log: {EVENT_LOG}\n"
        f"Dispatch queue: {DISPATCH_PATH}\n"
        "Rust owns all outbound networking; Python only writes instructions."
    )
