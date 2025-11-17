"""
Self-contained REPL runner that stays inside the repository folder.

This script exists to honor the request that Python be "installed to the repo"
by shipping a small interpreter front-end alongside the code. It simply wraps
Python's built-in ``code`` module so users can start an interactive shell while
preloading Squire modules without leaving the project directory.
"""

import code
import os
import sys


def launch_repl() -> None:
    """Start an interactive console with repository paths preloaded."""

    project_root = os.path.dirname(os.path.abspath(__file__))
    # Ensure the repo's ``python`` package is discoverable even if the user runs
    # this script via an absolute path.
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

    banner = (
        "Squire embedded REPL (runs from the repo folder)\n"
        "Preloaded modules: crypto, core, lib, features\n"
    )
    # ``locals`` preloads the primary packages so they can be explored directly.
    console_locals = {
        "crypto": __import__("crypto"),
        "core": __import__("core"),
        "lib": __import__("lib"),
        "features": __import__("features"),
    }

    # ``code.InteractiveConsole`` hosts the REPL loop with our custom banner.
    console = code.InteractiveConsole(locals=console_locals)
    console.interact(banner=banner)


if __name__ == "__main__":
    launch_repl()
