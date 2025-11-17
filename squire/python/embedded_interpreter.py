"""
A tiny, self-contained Python interpreter built with the standard ``code``
module. This file lives in the repository so users can inspect exactly how
interactive execution is hosted without relying on the system Python REPL.

It preloads the crypto utilities so experimentation is straightforward.
"""

import code
import sys

from crypto import passwords, secrets, integrity
from config_loader import load_config, decrypt_all_secrets


def launch_repl() -> None:
    """
    Start an interactive console with helpful variables in scope.
    """

    banner = (
        "Squire embedded interpreter\n"
        "Available names: passwords, secrets, integrity, load_config, decrypt_all_secrets.\n"
        "Type Ctrl-D to exit."
    )
    console = code.InteractiveConsole(locals={
        "passwords": passwords,
        "secrets": secrets,
        "integrity": integrity,
        "load_config": load_config,
        "decrypt_all_secrets": decrypt_all_secrets,
    })
    console.interact(banner)


if __name__ == "__main__":
    launch_repl()
