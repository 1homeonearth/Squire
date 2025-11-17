//! Password hashing helpers built around Argon2id.
//! The configuration is centralized so that every password-like value uses the
//! same memory, iteration, and parallelism parameters.

use argon2::password_hash::SaltString;
use argon2::{password_hash, Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version};
use rand::rngs::OsRng;

/// Tuned Argon2id parameters for Squire's expected deployment profile.
/// - memory_cost: 19 MiB keeps GPU cracking expensive while remaining server friendly
/// - time_cost: 3 iterations for interactive latency without sacrificing safety
/// - parallelism: 1 thread to keep resource usage predictable on shared hosts
const MEMORY_COST_KIB: u32 = 19 * 1024;
const TIME_COST: u32 = 3;
const PARALLELISM: u32 = 1;

fn argon2_config() -> Result<Argon2<'static>, password_hash::Error> {
    let params = Params::new(MEMORY_COST_KIB, TIME_COST, PARALLELISM, None)?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// Hashes a password-like secret with Argon2id and returns the PHC string.
/// The resulting string includes the salt and parameters so it can be verified later.
pub fn hash_password(plaintext: &str) -> Result<String, password_hash::Error> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = argon2_config()?;
    let password_hash = argon2.hash_password(plaintext.as_bytes(), &salt)?.to_string();
    Ok(password_hash)
}

/// Verifies a plaintext password against a previously stored Argon2 hash.
/// Returns `true` when the password matches, and `false` when verification fails.
pub fn verify_password(plaintext: &str, stored_hash: &str) -> bool {
    let parsed_hash = match PasswordHash::new(stored_hash) {
        Ok(hash) => hash,
        Err(_) => return false,
    };

    match argon2_config() {
        Ok(argon2) => argon2.verify_password(plaintext.as_bytes(), &parsed_hash).is_ok(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{hash_password, verify_password};

    #[test]
    fn hashes_and_verifies_passwords() {
        let hash = hash_password("squire-test-password").expect("hashing should succeed");
        assert!(verify_password("squire-test-password", &hash));
        assert!(!verify_password("wrong-password", &hash));
    }
}
