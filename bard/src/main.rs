//! Bard gateway placeholder binary.
//! It mirrors Squire’s Cargo target so offline builds produce a logging-ready stub even before
//! the real gateway lands.

use std::fs;
use std::path::PathBuf;

fn main() {
    let working_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let discovery_path = working_dir.join("Discovery");

    if let Err(error) = fs::create_dir_all(&discovery_path) {
        eprintln!("Bard could not prepare Discovery/: {error}");
        std::process::exit(1);
    }

    let log_path = discovery_path.join("gateway_queue.log");
    let note = "Bard gateway placeholder initialized for offline Cargo builds.\n";
    if let Err(error) = fs::write(&log_path, note) {
        eprintln!("Bard could not write gateway queue: {error}");
        std::process::exit(1);
    }

    println!("Bard gateway stub ready at {:?}", log_path);
    println!("Use this as a teaching aid while keeping Discord communication anchored in Rust.");
}
