//! Sentry Omega — reproducible build and verification helper for the Squire ecosystem.
//!
//! This module stays dependency-free so students can audit every line without juggling cargo
//! downloads. The functions here prefer descriptive printouts and simple data structures, and the
//! CLI entrypoints in `src/bin` feed into `run_cli` with their preferred default mode.

use std::collections::hash_map::DefaultHasher;
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

/// Runtime mode for Sentry Omega.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Blue,
    Yellow,
    Red,
}

impl Mode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Mode::Blue => "blue",
            Mode::Yellow => "yellow",
            Mode::Red => "red",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "blue" => Some(Mode::Blue),
            "yellow" => Some(Mode::Yellow),
            "red" => Some(Mode::Red),
            _ => None,
        }
    }
}

/// Runtime network settings loaded from the environment.
#[derive(Clone, Debug)]
pub struct OmegaEnvironment {
    pub yellow_host: String,
    pub red_host: String,
    pub blue_host: String,
}

impl OmegaEnvironment {
    pub fn load() -> Self {
        // All runtime endpoints use hostnames from .env so operators can adjust them without
        // rebuilding. Missing entries fall back to explicit placeholder strings to keep the
        // output easy to read.
        let yellow_host = env::var("SENTRY_YELLOW_HOST").unwrap_or_else(|_| "unset-yellow-host".to_string());
        let red_host = env::var("SENTRY_RED_HOST").unwrap_or_else(|_| "unset-red-host".to_string());
        let blue_host = env::var("SENTRY_BLUE_HOST").unwrap_or_else(|_| "unset-blue-host".to_string());

        Self {
            yellow_host,
            red_host,
            blue_host,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ManifestEntry {
    pub name: String,
    pub path: String,
    pub hash: String,
    pub size: u64,
}

#[derive(Clone, Debug)]
pub struct OmegaManifest {
    pub release_id: String,
    pub mode: Mode,
    pub signature_note: String,
    pub entries: Vec<ManifestEntry>,
}

/// CLI commands supported by Sentry Omega.
#[derive(Clone, Debug)]
pub enum Command {
    Build {
        bins_dir: PathBuf,
        releases_dir: PathBuf,
        release_id: String,
    },
    Verify {
        bins_dir: PathBuf,
        manifest_path: PathBuf,
    },
    Daemon {
        bins_dir: PathBuf,
        manifest_path: PathBuf,
        interval_seconds: u64,
    },
}

/// Run the CLI using the provided default mode.
pub fn run_cli(default_mode: Mode) -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let env_settings = OmegaEnvironment::load();
    let (mode, command) = parse_args(default_mode, &args)?;

    match command {
        Command::Build { bins_dir, releases_dir, release_id } => {
            let manifest = build_manifest(mode, &bins_dir, release_id)?;
            persist_manifest(&manifest, &releases_dir)?;
            print_json_status("build", mode, &env_settings, &manifest, &[]);
        }
        Command::Verify { bins_dir, manifest_path } => {
            let manifest = load_manifest(&manifest_path)?;
            let report = verify_bins(&bins_dir, &manifest)?;
            print_json_status("verify", mode, &env_settings, &manifest, &report);
        }
        Command::Daemon { bins_dir, manifest_path, interval_seconds } => {
            loop {
                let manifest = load_manifest(&manifest_path)?;
                let report = verify_bins(&bins_dir, &manifest)?;
                print_json_status("daemon", mode, &env_settings, &manifest, &report);
                thread::sleep(Duration::from_secs(interval_seconds));
            }
        }
    }

    Ok(())
}

fn parse_args(default_mode: Mode, args: &[String]) -> Result<(Mode, Command), String> {
    let mut index = 0usize;
    let mut mode = default_mode;

    if args.get(index).map(|v| v.as_str()) == Some("--mode") {
        let Some(value) = args.get(index + 1) else {
            return Err("--mode requires a value".to_string());
        };
        mode = Mode::from_str(value).ok_or_else(|| "Mode must be blue, yellow, or red".to_string())?;
        index += 2;
    }

    let Some(command_name) = args.get(index) else {
        return Err("Missing subcommand (build, verify, daemon)".to_string());
    };
    index += 1;

    match command_name.as_str() {
        "build" => {
            let bins_dir = take_flag("--bins-dir", args, &mut index)?;
            let releases_dir = take_flag("--releases-dir", args, &mut index)?;
            let release_id = take_optional_flag("--release-id", args, &mut index)
                .unwrap_or_else(|| "omega-dev".to_string());

            Ok((mode, Command::Build { bins_dir: PathBuf::from(bins_dir), releases_dir: PathBuf::from(releases_dir), release_id }))
        }
        "verify" => {
            let bins_dir = take_flag("--bins-dir", args, &mut index)?;
            let manifest_path = take_flag("--manifest", args, &mut index)?;
            Ok((mode, Command::Verify { bins_dir: PathBuf::from(bins_dir), manifest_path: PathBuf::from(manifest_path) }))
        }
        "daemon" => {
            let bins_dir = take_flag("--bins-dir", args, &mut index)?;
            let manifest_path = take_flag("--manifest", args, &mut index)?;
            let interval_seconds = take_optional_flag("--interval-seconds", args, &mut index)
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(60);
            Ok((mode, Command::Daemon { bins_dir: PathBuf::from(bins_dir), manifest_path: PathBuf::from(manifest_path), interval_seconds }))
        }
        _ => Err("Unknown subcommand".to_string()),
    }
}

fn take_flag(name: &str, args: &[String], index: &mut usize) -> Result<String, String> {
    let Some(flag) = args.get(*index) else {
        return Err(format!("Missing required flag {name}"));
    };

    if flag != name {
        return Err(format!("Expected {name} but found {flag}"));
    }

    let Some(value) = args.get(*index + 1) else {
        return Err(format!("{name} requires a value"));
    };
    *index += 2;
    Ok(value.clone())
}

fn take_optional_flag(name: &str, args: &[String], index: &mut usize) -> Option<String> {
    if args.get(*index).map(|v| v.as_str()) != Some(name) {
        return None;
    }

    let value = args.get(*index + 1)?;
    *index += 2;
    Some(value.clone())
}

fn build_manifest(mode: Mode, bins_dir: &Path, release_id: String) -> Result<OmegaManifest, String> {
    if !bins_dir.is_dir() {
        return Err(format!("Binary directory {:?} not found", bins_dir));
    }

    let mut entries = Vec::new();
    let mut dir_entries: Vec<_> = fs::read_dir(bins_dir)
        .map_err(|err| format!("Unable to read bin directory: {err}"))?
        .collect();
    dir_entries.sort_by_key(|entry| entry.as_ref().ok().map(|e| e.path()));

    for entry in dir_entries {
        let entry = entry.map_err(|err| format!("Failed to read file entry: {err}"))?;
        let metadata = entry.metadata().map_err(|err| format!("Failed to read metadata: {err}"))?;
        if !metadata.is_file() {
            continue;
        }

        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let content = fs::read(&path).map_err(|err| format!("Failed to read {:?}: {err}", path))?;
        let hash = hash_bytes(&content);

        entries.push(ManifestEntry {
            name,
            path: path.to_string_lossy().to_string(),
            hash,
            size: metadata.len(),
        });
    }

    Ok(OmegaManifest {
        release_id,
        mode,
        signature_note: "Detached signatures live alongside manifest files. Add them after signing on Sentry Blue.".to_string(),
        entries,
    })
}

fn persist_manifest(manifest: &OmegaManifest, releases_dir: &Path) -> Result<(), String> {
    if manifest.entries.is_empty() {
        return Err("No binaries were discovered to record in the manifest".to_string());
    }

    let release_folder = releases_dir.join(format!("omega-{}", manifest.release_id));
    fs::create_dir_all(&release_folder).map_err(|err| format!("Unable to create releases directory: {err}"))?;

    let manifest_path = release_folder.join("manifest.txt");
    let mut file = fs::File::create(&manifest_path).map_err(|err| format!("Unable to create manifest: {err}"))?;
    let contents = render_manifest(manifest);
    file.write_all(contents.as_bytes()).map_err(|err| format!("Unable to write manifest: {err}"))?;

    let signature_path = release_folder.join("manifest.txt.sig");
    if !signature_path.exists() {
        // Leave a friendly placeholder to remind operators to add a signed file.
        let mut sig_file = fs::File::create(&signature_path).map_err(|err| format!("Unable to prepare signature placeholder: {err}"))?;
        sig_file
            .write_all(b"Add detached signature from Sentry Blue here.\n")
            .map_err(|err| format!("Unable to write signature placeholder: {err}"))?;
    }

    Ok(())
}

fn render_manifest(manifest: &OmegaManifest) -> String {
    let mut output = String::new();
    output.push_str(&format!("release_id={}\n", manifest.release_id));
    output.push_str(&format!("mode={}\n", manifest.mode.as_str()));
    output.push_str("entries:\n");

    for entry in &manifest.entries {
        output.push_str(&format!("{}|{}|{}|{}\n", entry.name, entry.path, entry.hash, entry.size));
    }

    output.push_str(&format!("signature_note={}\n", manifest.signature_note));
    output
}

fn load_manifest(path: &Path) -> Result<OmegaManifest, String> {
    let content = fs::read_to_string(path).map_err(|err| format!("Unable to read manifest: {err}"))?;
    let mut release_id = String::new();
    let mut mode = Mode::Yellow;
    let mut entries = Vec::new();
    let mut signature_note = String::new();

    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("release_id=") {
            release_id = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("mode=") {
            mode = Mode::from_str(rest).unwrap_or(Mode::Yellow);
        } else if let Some(rest) = line.strip_prefix("signature_note=") {
            signature_note = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("entries:") {
            // Header line; nothing to parse here.
            let _ = rest;
        } else if line.contains('|') {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() == 4 {
                let name = parts[0].to_string();
                let path = parts[1].to_string();
                let hash = parts[2].to_string();
                let size = parts[3].parse::<u64>().unwrap_or(0);
                entries.push(ManifestEntry { name, path, hash, size });
            }
        }
    }

    if release_id.is_empty() {
        return Err("Manifest missing release_id".to_string());
    }

    Ok(OmegaManifest { release_id, mode, signature_note, entries })
}

fn verify_bins(bins_dir: &Path, manifest: &OmegaManifest) -> Result<Vec<String>, String> {
    let mut results = Vec::new();

    for entry in &manifest.entries {
        let full_path = if Path::new(&entry.path).is_absolute() {
            PathBuf::from(&entry.path)
        } else {
            bins_dir.join(&entry.path)
        };

        let data = fs::read(&full_path)
            .map_err(|err| format!("Failed to read {:?}: {err}", full_path))?;
        let current_hash = hash_bytes(&data);
        let status = if current_hash == entry.hash {
            "match"
        } else {
            "mismatch"
        };
        results.push(format!("{}:{}", entry.name, status));
    }

    Ok(results)
}

fn print_json_status(action: &str, mode: Mode, env_settings: &OmegaEnvironment, manifest: &OmegaManifest, results: &[String]) {
    // Build a compact JSON payload by hand to avoid third-party crates.
    let mut message = String::new();
    message.push('{');
    message.push_str(&format!("\"action\":\"{}\",", action));
    message.push_str(&format!("\"mode\":\"{}\",", mode.as_str()));
    message.push_str(&format!("\"release_id\":\"{}\",", manifest.release_id));
    message.push_str(&format!("\"hosts\":{{\"yellow\":\"{}\",\"red\":\"{}\",\"blue\":\"{}\"}},", env_settings.yellow_host, env_settings.red_host, env_settings.blue_host));
    message.push_str("\"entries\":[");

    for (index, entry) in manifest.entries.iter().enumerate() {
        if index > 0 {
            message.push(',');
        }
        message.push_str(&format!("{{\"name\":\"{}\",\"path\":\"{}\",\"hash\":\"{}\",\"size\":{}}}",
            json_escape(&entry.name), json_escape(&entry.path), entry.hash, entry.size));
    }

    message.push(']');

    if !results.is_empty() {
        message.push_str(",\"results\":[");
        for (index, result) in results.iter().enumerate() {
            if index > 0 {
                message.push(',');
            }
            message.push_str(&format!("\"{}\"", json_escape(result)));
        }
        message.push(']');
    }

    message.push('}');
    println!("{}", message);
}

fn json_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn hash_bytes(data: &[u8]) -> String {
    // DefaultHasher is not cryptographic, but it is deterministic and available without extra
    // crates. Replace this with a SHA-256 implementation from a vendored crate when you harden
    // the manifest pipeline.
    let mut hasher = DefaultHasher::new();
    data.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}
