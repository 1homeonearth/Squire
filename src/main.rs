mod config;
mod integrity;

use crate::config::{Config, ConfigError};
use crate::integrity::{IntegrityError, sha256_file};
use std::env;
use std::error::Error;
use std::fmt::{self, Display};
use std::path::PathBuf;

/// Application-level errors that combine configuration, integrity, and I/O
/// concerns. Implemented manually to avoid any external dependencies.
#[derive(Debug)]
enum AppError {
    Config(ConfigError),
    Integrity(IntegrityError),
    Io(std::io::Error),
}

impl Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Config(err) => write!(f, "config error: {}", err),
            AppError::Integrity(err) => write!(f, "integrity error: {}", err),
            AppError::Io(err) => write!(f, "io error: {}", err),
        }
    }
}

impl Error for AppError {}

impl From<ConfigError> for AppError {
    fn from(value: ConfigError) -> Self {
        AppError::Config(value)
    }
}

impl From<IntegrityError> for AppError {
    fn from(value: IntegrityError) -> Self {
        AppError::Integrity(value)
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Io(value)
    }
}

fn main() -> Result<(), AppError> {
    let config_path = env::var("SQUIRE_CONFIG").unwrap_or_else(|_| "config.json".to_string());
    let config_path = PathBuf::from(config_path);

    let config = Config::load(&config_path)?;
    let config_hash = sha256_file(&config_path)?;

    let binary_path = env::current_exe()?;
    let binary_hash = sha256_file(&binary_path)?;

    println!("Squire is now Rust-first with no external crates.");
    println!("- Config loaded from {}", config_path.display());
    println!("- Config SHA-256: {}", config_hash);
    println!("- Binary at {}", binary_path.display());
    println!("- Binary SHA-256: {}", binary_hash);
    println!("- Database path: {}", config.database_path);

    if config.feature_flags.is_empty() {
        println!("- Feature flags: none enabled yet (safe default)");
    } else {
        println!("- Feature flags: {:#?}", config.feature_flags);
    }

    println!("All hashing and parsing logic lives inside this repository for review.");

    Ok(())
}
