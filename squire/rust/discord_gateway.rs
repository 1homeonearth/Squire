//! Rust wrapper responsible for all Discord-facing communication.
//!
//! This wrapper owns the network boundary so Python modules never open sockets.
//! It also checks for the ecosystem presence file inside `Discovery/` to decide
//! when bot-to-bot chatter is allowed. Everything uses only Rust's standard
//! library for full auditability.

use std::collections::VecDeque;
use std::env;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::hash::{Hasher, SipHasher};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// File name that signals the ecosystem hub has announced itself.
const PRESENCE_FILE: &str = "Discovery/ecosystem_presence.txt";
/// Optional queue file where Python can drop logs for forwarding to a logging channel.
const DISPATCH_FILE: &str = "Discovery/gateway_queue.log";
/// Optional file where the gateway can summarize HTTPS intent without dumping secrets to stdout.
const SECURE_DISPATCH_FILE: &str = "Discovery/secure_transport.log";
/// Environment variable shared with the hub to authenticate presence markers.
const PRESENCE_KEY_ENV: &str = "ECOSYSTEM_PRESENCE_KEY";

/// Represents a message ready to be sent to Discord.
#[derive(Debug, Clone)]
pub struct OutboundMessage {
    /// Channel identifier as understood by the Discord API.
    pub channel_id: String,
    /// JSON payload as a plain string so it can be inspected before send.
    pub body: String,
}

/// Minimal gateway that queues messages and would later flush them over the network.
pub struct DiscordGateway {
    queue: VecDeque<OutboundMessage>,
}

impl DiscordGateway {
    /// Create a new gateway instance with an empty queue.
    pub fn new() -> Self {
        Self {
            queue: VecDeque::new(),
        }
    }

    /// Accept a payload prepared by a Python module and enqueue it for sending.
    pub fn enqueue(&mut self, msg: OutboundMessage) {
        self.queue.push_back(msg);
    }

    /// Check whether the ecosystem presence file exists, which signals that
    /// cross-bot communication is permitted.
    fn ecosystem_ready(&self) -> bool {
        match self.validate_presence_file() {
            Ok(valid) => valid,
            Err(err) => {
                println!("[Rust gateway] Presence validation failed: {}", err);
                false
            }
        }
    }

    /// Placeholder for slash-command synchronization. Runs automatically during
    /// flush to remind operators that command definitions should be registered.
    fn sync_slash_commands(&self) {
        println!(
            "[Rust gateway] Slash-command sync stub executed. Replace with real Discord client as needed."
        );
    }

    /// Optionally forward log lines that Python dropped into a queue file.
    fn forward_dispatch_logs(&self) {
        if let Ok(contents) = fs::read_to_string(DISPATCH_FILE) {
            for line in contents.lines() {
                println!("[Rust gateway] would forward log: {}", line);
            }
        }
    }

    /// Inspect the queued messages without sending them. In production this is
    /// where a Rust HTTP client would live; keeping it inside Rust enforces the
    /// "all Discord I/O through Rust" policy even if the Python layer is compromised.
    pub fn flush(&mut self) {
        let token = env::var("SQUIRE_DISCORD_TOKEN").unwrap_or_default();
        let ready = self.ecosystem_ready();

        println!(
            "[Rust gateway] Ready for inter-bot comms? {} | Messages queued: {} | Token present? {}",
            if ready { "yes" } else { "no" },
            self.queue.len(),
            if token.is_empty() { "no" } else { "yes" }
        );

        if token.is_empty() {
            println!(
                "[Rust gateway] Missing SQUIRE_DISCORD_TOKEN; refusing to stage HTTPS requests."
            );
            return;
        }

        if !ready {
            println!("[Rust gateway] Presence file missing or unsigned; skipping send.");
            return;
        }

        self.sync_slash_commands();
        self.forward_dispatch_logs();

        let mut client = SecureDiscordClient::new(token);
        while let Some(item) = self.queue.pop_front() {
            match client.send_message(&item) {
                Ok(summary) => {
                    self.append_secure_dispatch(&format!(
                        "{} | {}",
                        item.channel_id, summary
                    ))
                }
                Err(err) => {
                    self.append_secure_dispatch(&format!(
                        "{} failed to send: {}",
                        item.channel_id, err
                    ))
                }
            }

            // Gentle pacing to respect future Discord rate limits without external crates.
            std::thread::sleep(Duration::from_millis(300));
        }
    }

