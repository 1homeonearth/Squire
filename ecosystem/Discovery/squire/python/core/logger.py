"""
A faithful Python recreation of the original `src/core/logger.js` module.

This file is intentionally long-winded and heavily commented so that a newcomer
(or even a curious child) can read line by line and understand every moving
piece. No external libraries are used—only the Python standard library—so the
entire logging pipeline is visible within this repository.
"""

import datetime  # Standard-library time handling for timestamps.
import os  # Used to resolve default log file locations inside the bot folder.

# `BASE_DIR` pins all file output to the bot’s own folder even if the process is
# launched from somewhere else. This reduces the risk of logs spilling into
# unexpected locations on a compromised host.
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# `LEVELS` maps human-friendly names to numeric values. Higher numbers mean
# "more verbose" logging. We keep the dictionary small to mirror the original
# behavior: `none` disables logging, `info` prints normal information, and
# `verbose` prints the most detail.
LEVELS = {
    "none": 0,
    "info": 1,
    "verbose": 2,
}


# The logger can optionally write to two files:
# - `BOT_LOG_PATH` captures per-bot logs for local auditing.
# - `CENTRAL_DISPATCH_PATH` lets the Rust gateway forward logs to a Discord
#   logging channel without Python opening any sockets.
# Defaults are anchored to the bot directory for predictability; operators can
# override them with environment variables to use tmpfs or other hardened paths.
BOT_LOG_PATH = os.environ.get(
    "SQUIRE_BOT_LOG", os.path.join(BASE_DIR, "logs", "bot.log")
)
CENTRAL_DISPATCH_PATH = os.environ.get(
    "SQUIRE_DISPATCH_LOG", os.path.join(BASE_DIR, "Discovery", "gateway_queue.log")
)


def _timestamp() -> str:
    """
    Create a human-readable timestamp string.

    The original JavaScript code produced a time like "12:34:56" by taking the
    ISO-formatted date and trimming off the date portion. Here we use Python's
    datetime tools to achieve the same result. Every step is spelled out to
    avoid magic.
    """

    now = datetime.datetime.now()
    time_only = now.time()
    time_without_fraction = time_only.replace(microsecond=0)
    return time_without_fraction.isoformat()


def _with_timestamp(sink_function):
    """
    Wrap another function so that it automatically prefixes messages with a
    timestamp. The wrapper returns a new function that, when called, will insert
    the timestamp before forwarding all arguments.
    """

    def wrapper(*args):
        timestamped_args = (f"[{_timestamp()}]",) + args
        sink_function(*timestamped_args)

    return wrapper


def _write_line(path: str, line: str) -> None:
    """
    Append a single line to the given path, creating parent folders as needed.
    """

    folder = os.path.dirname(path)
    if folder and not os.path.exists(folder):
        os.makedirs(folder, exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def create_logger(level: str = "info", log_to_file: bool = True) -> dict:
    """
    Build a structured logger similar to the JavaScript original.

    Parameters
    ----------
    level : str
        The desired minimum log level. Accepts "none", "info", or "verbose".
    log_to_file : bool
        When true, messages are also written to `BOT_LOG_PATH` and the central
        dispatch file so Rust can forward them securely.

    Returns
    -------
    dict
        A dictionary containing four callables: `info`, `verbose`, `warn`, and
        `error`. Each callable mirrors console behavior with timestamped output
        and level filtering where appropriate.
    """

    current_level = LEVELS.get(level, LEVELS["info"])

    info_sink = _with_timestamp(print)
    verbose_sink = _with_timestamp(print)
    warn_sink = _with_timestamp(print)
    error_sink = _with_timestamp(print)

    def _fan_out(message: str):
        if log_to_file:
            _write_line(BOT_LOG_PATH, message)
            _write_line(CENTRAL_DISPATCH_PATH, message)

    def info(*args):
        if current_level >= LEVELS["info"]:
            joined = " ".join(str(part) for part in args)
            info_sink(joined)
            _fan_out(joined)

    def verbose(*args):
        if current_level >= LEVELS["verbose"]:
            joined = " ".join(str(part) for part in args)
            verbose_sink(joined)
            _fan_out(joined)

    def warn(*args):
        joined = " ".join(str(part) for part in args)
        warn_sink(joined)
        _fan_out(joined)

    def error(*args):
        joined = " ".join(str(part) for part in args)
        error_sink(joined)
        _fan_out(joined)

    return {
        "info": info,
        "verbose": verbose,
        "warn": warn,
        "error": error,
    }


if __name__ == "__main__":
    demo_logger = create_logger(level="verbose")
    demo_logger["info"]("Logger demo", "shows", "info level")
    demo_logger["verbose"]("Verbose mode", "reveals extra details")
