//! Central cryptography module that exposes password hashing, secret encryption,
//! and integrity helpers. Each submodule focuses on a single responsibility so
//! the security model stays simple and auditable.

pub mod integrity;
pub mod passwords;
pub mod secrets;
