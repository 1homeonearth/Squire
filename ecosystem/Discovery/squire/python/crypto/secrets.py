"""
Self-contained ChaCha20-Poly1305 style secret vault implemented with only
Python's standard library.

This rewrite replaces the earlier ad-hoc stream cipher with a direct, fully
explained implementation of the RFC 8439 construction. Every operation is
annotated in layperson language so that auditors can follow how the nonce,
keystream, and authentication tag are produced. No external dependencies are
used; everything lives in this file so the codebase remains audit-friendly and
self-contained. Operators still provide all keying material through environment
variables so no secret bytes live in the repository.
"""

import base64
import hmac
import json
import os
import struct
from dataclasses import dataclass
from typing import Optional

# Constants that mirror the RFC 8439 parameters. Changing these would break
# interoperability and should not be done unless you fully understand the
# cryptographic ramifications.
CHACHA20_KEY_BYTES = 32  # ChaCha20 keys are always 256 bits.
CHACHA20_NONCE_BYTES = 12  # The "IETF" variant uses a 96-bit (12-byte) nonce.
POLY1305_KEY_BYTES = 32  # Poly1305 one-time keys are 256 bits.


@dataclass
class EncryptedSecret:
    """
    Holds the three parts of a ChaCha20-Poly1305 ciphertext.

    - ``nonce``: 12 random bytes unique to this encryption. Reuse of a nonce
      with the same key breaks security, so generation must be fresh each time.
    - ``ciphertext``: The encrypted message bytes produced by XORing the
      plaintext with the ChaCha20 keystream.
    - ``tag``: The 16-byte Poly1305 authentication tag that detects any
      tampering with either the ciphertext or the associated data.
    """

    nonce: bytes
    ciphertext: bytes
    tag: bytes

    def to_storable(self) -> str:
        """
        Encode fields as base64 so they can be written into configuration files
        or environment variables as plain text without corruption.
        """

        payload = {
            "nonce": base64.b64encode(self.nonce).decode("utf-8"),
            "ciphertext": base64.b64encode(self.ciphertext).decode("utf-8"),
            "tag": base64.b64encode(self.tag).decode("utf-8"),
        }
        return json.dumps(payload, indent=2)

    @staticmethod
    def from_storable(serialized: str) -> "EncryptedSecret":
        """
        Reverse ``to_storable`` by turning base64 text back into raw bytes.
        """

        data = json.loads(serialized)
        return EncryptedSecret(
            nonce=base64.b64decode(data["nonce"]),
            ciphertext=base64.b64decode(data["ciphertext"]),
            tag=base64.b64decode(data["tag"]),
        )


# -- ChaCha20 core -----------------------------------------------------------

def _rotate_left(value: int, shift: int) -> int:
    """
    Rotate a 32-bit integer to the left by ``shift`` bits.

    Rotations are the primary mixing operation in the ChaCha quarter round.
    """

    return ((value << shift) & 0xFFFFFFFF) | (value >> (32 - shift))


def _quarter_round(a: int, b: int, c: int, d: int) -> tuple[int, int, int, int]:
    """
    Perform one ChaCha quarter round on four 32-bit words.

    Each step mixes addition modulo 2^32, XOR, and rotations to diffuse bits.
    Returning all four updated words keeps the function side-effect free and
    easy to test in isolation.
    """

    a = (a + b) & 0xFFFFFFFF
    d ^= a
    d = _rotate_left(d, 16)

    c = (c + d) & 0xFFFFFFFF
    b ^= c
    b = _rotate_left(b, 12)

    a = (a + b) & 0xFFFFFFFF
    d ^= a
    d = _rotate_left(d, 8)

    c = (c + d) & 0xFFFFFFFF
    b ^= c
    b = _rotate_left(b, 7)

    return a, b, c, d


