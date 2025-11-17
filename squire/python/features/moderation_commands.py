"""
Moderation commands module in Python with step-by-step explanations.

Purpose
-------
Emulate the original moderation command set (warn, mute, kick, ban) using
transparent data structures. The Rust wrapper performs the actual Discord API
calls; this module only decides what should happen and records why.
"""

from typing import Dict, List


def _action_record(action: str, user_id: str, reason: str) -> Dict[str, str]:
    """
    Create a uniform record describing a moderation decision.
    """

    return {"action": action, "user_id": user_id, "reason": reason}


def warn(user_id: str, reason: str) -> Dict[str, str]:
    return _action_record("warn", user_id, reason)


def mute(user_id: str, reason: str, duration_minutes: int) -> Dict[str, str]:
    record = _action_record("mute", user_id, reason)
    record["duration_minutes"] = str(duration_minutes)
    return record


def unmute(user_id: str, reason: str) -> Dict[str, str]:
    return _action_record("unmute", user_id, reason)


def kick(user_id: str, reason: str) -> Dict[str, str]:
    return _action_record("kick", user_id, reason)


def ban(user_id: str, reason: str, delete_message_days: int = 0) -> Dict[str, str]:
    record = _action_record("ban", user_id, reason)
    record["delete_message_days"] = str(delete_message_days)
    return record


def summary(actions: List[Dict[str, str]]) -> str:
    """
    Convert a list of action records into a human-readable summary string.
    """

    lines = []
    for action in actions:
        parts = [f"action={action['action']}", f"user={action['user_id']}", f"reason={action['reason']}"]
        if "duration_minutes" in action:
            parts.append(f"duration={action['duration_minutes']}m")
        if "delete_message_days" in action:
            parts.append(f"delete_days={action['delete_message_days']}")
        lines.append(", ".join(parts))
    return "\n".join(lines)
