//! Wrapper binary that pins Sentry Omega to yellow mode by default.
//! Yellow runs alongside the ecosystem hub and verifies local bots before trusting builds.

use sentry_omega::{run_cli, Mode};

fn main() {
    if let Err(error) = run_cli(Mode::Yellow) {
        eprintln!("sentry-yellow failed: {error}");
        std::process::exit(1);
    }
}