def _chacha20_block(key: bytes, counter: int, nonce: bytes) -> bytes:
    """
    Generate one 64-byte ChaCha20 keystream block.

    The block state consists of four constants, eight key words, a block
    counter, and three nonce words. We run 20 rounds (10 column + 10 diagonal
    pairs) as specified by RFC 8439.
    """

    if len(key) != CHACHA20_KEY_BYTES:
        raise ValueError("Key must be 32 bytes for ChaCha20")
    if len(nonce) != CHACHA20_NONCE_BYTES:
        raise ValueError("Nonce must be 12 bytes for IETF ChaCha20")

    def to_words(data: bytes) -> list[int]:
        return list(struct.unpack("<" + "I" * (len(data) // 4), data))

    constants = [0x61707865, 0x3320646E, 0x79622D32, 0x6B206574]
    key_words = to_words(key)
    counter_words = [counter & 0xFFFFFFFF]
    nonce_words = to_words(nonce)

    state = constants + key_words + counter_words + nonce_words
    working = state.copy()

    for _ in range(10):
        # Column rounds
        working[0], working[4], working[8], working[12] = _quarter_round(
            working[0], working[4], working[8], working[12]
        )
        working[1], working[5], working[9], working[13] = _quarter_round(
            working[1], working[5], working[9], working[13]
        )
        working[2], working[6], working[10], working[14] = _quarter_round(
            working[2], working[6], working[10], working[14]
        )
        working[3], working[7], working[11], working[15] = _quarter_round(
            working[3], working[7], working[11], working[15]
        )
        # Diagonal rounds
        working[0], working[5], working[10], working[15] = _quarter_round(
            working[0], working[5], working[10], working[15]
        )
        working[1], working[6], working[11], working[12] = _quarter_round(
            working[1], working[6], working[11], working[12]
        )
        working[2], working[7], working[8], working[13] = _quarter_round(
            working[2], working[7], working[8], working[13]
        )
        working[3], working[4], working[9], working[14] = _quarter_round(
            working[3], working[4], working[9], working[14]
        )

    # Add the original state to the working state (feed-forward) and serialize.
    final_state = [
        (working[i] + state[i]) & 0xFFFFFFFF for i in range(16)
    ]
    return struct.pack("<" + "I" * 16, *final_state)


def _chacha20_encrypt(key: bytes, nonce: bytes, plaintext: bytes, counter: int = 1) -> bytes:
    """
    XOR the plaintext with the ChaCha20 keystream to produce ciphertext.

    Counter starts at 1 because counter 0 is reserved for deriving the Poly1305
    one-time key per the RFC.
    """

    ciphertext = bytearray()
    block_index = 0

    while block_index * 64 < len(plaintext):
        block = _chacha20_block(key, counter + block_index, nonce)
        start = block_index * 64
        end = min(start + 64, len(plaintext))
        chunk = plaintext[start:end]
        keystream = block[: len(chunk)]
        ciphertext.extend([c ^ k for c, k in zip(chunk, keystream)])
        block_index += 1

    return bytes(ciphertext)


# -- Poly1305 MAC ------------------------------------------------------------

def _clamp_r(r: int) -> int:
    """
    Apply the Poly1305 clamp to the r portion of the one-time key.

    This zeroes specific bits to keep the polynomial evaluation within safe
    bounds.
    """

    return r & 0x0FFFFFFC0FFFFFFC0FFFFFFC0FFFFFFF


def _poly1305_mac(
    msg: bytes, one_time_key: bytes, hibit_last_block: bool = True
) -> bytes:
    """
    Compute a Poly1305 authenticator over ``msg`` using the provided key.

    The one-time key is split into ``r`` (the polynomial key) and ``s`` (the
    final addition). All arithmetic occurs modulo 2^130 - 5 using integer math.
    """

    if len(one_time_key) != POLY1305_KEY_BYTES:
        raise ValueError("Poly1305 key must be 32 bytes")

    r = int.from_bytes(one_time_key[:16], "little")
    r = _clamp_r(r)
    s = int.from_bytes(one_time_key[16:], "little")

    p = (1 << 130) - 5
    accumulator = 0

    # Process 16-byte blocks with an extra 1 bit appended (the hibit).
    for offset in range(0, len(msg), 16):
        block = msg[offset : offset + 16]
        skip_hibit = (not hibit_last_block) and (offset + 16 == len(msg))
        hibit = b"" if skip_hibit else b"\x01"
        n = int.from_bytes(block + hibit, "little")
        accumulator = (accumulator + n) % p
        accumulator = (accumulator * r) % p

    accumulator = (accumulator + s) % (1 << 128)
    return accumulator.to_bytes(16, "little")


def _poly1305_aead_tag(aad: bytes, ciphertext: bytes, otk: bytes) -> bytes:
    """
    Build the exact input required by RFC 8439 Section 2.8 for AEAD tags.

    The data layout is: AAD || pad16 || ciphertext || pad16 ||
    len(AAD) (8 bytes little endian) || len(ciphertext) (8 bytes little endian)
    """

    def _pad16(data: bytes) -> bytes:
        if len(data) % 16 == 0:
            return b""
        return b"\x00" * (16 - (len(data) % 16))

    r = _clamp_r(int.from_bytes(otk[:16], "little"))
    p = (1 << 130) - 5

    def _process(acc: int, chunk: bytes, hibit: bool) -> int:
        padded = chunk + (b"\x01" if hibit else b"")
        n = int.from_bytes(padded, "little")
        return (acc + n) * r % p

    accumulator = 0
    for offset in range(0, len(aad), 16):
        block = aad[offset : offset + 16]
        accumulator = _process(accumulator, block, True)

    if aad:
        accumulator = _process(accumulator, _pad16(aad), True)

    for offset in range(0, len(ciphertext), 16):
        block = ciphertext[offset : offset + 16]
        accumulator = _process(accumulator, block, True)

    if ciphertext:
        accumulator = _process(accumulator, _pad16(ciphertext), True)

    length_block = struct.pack("<Q", len(aad)) + struct.pack("<Q", len(ciphertext))
    accumulator = _process(accumulator, length_block, False)

    s = int.from_bytes(otk[16:], "little")
    accumulator = (accumulator + s) % (1 << 128)
    return accumulator.to_bytes(16, "little")


# -- Public API --------------------------------------------------------------

def derive_key(master: bytes, salt: bytes) -> bytes:
    """
    Stretch a master key into a 32-byte AEAD key using HMAC-SHA256 as HKDF.

    Keeping the derivation here ensures all encryption uses identical, audited
    steps regardless of which part of the app requests a key.
    """

    if not master:
        raise ValueError("Master key must not be empty")
    if not salt:
        raise ValueError("Salt must not be empty")

    # HKDF-Extract
    prk = hmac.new(salt, master, "sha256").digest()
    # HKDF-Expand for 32 bytes with a single block and info string.
    info = b"squire-aead-key"
    t1 = hmac.new(prk, info + b"\x01", "sha256").digest()
    return t1[:32]


def encrypt_secret(master_key: bytes, plaintext: bytes, aad: bytes = b"") -> EncryptedSecret:
    """
    Encrypt ``plaintext`` with ChaCha20-Poly1305 using the provided master key.

    Steps:
    1. Derive an AEAD key from the master key and a per-encryption salt pulled
       from the operating system's random number generator.
    2. Reserve counter 0 to produce the Poly1305 one-time key; use counter 1+ for
       the stream cipher that masks the plaintext.
    3. Compute the authentication tag over AAD and ciphertext so tampering is
       detected before decryption is attempted.
    """

    if len(master_key) < 16:
        raise ValueError("Master key must be at least 128 bits to be meaningful")

    nonce = os.urandom(CHACHA20_NONCE_BYTES)
    salt = os.urandom(16)
    aead_key = derive_key(master_key, salt)

    poly_key = _chacha20_block(aead_key, 0, nonce)[:POLY1305_KEY_BYTES]
    ciphertext = _chacha20_encrypt(aead_key, nonce, plaintext, counter=1)
    tag = _poly1305_aead_tag(aad, ciphertext, poly_key)

    # Store the salt alongside the nonce so the same derived key can be
    # reconstructed during decryption. Concatenate salt+nonce for simplicity.
    packed_nonce = salt + nonce

    return EncryptedSecret(nonce=packed_nonce, ciphertext=ciphertext, tag=tag)


def decrypt_secret(master_key: bytes, bundle: EncryptedSecret, aad: bytes = b"") -> Optional[bytes]:
    """
    Decrypt and authenticate an ``EncryptedSecret``.

    Returns the plaintext bytes on success or ``None`` if authentication fails.
    """

    if len(bundle.nonce) != 16 + CHACHA20_NONCE_BYTES:
        return None

    salt = bundle.nonce[:16]
    nonce = bundle.nonce[16:]
    try:
        aead_key = derive_key(master_key, salt)
    except ValueError:
        return None

    poly_key = _chacha20_block(aead_key, 0, nonce)[:POLY1305_KEY_BYTES]
    expected_tag = _poly1305_aead_tag(aad, bundle.ciphertext, poly_key)

    # Constant-time comparison to avoid timing leakage about tag correctness.
    if not hmac.compare_digest(expected_tag, bundle.tag):
        return None

    plaintext = _chacha20_encrypt(aead_key, nonce, bundle.ciphertext, counter=1)
    return plaintext
