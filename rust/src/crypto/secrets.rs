//! Authenticated secret vault built on ChaCha20-Poly1305.
//! Secrets are stored as nonce + ciphertext + auth tag so that configuration
//! files never contain plaintext tokens or API keys.

use std::fs;
use std::path::Path;

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroize;

const TAG_SIZE: usize = 16;
const DERIVED_KEY_LEN: usize = 32;

#[derive(Debug, Error)]
pub enum SecretVaultError {
    #[error("invalid key length; expected 32 bytes")] 
    InvalidKeyLength,
    #[error("argon2 derivation failed: {0}")]
    DerivationFailed(String),
    #[error("encryption failed: {0}")]
    EncryptionFailed(String),
    #[error("decryption failed: {0}")]
    DecryptionFailed(String),
    #[error("key source unreadable: {0}")]
    KeySourceUnreadable(String),
    #[error("base64 decoding failed: {0}")]
    Base64DecodeFailed(String),
}

/// Serializable envelope for encrypted data. The values are base64 encoded so
/// they can be embedded directly in JSON configuration files.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedSecret {
    pub nonce: String,
    pub ciphertext: String,
    pub tag: String,
}

/// Maintains a symmetric key used for authenticated encryption of runtime secrets.
pub struct SecretVault {
    key: Key,
}

impl SecretVault {
    /// Builds a vault from raw key bytes. The key must be 32 bytes for ChaCha20-Poly1305.
    pub fn from_key_bytes(key_bytes: &[u8]) -> Result<Self, SecretVaultError> {
        if key_bytes.len() != DERIVED_KEY_LEN {
            return Err(SecretVaultError::InvalidKeyLength);
        }
        let mut key = Key::default();
        key.copy_from_slice(key_bytes);
        Ok(Self { key })
    }

    /// Reads a base64-encoded key from an environment variable.
    pub fn from_env_var(var: &str) -> Result<Self, SecretVaultError> {
        let encoded = std::env::var(var)
            .map_err(|e| SecretVaultError::KeySourceUnreadable(format!("{e}")))?;
        let decoded = STANDARD_NO_PAD
            .decode(encoded.as_bytes())
            .map_err(|e| SecretVaultError::Base64DecodeFailed(format!("{e}")))?;
        Self::from_key_bytes(&decoded)
    }

    /// Reads a base64-encoded key from disk.
    pub fn from_key_file(path: &Path) -> Result<Self, SecretVaultError> {
        let content = fs::read_to_string(path)
            .map_err(|e| SecretVaultError::KeySourceUnreadable(format!("{e}")))?;
        let trimmed = content.trim();
        let decoded = STANDARD_NO_PAD
            .decode(trimmed.as_bytes())
            .map_err(|e| SecretVaultError::Base64DecodeFailed(format!("{e}")))?;
        Self::from_key_bytes(&decoded)
    }

    /// Derives a key from a local passphrase using Argon2id. Salt must be
    /// random and unique per deployment; store it alongside encrypted secrets.
    pub fn derive_from_passphrase(passphrase: &str, salt: &[u8]) -> Result<Self, SecretVaultError> {
        let params = Params::new(19 * 1024, 3, 1, Some(DERIVED_KEY_LEN))
            .map_err(|e| SecretVaultError::DerivationFailed(format!("{e}")))?;
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

        let mut output = [0u8; DERIVED_KEY_LEN];
        argon2
            .hash_password_into(passphrase.as_bytes(), salt, &mut output)
            .map_err(|e| SecretVaultError::DerivationFailed(format!("{e}")))?;

        let vault = SecretVault::from_key_bytes(&output)?;
        output.zeroize();
        Ok(vault)
    }

    /// Encrypts a plaintext secret into a serializable envelope.
    pub fn encrypt_secret(&self, plaintext: &[u8]) -> Result<EncryptedSecret, SecretVaultError> {
        let cipher = ChaCha20Poly1305::new(&self.key);
        let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);

