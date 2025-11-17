"""
Rainbow Bridge feature module rewritten in pure Python with exhaustive
commentary for transparency.

Purpose
-------
The original JavaScript implementation relayed messages between configured
Discord channels to create a "bridge" across servers. This Python translation
keeps the same conceptual behavior while remaining fully self contained—no
network calls, bot tokens, or external APIs are invoked here. Instead, the
module focuses on the data-handling logic that makes bridging predictable and
auditable.

High-level design
-----------------
- Messages are represented as simple dictionaries with three keys: ``author``,
  ``content``, and ``timestamp``. Using plain types keeps the flow accessible.
- A "bridge" is modeled as a pair of channel identifiers and a human-readable
  label. Channel identifiers are strings so they work in tests or simulations
  without needing real Discord IDs.
- An in-memory ledger stores every relayed message for review. This mirrors the
  prior logging behavior while avoiding file or network side effects.
- Each public function includes step-by-step comments so a reader with no
  programming background can understand how input moves through the system.
"""

import datetime
from typing import Dict, List, Optional, Tuple


class RainbowBridge:
    """
    Manages the bookkeeping for a set of channel bridges.

    Attributes
    ----------
    bridges: List[Tuple[str, str, str]]
        Every tuple holds ``(source_channel, target_channel, label)``. The label
        is a friendly name shown in audit outputs.
    ledger: List[Dict[str, str]]
        Stores a chronological record of relayed messages so operators can verify
        what moved where.
    """

    def __init__(self) -> None:
        # ``bridges`` starts empty. Operators add bridges via ``add_bridge``.
        self.bridges: List[Tuple[str, str, str]] = []
        # ``ledger`` collects dictionaries describing each relay operation.
        self.ledger: List[Dict[str, str]] = []

    def add_bridge(self, source_channel: str, target_channel: str, label: str) -> None:
        """
        Register a new bridge between two channels.

        The function accepts human-readable identifiers so it can be exercised in
        offline simulations. Storing the bridge as a tuple keeps the structure
        lightweight and easy to inspect.
        """

        self.bridges.append((source_channel, target_channel, label))

    def remove_bridge(self, label: str) -> bool:
        """
        Remove a previously added bridge by its label.

        Returns ``True`` when a bridge was found and removed, otherwise ``False``.
        The loop scans every entry and rebuilds the list without the matching
        label, ensuring immutability of existing tuples.
        """

        new_list: List[Tuple[str, str, str]] = []
        removed = False
        for source, target, entry_label in self.bridges:
            if entry_label == label:
                removed = True
                continue
            new_list.append((source, target, entry_label))
        self.bridges = new_list
        return removed

    def relay_message(self, channel: str, author: str, content: str) -> List[Dict[str, str]]:
        """
        Relay a message from ``channel`` to every bridge that listens to it.

        The function returns a list of relay reports. Each report is a dictionary
        with keys ``source``, ``target``, ``label``, ``author``, ``content``, and
        ``timestamp``. Keeping a return value makes this simple to test without
        side effects.
        """

        reports: List[Dict[str, str]] = []
        now = datetime.datetime.utcnow().isoformat() + "Z"

        for source, target, label in self.bridges:
            if source != channel:
                continue

            report = {
                "source": source,
                "target": target,
                "label": label,
                "author": author,
                "content": content,
                "timestamp": now,
            }
            self.ledger.append(report)
            reports.append(report)

        return reports

    def last_relays(self, limit: Optional[int] = None) -> List[Dict[str, str]]:
        """
        Retrieve recent relay records for auditing.

        When ``limit`` is provided, only that many most recent records are
        returned. Otherwise, the entire ledger is copied. ``list(...)`` ensures
        the caller receives a separate list that cannot mutate internal state.
        """

        if limit is None:
            return list(self.ledger)
        return list(self.ledger[-limit:])


# Convenience instance to mirror how the original module exported ready-to-use
# helpers. Users can import ``rainbow_bridge`` and interact with this shared
# bridge manager, or instantiate their own ``RainbowBridge`` for isolated tests.
default_bridge = RainbowBridge()


def demo_bridge_flow() -> None:
    """
    Demonstration helper that walks through creating a bridge and relaying a
    message with verbose print statements.

    Running this function does not require any network tokens or external
    services. It simply shows how the data structures evolve step by step.
    """

    print("Starting Rainbow Bridge demo... (all data stays in-memory)")
    default_bridge.add_bridge("channel-A", "channel-B", "demo-link")
    print("Added bridge from channel-A to channel-B labeled 'demo-link'.")
    reports = default_bridge.relay_message(
        channel="channel-A",
        author="ExampleUser",
        content="Hello across the bridge!",
    )
    print("Relay reports generated:")
    for entry in reports:
        print(entry)
    print("Ledger snapshot:")
    for entry in default_bridge.last_relays():
        print(entry)


if __name__ == "__main__":
    # Allow the module to be executed directly for a quick walkthrough without
    # importing from other files. This keeps the feature self-contained and
    # testable in isolation.
    demo_bridge_flow()
