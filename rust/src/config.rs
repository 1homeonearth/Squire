//! Configuration loader for the Rust rewrite. The loader expects encrypted
//! secrets and decrypts them in-memory using the `SecretVault` helper.

use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::Deserialize;
use thiserror::Error;

use crate::crypto::secrets::{EncryptedSecret, SecretVault};

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("config file unreadable: {0}")]
    Io(String),
    #[error("config parse failed: {0}")]
    Parse(String),
    #[error("vault error: {0}")]
    Vault(String),
    #[error("no usable vault key source configured")]
    MissingKeySource,
    #[error("utf-8 error: {0}")]
    Utf8(String),
}

#[derive(Debug, Deserialize)]
pub struct VaultConfig {
    /// Base64-encoded 32 byte key stored in an environment variable.
    pub key_env: Option<String>,
    /// Path to a file that contains the base64-encoded key.
    pub key_path: Option<PathBuf>,
    /// Environment variable that stores a local passphrase (for Argon2id KDF).
    pub passphrase_env: Option<String>,
    /// Base64-encoded salt used alongside the passphrase.
    pub salt_b64: Option<String>,
}

impl VaultConfig {
    fn build_vault(&self) -> Result<SecretVault, ConfigError> {
        if let Some(var) = &self.key_env {
            return SecretVault::from_env_var(var).map_err(|e| ConfigError::Vault(format!("{e}")));
        }
        if let Some(path) = &self.key_path {
            return SecretVault::from_key_file(path).map_err(|e| ConfigError::Vault(format!("{e}")));
        }
        if let (Some(pass_env), Some(salt_b64)) = (&self.passphrase_env, &self.salt_b64) {
            let passphrase = std::env::var(pass_env)
                .map_err(|e| ConfigError::Vault(format!("{e}")))?;
            let salt = STANDARD_NO_PAD
                .decode(salt_b64.as_bytes())
                .map_err(|e| ConfigError::Vault(format!("{e}")))?;
            return SecretVault::derive_from_passphrase(&passphrase, &salt)
                .map_err(|e| ConfigError::Vault(format!("{e}")));
        }
        Err(ConfigError::MissingKeySource)
    }
}

#[derive(Debug, Deserialize)]
pub struct EncryptedSecrets {
    pub token: EncryptedSecret,
    #[serde(rename = "applicationId")]
    pub application_id: Option<EncryptedSecret>,
}

#[derive(Debug, Deserialize)]
pub struct RawSquireConfig {
    pub vault: VaultConfig,
    #[serde(rename = "encryptedSecrets")]
    pub encrypted_secrets: EncryptedSecrets,
    #[serde(rename = "loggingServerId")]
    pub logging_server_id: Option<String>,
    #[serde(rename = "debugLevel")]
    pub debug_level: Option<String>,
}

#[derive(Debug)]
pub struct RuntimeConfig {
    pub token: String,
    pub application_id: Option<String>,
    pub logging_server_id: Option<String>,
    pub debug_level: Option<String>,
}

/// Loads the JSON configuration file, decrypts secrets, and returns runtime
/// values. Plaintext secrets never leave this function.
pub fn load_config(path: impl AsRef<Path>) -> Result<RuntimeConfig, ConfigError> {
    let raw_json = fs::read_to_string(&path).map_err(|e| ConfigError::Io(format!("{e}")))?;
    let raw_config: RawSquireConfig = serde_json::from_str(&raw_json)
        .map_err(|e| ConfigError::Parse(format!("{e}")))?;

    let vault = raw_config.vault.build_vault()?;
    let token_bytes = vault
        .decrypt_secret(&raw_config.encrypted_secrets.token)
        .map_err(|e| ConfigError::Vault(format!("{e}")))?;
    let token = String::from_utf8(token_bytes).map_err(|e| ConfigError::Utf8(format!("{e}")))?;

    let application_id = if let Some(enc_app) = raw_config.encrypted_secrets.application_id {
        let decrypted = vault
            .decrypt_secret(&enc_app)
            .map_err(|e| ConfigError::Vault(format!("{e}")))?;
        Some(String::from_utf8(decrypted).map_err(|e| ConfigError::Utf8(format!("{e}")))?)
    } else {
        None
    };

    Ok(RuntimeConfig {
        token,
        application_id,
        logging_server_id: raw_config.logging_server_id,
        debug_level: raw_config.debug_level,
    })
}

#[cfg(test)]
mod tests {
    use super::load_config;
    use crate::crypto::secrets::SecretVault;
    use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
    use serde_json::json;
    use std::fs;
    use tempfile::NamedTempFile;

    #[test]
    fn loads_and_decrypts_config() {
        let salt = b"static-test-salt-123";
        let passphrase_var = "SQUIRE_TEST_PASSPHRASE";
        std::env::set_var(passphrase_var, "pa55phrase");

        let vault = SecretVault::derive_from_passphrase("pa55phrase", salt).expect("valid key");
        let token = vault
            .encrypt_secret(b"discord-token")
            .expect("encryption should work");
        let app = vault
            .encrypt_secret(b"application-id")
            .expect("encryption should work");

        let payload = json!({
            "vault": {
                "key_env": null,
                "key_path": null,
                "passphrase_env": passphrase_var,
                "salt_b64": STANDARD_NO_PAD.encode(salt)
            },
            "encryptedSecrets": {
                "token": token,
                "applicationId": app
            },
            "loggingServerId": "123",
            "debugLevel": "info"
        });

        let mut file = NamedTempFile::new().expect("temp file");
        fs::write(file.path(), serde_json::to_vec(&payload).unwrap()).unwrap();

        let config = load_config(file.path()).expect("config should load");
        assert_eq!(config.token, "discord-token");
        assert_eq!(config.application_id.unwrap(), "application-id");
        assert_eq!(config.logging_server_id.unwrap(), "123");
    }
}
