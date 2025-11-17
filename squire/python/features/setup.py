"""
Setup module rebuilt in Python with extremely verbose narration.

This module mirrors the intent of the original JavaScript setup helper that
walked operators through enabling features. Here we model the data flow without
network calls or disk writes so everything remains transparent and testable.
"""

from typing import Dict, List, Optional


def validate_channel_id(channel_id: str) -> bool:
    """
    Confirm that a channel identifier is non-empty and purely numeric.

    The original code guarded against invalid Discord IDs. This lightweight
    check mirrors that behavior without external libraries.
    """

    if channel_id is None:
        return False
    if channel_id.strip() == "":
        return False
    # ``isdigit`` ensures the value contains only digits, which matches the
    # typical shape of Discord snowflakes.
    return channel_id.isdigit()


def prepare_setup_summary(features: List[str], channels: Dict[str, str]) -> str:
    """
    Build a human-readable summary of selected features and their target channels.

    Args:
        features: list of feature names chosen by the operator.
        channels: mapping from feature name to channel ID.

    Returns:
        Multi-line string describing the setup choices.
    """

    lines: List[str] = []
    lines.append("Setup choices summary:")
    for feature in features:
        channel_id: Optional[str] = channels.get(feature)
        channel_note = channel_id if channel_id else "(no channel specified)"
        lines.append(f"- Feature '{feature}' will post in channel {channel_note}")
    return "\n".join(lines)


def interactive_mock(features: List[str]) -> str:
    """
    Provide a deterministic, in-memory demonstration of setup behavior.

    Instead of prompting for input (which would complicate automated review),
    this function constructs predictable channel identifiers and feeds them into
    ``prepare_setup_summary``. The result shows how data would flow during a real
    setup session.
    """

    channels: Dict[str, str] = {}
    for index, feature in enumerate(features):
        fake_channel = str(10_000 + index)
        channels[feature] = fake_channel
    return prepare_setup_summary(features, channels)


if __name__ == "__main__":
    demo_features = ["moderation", "logging", "rainbow_bridge"]
    summary = interactive_mock(demo_features)
    print(summary)
