//! Squire gateway placeholder for Cargo builds.
//! The handwritten Rust gateways in `rust/` still show how Discord I/O will work; this binary
//! simply keeps the Cargo workspace runnable and teaches newcomers about the directory layout.

use std::fs;
use std::path::PathBuf;

fn main() {
    let working_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let discovery_path = working_dir.join("Discovery");

    if let Err(error) = fs::create_dir_all(&discovery_path) {
        eprintln!("Squire could not prepare Discovery/: {error}");
        std::process::exit(1);
    }

    let queue_path = discovery_path.join("gateway_queue.log");
    let message = "Squire gateway placeholder initialized.\n";
    if let Err(error) = fs::write(&queue_path, message) {
        eprintln!("Squire could not write gateway queue: {error}");
        std::process::exit(1);
    }

    println!("Squire gateway stub ready at {:?}", queue_path);
    println!("Use the existing Rust files in squire/rust/ as the authoritative Discord bridge when you add features.");
}
