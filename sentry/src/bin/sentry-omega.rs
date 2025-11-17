//! Primary CLI entrypoint for Sentry Omega.
//! Defaults to yellow mode so it can run inside the ecosystem host unless a caller overrides
//! `--mode`.

use sentry_omega::{run_cli, Mode};

fn main() {
    if let Err(error) = run_cli(Mode::Yellow) {
        eprintln!("sentry-omega failed: {error}");
        std::process::exit(1);
    }
}