    /// Append a note to the dispatch file so the ecosystem hub can route it if desired.
    pub fn append_dispatch(&self, message: &str) {
        if let Some(parent) = Path::new(DISPATCH_FILE).parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = File::options()
            .create(true)
            .append(true)
            .open(DISPATCH_FILE)
        {
            let _ = writeln!(file, "{}", message);
        }
    }

    /// Append a sanitized log entry describing attempted HTTPS work without leaking secrets.
    fn append_secure_dispatch(&self, message: &str) {
        if let Some(parent) = Path::new(SECURE_DISPATCH_FILE).parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = File::options()
            .create(true)
            .append(true)
            .open(SECURE_DISPATCH_FILE)
        {
            let _ = writeln!(file, "{}", message);
        }
    }

    /// Validate the presence file signature using SipHash so only the hub can flip the ready flag.
    fn validate_presence_file(&self) -> Result<bool, String> {
        let key = match env::var(PRESENCE_KEY_ENV)
            .ok()
            .and_then(|raw| parse_presence_key(raw.trim()))
        {
            Some(k) => k,
            None => return Err(format!("{} is unset", PRESENCE_KEY_ENV)),
        };

        let contents = fs::read_to_string(PRESENCE_FILE)
            .map_err(|_| "presence file missing".to_string())?;

        let mut nonce = None;
        let mut signature = None;
        for line in contents.lines() {
            if let Some(rest) = line.strip_prefix("nonce=") {
                nonce = Some(rest.to_string());
            }
            if let Some(rest) = line.strip_prefix("signature=") {
                signature = Some(rest.to_string());
            }
        }

        let nonce = nonce.ok_or_else(|| "nonce missing from presence file".to_string())?;
        let signature = signature.ok_or_else(|| "signature missing from presence file".to_string())?;

        if signature.starts_with("missing-") {
            return Err("presence file is unsigned".to_string());
        }

        let expected = sign_presence(&key, &nonce);
        Ok(expected == signature)
    }
}

/// Minimal client scaffold that prepares HTTPS requests without printing sensitive material.
struct SecureDiscordClient {
    token: String,
}

impl SecureDiscordClient {
    fn new(token: String) -> Self {
        Self { token }
    }

    /// Prepare a HTTPS POST payload; real TLS transport can be dropped in later without changing callers.
    fn send_message(&mut self, message: &OutboundMessage) -> Result<(), String> {
        let authorization = format!("Bot {}", self.token);

        // We avoid printing headers with tokens; only a short digest is logged for troubleshooting.
        let auth_digest = short_siphash(&authorization);
        let body_bytes = message.body.as_bytes();
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let request_summary = format!(
            "POST /api/v10/channels/{}/messages | body={} bytes | auth-digest={:016x} | queued_at={}ms",
            message.channel_id,
            body_bytes.len(),
            auth_digest,
            millis
        );

        // In this offline-friendly build we do not open sockets. Operators can read the
        // secure transport log to verify that messages were staged without exposing the token.
        println!(
            "[Rust gateway] Staged HTTPS request (redacted). See {} for details.",
            SECURE_DISPATCH_FILE
        );

        // Real HTTPS transport can replace this stub by opening a TLS socket and writing
        // the serialized HTTP request. Keeping the function pure makes that swap safe.
        Ok(())
    }
}

/// Parse a hex-encoded 16-byte key used to seed SipHash.
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

/// Use SipHash keyed by the presence key to avoid leaking the raw token while still tagging logs.
fn short_siphash(input: &str) -> u64 {
    let seed = b"gateway-log-salt!";
    let mut k0 = 0u64;
    let mut k1 = 0u64;
    for (i, b) in seed.iter().enumerate() {
        if i < 8 {
            k0 = (k0 << 8) | (*b as u64);
        } else {
            k1 = (k1 << 8) | (*b as u64);
        }
    }

    let mut hasher = SipHasher::new_with_keys(k0, k1);
    hasher.write(input.as_bytes());
    hasher.finish()
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
