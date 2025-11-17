"""
Integrity helpers that use SHA-256 and HMAC from Python's standard library.

The functions here are intentionally verbose to demystify what hashing and HMAC
mean in practice.
"""

import hashlib
import hmac
from typing import Tuple


def sha256_digest(data: bytes) -> str:
    """
    Compute the SHA-256 hash of ``data`` and return it as a hexadecimal string.

    Hashes are one-way fingerprints: changing even a single byte of input
    drastically alters the output. This property is useful for detecting file
    corruption or tampering.
    """

    digest = hashlib.sha256(data).hexdigest()
    return digest


def hmac_sha256(key: bytes, data: bytes) -> str:
    """
    Compute an HMAC tag using SHA-256.

    HMAC (Hash-based Message Authentication Code) mixes a secret key with the
    message so the resulting tag proves the data came from someone who knows the
    key. It also protects against tampering because any modification changes the
    tag.
    """

    tag = hmac.new(key, data, hashlib.sha256).hexdigest()
    return tag


def hkdf_sha256(secret: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    """
    A friendly wrapper around the HKDF logic used elsewhere in the repository.

    HKDF allows us to take a master secret (like a vault key) and stretch it into
    multiple independent keys. The ``salt`` defends against precomputation and
    the ``info`` string labels the purpose of the derived key material.
    """

    # Import locally to avoid a circular dependency with ``crypto.secrets``.
    import hmac as _hmac

    prk = _hmac.new(salt, secret, hashlib.sha256).digest()
    blocks = []
    last_block = b""
    while len(b"".join(blocks)) < length:
        last_block = _hmac.new(prk, last_block + info + bytes([len(blocks) + 1]), hashlib.sha256).digest()
        blocks.append(last_block)
    return b"".join(blocks)[:length]


def compare_constant_time(left: bytes, right: bytes) -> bool:
    """
    Perform a timing-safe comparison between two byte strings.

    This helper avoids the pitfalls of naive equality checks that might leak how
    many prefix bytes match through timing measurements.
    """

    return hmac.compare_digest(left, right)
