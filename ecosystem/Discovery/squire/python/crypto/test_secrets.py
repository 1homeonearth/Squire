"""Lightweight tests for the ChaCha20-Poly1305 vault.

These tests run with the Python standard library so beginners can execute
`python -m unittest squire.python.crypto.test_secrets` without extra
packages. The vectors come from RFC 8439 so they can be compared with
other implementations.
"""

import unittest

from squire.python.crypto import secrets


class ChaCha20Poly1305Tests(unittest.TestCase):
    def test_chacha20_block_matches_rfc_vector(self):
        """Validate the keystream block against RFC 8439 section 2.3.2."""

        key = bytes([
            0x00,
            0x01,
            0x02,
            0x03,
            0x04,
            0x05,
            0x06,
            0x07,
            0x08,
            0x09,
            0x0A,
            0x0B,
            0x0C,
            0x0D,
            0x0E,
            0x0F,
            0x10,
            0x11,
            0x12,
            0x13,
            0x14,
            0x15,
            0x16,
            0x17,
            0x18,
            0x19,
            0x1A,
            0x1B,
            0x1C,
            0x1D,
            0x1E,
            0x1F,
        ])
        nonce = bytes([0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x4A, 0x00, 0x00, 0x00, 0x00])
        block = secrets._chacha20_block(key, counter=1, nonce=nonce)
        expected = bytes.fromhex(
            "10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e"
            "d2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e"
        )
        self.assertEqual(block, expected)

    def test_poly1305_tag_matches_aead_vector(self):
        """Validate the AEAD tag against a fixed ChaCha20-Poly1305 example."""

        key = bytes.fromhex(
            "1c9240a5eb55d38af333888604f6b5f0473917c1402b80099dca5cbc207075c0"
        )
        nonce = bytes.fromhex("000000000102030405060708")
        aad = bytes.fromhex("f33388860000000000004e91")
        plaintext = bytes.fromhex(
            "496e7465726e65742d4472616674732061726520647261667420646f63756d656e"
            "74732064657363726962696e672061206e6577207365727669636520666f722074"
            "686520496e7465726e65742d44726166742070726f746f636f6c2e"
        )
        poly_key = secrets._chacha20_block(key, 0, nonce)[: secrets.POLY1305_KEY_BYTES]
        ciphertext = secrets._chacha20_encrypt(key, nonce, plaintext, counter=1)
        tag = secrets._poly1305_aead_tag(aad, ciphertext, poly_key)
        expected_tag = bytes.fromhex("60274fc259a8748f52b98403ce38cb59")
        self.assertEqual(tag, expected_tag)

    def test_encrypt_decrypt_round_trip_and_tamper_detection(self):
        """Round trips succeed while tampering is rejected."""

        master_key = b"classroom-master-key"
        plaintext = b"treasure chest"

        bundle = secrets.encrypt_secret(master_key, plaintext)

        recovered = secrets.decrypt_secret(master_key, bundle)
        self.assertEqual(recovered, plaintext)

        forged = secrets.EncryptedSecret(
            nonce=bundle.nonce,
            ciphertext=bundle.ciphertext[:-1] + bytes([bundle.ciphertext[-1] ^ 0xFF]),
            tag=bundle.tag,
        )
        self.assertIsNone(secrets.decrypt_secret(master_key, forged))


if __name__ == "__main__":
    unittest.main()
