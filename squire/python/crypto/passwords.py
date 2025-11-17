"""
This module implements password hashing and verification in pure Python using
only the standard library. Everything is written in long-form explanations so a
curious reader can follow every step without prior cryptography knowledge.

Design goals
------------
- Avoid third-party dependencies so the complete logic is visible inside this
  repository. The only tools used are built into Python itself.
- Use the scrypt password-based key derivation function from ``hashlib`` because
  it is memory-hard (expensive for attackers) and battle-tested.
- Keep all parameters explicit and centralized so the same recipe is always
  applied consistently.
"""

import base64
import hashlib
import os
from typing import Dict

# ``DEFAULT_SCRYPT_PARAMS`` is a plain dictionary that lists the knobs controlling
# how scrypt behaves. The keys are intentionally verbose and hold integers that
# directly map to the parameters described in the Python documentation:
# - ``n``: CPU/memory cost parameter. Higher means slower for both defenders and
#   attackers; we choose a value that is intentionally heavy but still usable on
#   modest hardware.
# - ``r``: Block size parameter. This influences memory usage alongside ``n``.
# - ``p``: Parallelization parameter. This determines how many parallel scrypt
#   computations can be mixed together; in this standalone module we keep it at 1
#   for predictable resource use.
DEFAULT_SCRYPT_PARAMS: Dict[str, int] = {
    "n": 2 ** 15,  # 32768 iterations: intentionally high to slow offline attacks.
    "r": 8,        # Block size factor recommended by the scrypt authors.
    "p": 1,        # Single-threaded inside the function for repeatability.
}

# ``SALT_LENGTH_BYTES`` defines how many random bytes we gather for each
# password hash. Salt ensures identical passwords produce different hashes. The
# value 16 bytes (128 bits) is a widely used baseline.
SALT_LENGTH_BYTES: int = 16


def _encode_hash(salt: bytes, derived_key: bytes) -> str:
    """
    Combine the salt, the derived key, and the parameter choices into one
    portable string.

    The string format is:
    ``scrypt$n=<n>$r=<r>$p=<p>$salt=<base64>$key=<base64>``

    Using a human-readable text format (instead of a binary blob) makes it easy
    for anyone reading the configuration files to confirm what parameters were
    used without special tools.
    """

    salt_b64 = base64.b64encode(salt).decode("utf-8")
    key_b64 = base64.b64encode(derived_key).decode("utf-8")
    return (
        f"scrypt$n={DEFAULT_SCRYPT_PARAMS['n']}$r={DEFAULT_SCRYPT_PARAMS['r']}" \
        f"$p={DEFAULT_SCRYPT_PARAMS['p']}$salt={salt_b64}$key={key_b64}"
    )


def hash_password(plaintext: str) -> str:
    """
    Turn a user-provided plaintext password into a stored hash string.

    Step-by-step process explained in plain English:
    1. Generate a unique, random salt for this password using ``os.urandom``.
       The salt guarantees that two people using the same password still get
       different stored hashes, which blocks precomputed rainbow tables.
    2. Feed the plaintext, salt, and scrypt parameters into ``hashlib.scrypt``.
       The function returns a derived key that is costly for attackers to
       produce repeatedly.
    3. Encode the parameters, salt, and derived key into a single readable
       string so we can store everything required for verification later.
    """

    # Convert the incoming text into bytes because scrypt operates on byte
    # sequences rather than Python strings.
    password_bytes = plaintext.encode("utf-8")

    # Create a fresh cryptographic salt for this password hash.
    salt = os.urandom(SALT_LENGTH_BYTES)

    # Run scrypt with the centralized parameters. ``dklen`` sets the length of
    # the derived key; 32 bytes (256 bits) is plenty for verification purposes.
    derived_key = hashlib.scrypt(
        password_bytes,
        salt=salt,
        n=DEFAULT_SCRYPT_PARAMS["n"],
        r=DEFAULT_SCRYPT_PARAMS["r"],
        p=DEFAULT_SCRYPT_PARAMS["p"],
        dklen=32,
    )

    # Return the full record as a text string ready to store in config files.
    return _encode_hash(salt, derived_key)


def verify_password(plaintext: str, stored_hash: str) -> bool:
    """
    Check whether a user-entered plaintext matches the previously stored hash.

    The verifier reverses the packing performed in ``_encode_hash`` and reruns
    scrypt with the original salt and parameters. If the newly derived key
    matches the stored one, the password is correct.
    """

    # Split the stored string back into its labeled parts. The format is
    # rigidly defined in ``_encode_hash`` so we can rely on the ordering here.
    try:
        _, n_part, r_part, p_part, salt_part, key_part = stored_hash.split("$")
        n_value = int(n_part.split("=")[1])
        r_value = int(r_part.split("=")[1])
        p_value = int(p_part.split("=")[1])
        salt_b64 = salt_part.split("=")[1]
        key_b64 = key_part.split("=")[1]
    except (ValueError, IndexError):
        # If parsing fails, the stored string is malformed. Returning False keeps
        # the caller safe without crashing.
        return False

    # Decode the base64 fields back into raw bytes so we can feed them into
    # ``hashlib.scrypt`` for verification.
    salt = base64.b64decode(salt_b64)
    expected_key = base64.b64decode(key_b64)

    # Run scrypt with the exact same parameters and salt. Using the provided
    # values (rather than the defaults) ensures compatibility with hashes that
    # may have been created with different settings in the future.
    derived_key = hashlib.scrypt(
        plaintext.encode("utf-8"),
        salt=salt,
        n=n_value,
        r=r_value,
        p=p_value,
        dklen=len(expected_key),
    )

    # Perform a constant-time comparison by comparing lengths first and then
    # iterating byte-by-byte. This simple loop avoids the subtle timing
    # differences that a naive ``==`` might introduce.
    if len(derived_key) != len(expected_key):
        return False

    mismatch = 0
    for left, right in zip(derived_key, expected_key):
        mismatch |= left ^ right
    return mismatch == 0
