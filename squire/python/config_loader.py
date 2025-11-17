"""
Configuration loader for the Python-based Squire secret handling demo.

This file reads JSON configuration data that mirrors ``config.sample.json`` and
explains each step with extensive comments. The goal is to keep the flow
understandable even for readers who are new to programming.
"""

import base64  # Base64 encoding/decoding keeps binary data readable in JSON files.
import hashlib  # Provides PBKDF2-HMAC-SHA256 for deriving keys from passphrases.
import json  # Handles reading and parsing JSON configuration files.
import os  # Gives access to environment variables where secrets are stored.
from dataclasses import dataclass  # Simplifies the creation of lightweight data containers.
from pathlib import Path  # Helps point at the config file inside this bot folder.
from typing import List, Optional  # Type hints keep intent obvious to readers.

from crypto import passwords
from crypto import secrets as secret_vault

# Default path to the bot-local configuration file so the demo works out of the box
# even after the repository was reorganized into per-bot folders.
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.sample.json"


@dataclass
class VaultConfig:
    """
    Represents how the vault key should be obtained.

    - ``key_env``: Name of the environment variable holding the base64-encoded
      master key. This is used when the key is not derived from a passphrase.
    - ``salt_env``: Environment variable storing the salt used when deriving the
      key from a passphrase. Keeping the salt outside the repository ensures
      decrypted secrets are impossible without runtime inputs.
    - ``derived_from_passphrase``: Boolean flag telling the loader whether to
      combine a user-provided passphrase with the salt to create the master key
      using PBKDF2-HMAC-SHA256.
    """

    key_env: str
    salt_env: str
    derived_from_passphrase: bool


@dataclass
class SecretRecord:
    """
    Represents one encrypted secret entry from the configuration file.

    Fields store the base64-encoded ciphertext, nonce (which includes the salt),
    and authentication tag produced by the ChaCha20-Poly1305 vault encryption
    routine. The values remain unreadable without the vault key supplied at
    runtime.
    """

    name: str
    nonce: str
    ciphertext: str
    tag: str


@dataclass
class AppConfig:
    """
    Aggregates the vault settings, encrypted secrets, and password hashes in a
    single structure so the rest of the program can operate on a strongly typed
    object rather than raw dictionaries.
    """

    vault: VaultConfig
    secrets: List[SecretRecord]
    password_hashes: List[str]


def _load_json(path: Path) -> dict:
    """
    Read a JSON file and return its contents as a Python dictionary.
    """

    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _derive_master_key(vault_cfg: VaultConfig) -> Optional[bytes]:
    """
    Derive or load the master key based on the configuration flags.
    """

    if vault_cfg.derived_from_passphrase:
        passphrase = os.environ.get(vault_cfg.key_env)
        salt_b64 = os.environ.get(vault_cfg.salt_env)
        if not passphrase or not salt_b64:
            return None

        salt = base64.b64decode(salt_b64)

        return hashlib.pbkdf2_hmac(
            "sha256",
            passphrase.encode("utf-8"),
            salt,
            200_000,
            dklen=32,
        )
    else:
        key_b64 = os.environ.get(vault_cfg.key_env)
        if not key_b64:
            return None
        try:
            return base64.b64decode(key_b64)
        except Exception:
            return None


def load_config(path: Path = DEFAULT_CONFIG_PATH) -> Optional[AppConfig]:
    """
    Load and parse the configuration file, returning ``AppConfig`` when
    everything is valid or ``None`` when required data is missing.
    """

    raw = _load_json(path)

    vault_cfg = VaultConfig(
        key_env=raw["vault"]["key_env"],
        salt_env=raw["vault"]["salt_env"],
        derived_from_passphrase=raw["vault"].get("derived_from_passphrase", False),
    )

    secrets: List[SecretRecord] = []
    for item in raw.get("secrets", []):
        secrets.append(
            SecretRecord(
                name=item["name"],
                nonce=item["nonce"],
                ciphertext=item["ciphertext"],
                tag=item["tag"],
            )
        )

    cfg = AppConfig(
        vault=vault_cfg,
        secrets=secrets,
        password_hashes=raw.get("password_hashes", []),
    )

    master_key = _derive_master_key(vault_cfg)
    if master_key is None:
        return None

    for record in cfg.secrets:
        bundle = secret_vault.EncryptedSecret(
            nonce=base64.b64decode(record.nonce),
            ciphertext=base64.b64decode(record.ciphertext),
            tag=base64.b64decode(record.tag),
        )
        plaintext = secret_vault.decrypt_secret(master_key, bundle)
        if plaintext is None:
            return None

    for entry in cfg.password_hashes:
        if not passwords.is_probably_valid_hash(entry):
            return None

    return cfg


def decrypt_all_secrets(cfg: AppConfig, master_key: Optional[bytes] = None) -> Optional[List[tuple[str, bytes]]]:
    """
    Decrypt every secret entry using the vault configuration embedded in
    ``cfg``. Returns a list of ``(name, plaintext_bytes)`` pairs or ``None`` if
    the key material is unavailable or authentication fails.
    """

    key_to_use = master_key if master_key is not None else _derive_master_key(cfg.vault)
    if key_to_use is None:
        return None

    decrypted: List[tuple[str, bytes]] = []
    for record in cfg.secrets:
        bundle = secret_vault.EncryptedSecret(
            nonce=base64.b64decode(record.nonce),
            ciphertext=base64.b64decode(record.ciphertext),
            tag=base64.b64decode(record.tag),
        )
        plaintext = secret_vault.decrypt_secret(key_to_use, bundle)
        if plaintext is None:
            return None
        decrypted.append((record.name, plaintext))

    return decrypted