        let mut ciphertext_and_tag = cipher
            .encrypt(&nonce, plaintext)
            .map_err(|e| SecretVaultError::EncryptionFailed(format!("{e}")))?;
        if ciphertext_and_tag.len() < TAG_SIZE {
            return Err(SecretVaultError::EncryptionFailed(
                "ciphertext shorter than authentication tag".to_string(),
            ));
        }
        let tag_start = ciphertext_and_tag.len() - TAG_SIZE;
        let tag_bytes = ciphertext_and_tag.split_off(tag_start);
        let ciphertext = ciphertext_and_tag;

        Ok(EncryptedSecret {
            nonce: STANDARD_NO_PAD.encode(&nonce),
            ciphertext: STANDARD_NO_PAD.encode(ciphertext),
            tag: STANDARD_NO_PAD.encode(tag_bytes),
        })
    }

    /// Decrypts an encrypted envelope back into plaintext bytes.
    pub fn decrypt_secret(&self, secret: &EncryptedSecret) -> Result<Vec<u8>, SecretVaultError> {
        let nonce_bytes = STANDARD_NO_PAD
            .decode(secret.nonce.as_bytes())
            .map_err(|e| SecretVaultError::Base64DecodeFailed(format!("{e}")))?;
        let ciphertext = STANDARD_NO_PAD
            .decode(secret.ciphertext.as_bytes())
            .map_err(|e| SecretVaultError::Base64DecodeFailed(format!("{e}")))?;
        let tag = STANDARD_NO_PAD
            .decode(secret.tag.as_bytes())
            .map_err(|e| SecretVaultError::Base64DecodeFailed(format!("{e}")))?;

        if nonce_bytes.len() != ChaCha20Poly1305::nonce_size() {
            return Err(SecretVaultError::DecryptionFailed(
                "nonce length mismatch".to_string(),
            ));
        }

        let mut combined = Vec::with_capacity(ciphertext.len() + tag.len());
        combined.extend_from_slice(&ciphertext);
        combined.extend_from_slice(&tag);

        let cipher = ChaCha20Poly1305::new(&self.key);
        cipher
            .decrypt(Nonce::from_slice(&nonce_bytes), combined.as_ref())
            .map_err(|e| SecretVaultError::DecryptionFailed(format!("{e}")))
    }
}

impl Drop for SecretVault {
    fn drop(&mut self) {
        // Zero the key material on drop to reduce its lifetime in memory.
        self.key.as_mut_slice().zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::{EncryptedSecret, SecretVault};
    use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};

    #[test]
    fn encrypts_and_decrypts_round_trip() {
        let key = [42u8; 32];
        let vault = SecretVault::from_key_bytes(&key).expect("key should be valid");
        let ciphertext = vault
            .encrypt_secret(b"secret-token")
            .expect("encryption should succeed");
        let plaintext = vault
            .decrypt_secret(&ciphertext)
            .expect("decryption should succeed");
        assert_eq!(plaintext, b"secret-token");
    }

    #[test]
    fn derives_key_from_passphrase() {
        let salt = b"static-test-salt-123";
        let vault = SecretVault::derive_from_passphrase("pa55phrase", salt)
            .expect("derivation should succeed");
        let encrypted = vault
            .encrypt_secret(b"payload")
            .expect("encryption should work");
        let decrypted = vault
            .decrypt_secret(&encrypted)
            .expect("decryption should work");
        assert_eq!(decrypted, b"payload");
    }

    #[test]
    fn rejects_bad_keys() {
        let err = SecretVault::from_key_bytes(&[1u8; 16]).unwrap_err();
        assert!(format!("{err}").contains("invalid key length"));
    }

    #[test]
    fn handles_invalid_ciphertext() {
        let vault = SecretVault::from_key_bytes(&[7u8; 32]).expect("valid key");
        let bogus = EncryptedSecret {
            nonce: STANDARD_NO_PAD.encode(&[0u8; 12]),
            ciphertext: STANDARD_NO_PAD.encode(&[0u8; 5]),
            tag: STANDARD_NO_PAD.encode(&[0u8; 16]),
        };
        let err = vault.decrypt_secret(&bogus).unwrap_err();
        assert!(format!("{err}").contains("decryption failed"));
    }
}
