//! Central communications hub for the Course on Robot Recourse ecosystem.
//!
//! This Rust file keeps all cross-bot communication inside the standard library.
//! It scans for bot or ecosystem folders, drops a presence file inside each
//! `Discovery/` directory to signal "safe to talk," and maintains simple
//! file-backed queues for future message passing. No external crates are used so
//! auditors can read everything in this repository.

use std::collections::VecDeque;
use std::env; // Standard-library access to the current working directory for clarity.
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Name of the presence file the hub writes inside each entity’s `Discovery/` directory.
const PRESENCE_FILE: &str = "ecosystem_presence.txt";
/// Name of the file where bots can drop messages for the hub to route.
const BOT_QUEUE_FILE: &str = "gateway_queue.log";
/// Name of the hub log stored inside the ecosystem’s own `Discovery/` folder.
const HUB_QUEUE_FILE: &str = "hub_queue.log";

/// Determine whether a path represents a bot or ecosystem by checking for a `Discovery/` directory.
fn is_entity(path: &Path) -> bool {
    path.is_dir() && path.join("Discovery").is_dir()
}

/// Recursively collect entities starting from the given container paths.
fn collect_entities(containers: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    let mut stack: VecDeque<PathBuf> = containers.into();

    while let Some(container) = stack.pop_front() {
        if let Ok(entries) = fs::read_dir(&container) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if is_entity(&path) && !found.iter().any(|p| p == &path) {
                        found.push(path.clone());
                    }
                    let discovery = path.join("Discovery");
                    if discovery.is_dir() {
                        stack.push_back(discovery);
                    }
                }
            }
        }
    }

    found
}

/// Drop the presence file into each entity’s Discovery folder so the bot or ecosystem knows the hub is live.
pub fn announce_presence(root: &Path, entities: &[PathBuf]) {
    for entity in entities {
        let marker = entity.join("Discovery").join(PRESENCE_FILE);
        if let Some(parent) = marker.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = File::create(&marker) {
            let _ = file.write_all(b"ecosystem is ready; bots may talk via Rust");
        }
    }

    let hub_log = root.join("Discovery").join(HUB_QUEUE_FILE);
    if let Some(parent) = hub_log.parent() {
        let _ = fs::create_dir_all(parent);
    }
}

/// Append a log entry for hub-visible events so operators can audit behavior.
pub fn append_hub_log(root: &Path, message: &str) {
    let log_path = root.join("Discovery").join(HUB_QUEUE_FILE);
    if let Ok(mut file) = File::options().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "{}", message);
    }
}

/// Read pending messages from a bot-specific queue file inside its Discovery directory.
pub fn read_bot_queue(bot_path: &Path) -> Vec<String> {
    let queue_path = bot_path.join("Discovery").join(BOT_QUEUE_FILE);
    let mut contents = String::new();
    if let Ok(mut file) = File::open(queue_path) {
        let _ = file.read_to_string(&mut contents);
    }
    contents
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

/// Minimal driver to demonstrate discovery and presence signalling.
pub fn main() {
    // Use the current working directory so operators can run the hub from any
    // level; by default this is the `ecosystem/` folder. Keeping the path
    // explicit avoids surprises if the hub binary is moved or invoked from
    // nested ecosystems.
    let root = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    // The hub looks for entities in two places:
    // - Sibling folders of the ecosystem (repo root by default).
    // - Any entries nested inside `Discovery/` directories to allow recursive layouts.
    let mut containers = Vec::new();
    if let Some(parent) = root.parent() {
        containers.push(parent.to_path_buf());
    }
    containers.push(root.join("Discovery"));

    let entities = collect_entities(containers);
    if entities.is_empty() {
        append_hub_log(
            &root,
            "No bots discovered. Place bots or ecosystems beside this folder or inside Discovery/ so the hub can enroll them.",
        );
    } else {
        announce_presence(&root, &entities);
        append_hub_log(
            &root,
            &format!("Announced presence to {} entity(ies)", entities.len()),
        );
    }

    for bot in &entities {
        let messages = read_bot_queue(bot);
        if !messages.is_empty() {
            append_hub_log(&root, &format!("Would route messages from {:?}: {:?}", bot, messages));
        }
    }
}
