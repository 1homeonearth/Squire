"""
Embed Builder module in pure Python with exhaustive narration.

Purpose
-------
Create Discord-style embed payloads in a deterministic, inspectable way. The
Rust wrapper owns all outbound Discord calls; this module only shapes the data
structures and records an audit trail of what was built.

Persistence option
------------------
A simple JSON snapshot can store the last-used embed color or template so
restarts keep a consistent look without needing a separate database.
"""

import json
from typing import Dict, List, Optional


def _default_embed() -> Dict[str, object]:
    """
    Construct a base embed dictionary with empty content.
    """

    return {
        "title": "",
        "description": "",
        "color": 0x5865F2,  # Default Discord blurple for familiarity.
        "fields": [],
        "footer": "",
    }


class EmbedBuilder:
    """
    Builds embeds and remembers the last-used styling choices.

    Attributes
    ----------
    template: Dict[str, object]
        The current working embed structure.
    history: List[Dict[str, object]]
        Stores every embed generated for later review.
    persistence_path: Optional[str]
        When set, stores the latest template to disk so restarts stay consistent.
    """

    def __init__(self) -> None:
        self.template = _default_embed()
        self.history: List[Dict[str, object]] = []
        self.persistence_path: Optional[str] = None

    def set_persistence_path(self, path: str) -> None:
        self.persistence_path = path

    def set_title(self, title: str) -> None:
        self.template["title"] = title

    def set_description(self, description: str) -> None:
        self.template["description"] = description

    def set_color(self, color_int: int) -> None:
        self.template["color"] = color_int & 0xFFFFFF

    def add_field(self, name: str, value: str, inline: bool = False) -> None:
        self.template.setdefault("fields", []).append(
            {"name": name, "value": value, "inline": inline}
        )

    def set_footer(self, footer: str) -> None:
        self.template["footer"] = footer

    def build(self) -> Dict[str, object]:
        """
        Produce a finalized embed dictionary and record it in ``history``.
        """

        finalized = dict(self.template)
        self.history.append(finalized)
        return finalized

    def save(self) -> None:
        """
        Persist the latest template to disk if a path has been configured.
        """

        if not self.persistence_path:
            return
        with open(self.persistence_path, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(self.template, indent=2))

    def load(self) -> None:
        """
        Restore the template from disk if present.
        """

        if not self.persistence_path:
            return
        try:
            with open(self.persistence_path, "r", encoding="utf-8") as handle:
                self.template = json.load(handle)
        except FileNotFoundError:
            # Missing files are fine; we fall back to the default embed.
            self.template = _default_embed()
