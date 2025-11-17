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
use std::hash::{Hasher, SipHasher};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Name of the presence file the hub writes inside each entity’s `Discovery/` directory.
const PRESENCE_FILE: &str = "ecosystem_presence.txt";
/// Name of the file where bots can drop messages for the hub to route.
const BOT_QUEUE_FILE: &str = "gateway_queue.log";
/// Name of the hub log stored inside the ecosystem’s own `Discovery/` folder.
const HUB_QUEUE_FILE: &str = "hub_queue.log";
/// Environment variable that carries the keyed material used to sign presence files.
const PRESENCE_KEY_ENV: &str = "ECOSYSTEM_PRESENCE_KEY";

/// Parse a hex-encoded 16-byte key used for SipHash-based presence signatures.
fn parse_presence_key(raw: &str) -> Option<[u8; 16]> {
    if raw.len() != 32 {
        return None;
    }

    let mut bytes = [0u8; 16];
    for (i, chunk) in raw.as_bytes().chunks(2).enumerate() {
        let text = std::str::from_utf8(chunk).ok()?;
        bytes[i] = u8::from_str_radix(text, 16).ok()?;
    }
    Some(bytes)
}

/// Convert a 16-byte key into SipHash seeds and sign the provided nonce.
fn sign_presence(key_bytes: &[u8; 16], nonce: &str) -> String {
    let mut k0 = 0u64;
    let mut k1 = 0u64;
    for (i, b) in key_bytes.iter().enumerate() {
        if i < 8 {
            k0 = (k0 << 8) | (*b as u64);
        } else {
            k1 = (k1 << 8) | (*b as u64);
        }
    }

    let mut hasher = SipHasher::new_with_keys(k0, k1);
    hasher.write(nonce.as_bytes());
    format!("{:016x}", hasher.finish())
}

/// Load the presence signing key from the environment.
fn load_presence_key() -> Option<[u8; 16]> {
    env::var(PRESENCE_KEY_ENV)
        .ok()
        .and_then(|raw| parse_presence_key(raw.trim()))
}

/// Build a presence marker that includes a timestamped nonce and keyed signature.
fn presence_payload(key: Option<[u8; 16]>, entity: &Path) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let nonce = format!("{}|{}", entity.display(), timestamp);

    match key {
        Some(k) => {
            let signature = sign_presence(&k, &nonce);
            format!("nonce={}\nsignature={}", nonce, signature)
        }
        None => {
            // Keep the marker explicit about the missing key so operators know why
            // a gateway refuses to accept it.
            format!(
                "nonce={}\nsignature=missing-{}",
                nonce, PRESENCE_KEY_ENV
            )
        }
    }
}

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
    let presence_key = load_presence_key();
    if presence_key.is_none() {
        append_hub_log(
            root,
            &format!(
                "{} is unset; presence files will be unsigned and gateways will ignore them.",
                PRESENCE_KEY_ENV
            ),
        );
    }

    for entity in entities {
        let marker = entity.join("Discovery").join(PRESENCE_FILE);
        if let Some(parent) = marker.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = File::create(&marker) {
            let payload = presence_payload(presence_key, entity);
            let _ = file.write_all(payload.as_bytes());
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
