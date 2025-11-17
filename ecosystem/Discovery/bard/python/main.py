"""
Demonstration entrypoint for Bard's logging-friendly features.

Running this file shows how each module writes to local logs and the dispatch
queue without contacting Discord directly. The steps are fully narrated so a
beginner can trace how data moves from Python to the Rust gateway.
"""

from pathlib import Path

from features import logging_forwarder, moderation_logging, starboard, welcome_card
from core import logger

# ``BOT_ROOT`` gives us the folder that owns this script. Keeping everything
# relative ensures the same code works when Bard is moved into an ecosystem's
# `Discovery/` folder or copied into a new bot entirely.
BOT_ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    """Run a short tour through Bard's modules."""

    logger.info("Starting Bard demo: showing how logs stay local and offline.")

    # 1) Record a server event and queue it for Rust to forward.
    logging_forwarder.record_server_event(
        server_id="demo-server",
        channel_id="log-channel",
        message="Test event captured by Bard",
    )
    logger.verbose(logging_forwarder.summarize_queue())

    # 2) Prepare a welcome card payload and queue it.
    welcome_payload = welcome_card.build_welcome_card(
        member_name="NewUser",
        server_name="DemoGuild",
        extra_note="Feel free to explore the channels!",
    )
    welcome_card.queue_welcome_for_rust(welcome_payload)

    # 3) Emulate reactions for the starboard and see when it triggers.
    starboard.record_reaction(
        message_id="abc123",
        author="HelpfulUser",
        content="This is a starred tip!",
        reactors=["u1", "u2"],
        threshold=3,
    )
    starboard.record_reaction(
        message_id="abc123",
        author="HelpfulUser",
        content="This is a starred tip!",
        reactors=["u1", "u2", "u3", "u4"],
        threshold=3,
    )

    # 4) Log a moderation action for review.
    moderation_logging.log_action(
        action="warn",
        moderator="ModA",
        subject="ChallengingUser",
        reason="Shared a spoiler without tags",
    )

    logger.info("Bard demo finished; inspect logs for details.")


if __name__ == "__main__":
    main()
