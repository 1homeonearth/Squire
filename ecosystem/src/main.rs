//! Ecosystem hub placeholder binary.
//! This crate keeps the same beginner-friendly tone as the handwritten `rust/central_comm.rs`
//! file while giving Cargo a target to build during offline workspace builds.

use std::fs;
use std::path::PathBuf;

fn main() {
    // The hub is intentionally simple here: it only prepares the on-disk layout that other
    // modules expect and prints guidance for readers following along. When you expand the hub
    // you can replace these steps with the real discovery and presence-writing logic from the
    // handwritten Rust stubs.
    let working_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let discovery_path = working_dir.join("Discovery");

    if let Err(error) = fs::create_dir_all(&discovery_path) {
        eprintln!("Failed to create Discovery directory: {error}");
        std::process::exit(1);
    }

    let marker_path = discovery_path.join("ecosystem_presence.txt");
    if let Err(error) = fs::write(&marker_path, "ecosystem hub staged by Cargo build\n") {
        eprintln!("Failed to write presence marker: {error}");
        std::process::exit(1);
    }

    println!("Ecosystem hub stub ready. Discovery marker placed at {:?}", marker_path);
    println!("Replace this stub with the full central coordinator when wiring real Discord flows.");
}
