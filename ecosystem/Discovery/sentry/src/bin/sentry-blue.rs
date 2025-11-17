//! Wrapper binary that defaults to blue mode.
//! Blue is the air-gapped builder responsible for reproducible release bundles.

use sentry_omega::{run_cli, Mode};

fn main() {
    if let Err(error) = run_cli(Mode::Blue) {
        eprintln!("sentry-blue failed: {error}");
        std::process::exit(1);
    }
}
