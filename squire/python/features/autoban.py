"""
Autoban module rewritten in pure Python with exhaustive commentary.

Purpose
-------
The original JavaScript module automatically removed disruptive users based on
repeat offenses. This translation keeps the same spirit by tracking violations
in memory, deciding when to ban based on configurable thresholds, and returning
clear audit records for the Rust wrapper to relay to Discord.

Security stance
---------------
- No network calls occur here; all Discord communication must be routed through
  the Rust wrapper described in ``rust/discord_gateway.rs``.
- All data is stored in simple Python structures. If persistence is desired, the
  Rust layer can serialize ``state`` to disk between restarts.
"""

from typing import Dict, List, Optional


class AutobanDecider:
    """
    Tracks user violations and determines when bans should occur.

    Attributes
    ----------
    state: Dict[str, int]
        Maps a user identifier to the number of recorded violations.
    threshold: int
        The number of violations required before recommending a ban.
    audit_log: List[str]
        Human-readable strings describing every decision for transparency.
    """

    def __init__(self, threshold: int = 3) -> None:
        # ``state`` remembers how many times each user has been flagged.
        self.state: Dict[str, int] = {}
        # ``threshold`` defines when a ban recommendation is triggered.
        self.threshold = threshold
        # ``audit_log`` captures decisions in plain English for reviewers.
        self.audit_log: List[str] = []

    def record_violation(self, user_id: str, reason: str) -> Optional[str]:
        """
        Increment a user's violation count and return a ban directive when the
        threshold is met. The returned string is meant for the Rust wrapper to
        forward to Discord as a moderation action.
        """

        previous = self.state.get(user_id, 0)
        updated = previous + 1
        self.state[user_id] = updated

        entry = f"User {user_id} flagged for '{reason}'. Count={updated}/{self.threshold}"
        self.audit_log.append(entry)

        if updated >= self.threshold:
            ban_note = (
                f"Ban recommended for user {user_id} after {updated} violations."
            )
            self.audit_log.append(ban_note)
            return ban_note
        return None

    def reset_user(self, user_id: str) -> None:
        """
        Clear the violation count for a user—for example, after an appeal.
        """

        if user_id in self.state:
            del self.state[user_id]
            self.audit_log.append(f"Violation history cleared for {user_id}")

    def export_state(self) -> Dict[str, int]:
        """
        Provide a copy of the internal counters so the Rust wrapper can persist
        them if desired.
        """

        return dict(self.state)

    def import_state(self, snapshot: Dict[str, int]) -> None:
        """
        Restore counters from a previously saved snapshot.
        """

        self.state = dict(snapshot)
        self.audit_log.append("State restored from external snapshot")
