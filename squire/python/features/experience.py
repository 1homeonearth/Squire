"""
Experience module reconstructed in Python with verbose, beginner-friendly notes.

Purpose
-------
Provide a transparent, dependency-free way to award experience points to users
and compute simple level information. This mirrors the original functionality
without any network access; the Rust wrapper can call these functions and then
relay results back to Discord.

Persistence
-----------
For operators who want continuity across restarts, the tracker can load/save its
state to a JSON file. The file path is controlled by the Rust layer so secrets or
paths never need to be hardcoded here.
"""

import json
from typing import Dict, Optional


class ExperienceTracker:
    """
    Manages experience points (XP) for many users.

    Attributes
    ----------
    xp: Dict[str, int]
        Maps a user ID to their accumulated XP total.
    level_scale: int
        Determines how many XP are needed per level; higher numbers slow
        progression, lower numbers speed it up.
    persistence_path: Optional[str]
        When set, ``save()`` and ``load()`` will write/read JSON to maintain
        continuity between sessions.
    """

    def __init__(self, level_scale: int = 100) -> None:
        self.xp: Dict[str, int] = {}
        self.level_scale = level_scale
        self.persistence_path: Optional[str] = None

    def set_persistence_path(self, path: str) -> None:
        """
        Enable disk persistence by storing the target JSON file path.
        """

        self.persistence_path = path

    def award_xp(self, user_id: str, amount: int) -> Dict[str, int]:
        """
        Increase a user's XP and return their new totals and level.
        """

        current = self.xp.get(user_id, 0)
        updated = current + max(0, amount)
        self.xp[user_id] = updated
        return {
            "xp": updated,
            "level": self._compute_level(updated),
        }

    def _compute_level(self, xp: int) -> int:
        """
        Translate raw XP into a level number using integer division.
        """

        return (xp // self.level_scale) + 1

    def summary(self, user_id: str) -> Dict[str, int]:
        """
        Provide the current XP and level for a user without modifying anything.
        """

        total = self.xp.get(user_id, 0)
        return {
            "xp": total,
            "level": self._compute_level(total),
        }

    def save(self) -> None:
        """
        Write the XP table to disk if a ``persistence_path`` has been provided.
        """

        if not self.persistence_path:
            return
        snapshot = {
            "xp": self.xp,
            "level_scale": self.level_scale,
        }
        with open(self.persistence_path, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(snapshot, indent=2))

    def load(self) -> None:
        """
        Load XP data from disk if a persistence file exists and matches expectations.
        """

        if not self.persistence_path:
            return
        try:
            with open(self.persistence_path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
                self.xp = {k: int(v) for k, v in data.get("xp", {}).items()}
                self.level_scale = int(data.get("level_scale", self.level_scale))
        except FileNotFoundError:
            # It is safe to ignore missing files; the tracker will simply start fresh.
            pass
