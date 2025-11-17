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

/// File name that signals the ecosystem hub has announced itself.
const PRESENCE_FILE: &str = "Discovery/ecosystem_presence.txt";
/// Optional queue file where Python can drop logs for forwarding to a logging channel.
const DISPATCH_FILE: &str = "Discovery/gateway_queue.log";

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
        Path::new(PRESENCE_FILE).exists()
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
        let token = env::var("SENTRY_DISCORD_TOKEN").unwrap_or_default();
        let ready = self.ecosystem_ready();
        println!(
            "[Rust gateway] Ready for inter-bot comms? {} | Messages queued: {} | Token present? {}",
            if ready { "yes" } else { "no" },
            self.queue.len(),
            if token.is_empty() { "no" } else { "yes" }
        );
        self.sync_slash_commands();
        self.forward_dispatch_logs();
        while let Some(item) = self.queue.pop_front() {
            println!(
                "[Rust gateway] target={} payload={}",
                item.channel_id, item.body
            );
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
}
