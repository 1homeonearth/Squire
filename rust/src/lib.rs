//! Rust rewrite scaffold for Squire's cryptography and configuration handling.
//! This crate is deliberately small and transparent so secrets are always stored
//! encrypted at rest while the operational logic remains readable in-repo.

pub mod config;
pub mod crypto;
