//! Minimal CLI for the Rust rewrite. Commands are intentionally small and
//! auditable so operators can see exactly how secrets are handled.

use std::env;

use serde_json::json;
use squire_rs::config::load_config;
use squire_rs::crypto::integrity::sha256_hex;
use squire_rs::crypto::passwords::{hash_password, verify_password};
use squire_rs::crypto::secrets::{EncryptedSecret, SecretVault};

fn print_usage() {
    eprintln!("Commands:\n  hash-password <plaintext>\n  verify-password <plaintext> <argon2-hash>\n  encrypt-secret <env_var_with_base64_key> <plaintext>\n  decrypt-secret <env_var_with_base64_key> <json-envelope>\n  hash-bytes <data>\n  load-config <path>");
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        print_usage();
        return;
    }

    match args[1].as_str() {
        "hash-password" => {
            if args.len() != 3 {
                return print_usage();
            }
            match hash_password(&args[2]) {
                Ok(hash) => println!("{hash}"),
                Err(err) => eprintln!("hashing failed: {err}"),
            }
        }
        "verify-password" => {
            if args.len() != 4 {
                return print_usage();
            }
            let matches = verify_password(&args[2], &args[3]);
            println!("{}", if matches { "match" } else { "no-match" });
        }
        "encrypt-secret" => {
            if args.len() != 4 {
                return print_usage();
            }
            let vault = match SecretVault::from_env_var(&args[2]) {
                Ok(v) => v,
                Err(e) => return eprintln!("vault setup failed: {e}"),
            };
            match vault.encrypt_secret(args[3].as_bytes()) {
                Ok(secret) => println!("{}", serde_json::to_string_pretty(&secret).unwrap()),
                Err(err) => eprintln!("encryption failed: {err}"),
            }
        }
        "decrypt-secret" => {
            if args.len() != 4 {
                return print_usage();
            }
            let vault = match SecretVault::from_env_var(&args[2]) {
                Ok(v) => v,
                Err(e) => return eprintln!("vault setup failed: {e}"),
            };
            let envelope: EncryptedSecret = match serde_json::from_str(&args[3]) {
                Ok(env) => env,
                Err(err) => return eprintln!("invalid envelope json: {err}"),
            };
            match vault.decrypt_secret(&envelope) {
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => println!("{text}"),
                    Err(err) => eprintln!("decryption succeeded but UTF-8 failed: {err}"),
                },
                Err(err) => eprintln!("decryption failed: {err}"),
            }
        }
        "hash-bytes" => {
            if args.len() != 3 {
                return print_usage();
            }
            println!("{}", sha256_hex(args[2].as_bytes()));
        }
        "load-config" => {
            if args.len() != 3 {
                return print_usage();
            }
            match load_config(&args[2]) {
                Ok(cfg) => {
                    let printable = json!({
                        "applicationId": cfg.application_id,
                        "loggingServerId": cfg.logging_server_id,
                        "debugLevel": cfg.debug_level,
                        "token": "<redacted in output>"
                    });
                    println!("{}", serde_json::to_string_pretty(&printable).unwrap());
                }
                Err(err) => eprintln!("config load failed: {err}"),
            }
        }
        _ => print_usage(),
    }
}
