//! Integrity helpers for hashing and key derivation. These utilities are kept
//! separate from password hashing and secret encryption to avoid accidental API
//! misuse.

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum IntegrityError {
    #[error("hkdf expansion failed: {0}")]
    HkdfFailed(String),
    #[error("hmac failed: {0}")]
    HmacFailed(String),
}

type HmacSha256 = Hmac<Sha256>;

/// Produces a raw SHA-256 digest of the provided bytes.
pub fn sha256_digest(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// Returns the hexadecimal representation of a SHA-256 digest.
pub fn sha256_hex(data: &[u8]) -> String {
    let digest = sha256_digest(data);
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Generates an HMAC-SHA256 tag for the provided data.
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>, IntegrityError> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|e| IntegrityError::HmacFailed(format!("{e}")))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

/// Derives key material using HKDF-SHA256.
pub fn hkdf_expand(input_key_material: &[u8], salt: &[u8], info: &[u8], length: usize) -> Result<Vec<u8>, IntegrityError> {
    let hk = Hkdf::<Sha256>::new(Some(salt), input_key_material);
    let mut okm = vec![0u8; length];
    hk.expand(info, &mut okm)
        .map_err(|e| IntegrityError::HkdfFailed(format!("{e}")))?;
    Ok(okm)
}

#[cfg(test)]
mod tests {
    use super::{hkdf_expand, hmac_sha256, sha256_hex};
    use hex::ToHex;

    #[test]
    fn hashes_to_hex() {
        assert_eq!(sha256_hex(b"squire"), "ebe6ff7bd8fad139b8e7e39fb8bcbac2c05ddf7947ed90cbe248ee84ca6bff6b");
    }

    #[test]
    fn builds_hmac() {
        let tag = hmac_sha256(b"key", b"payload").expect("hmac should succeed");
        assert_eq!(tag.encode_hex::<String>(), "9700e760f0f4bcfbe2a8362ba36d4ec3ed9a4d3d7bcd7d43f8eb84edfe0c75b6");
    }

    #[test]
    fn expands_with_hkdf() {
        let okm = hkdf_expand(b"ikm", b"salt", b"info", 42).expect("hkdf should work");
        assert_eq!(okm.len(), 42);
    }
}
