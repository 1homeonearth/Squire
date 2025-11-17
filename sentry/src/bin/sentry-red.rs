//! Wrapper binary that defaults to red mode.
//! Red runs on a separate host and double-checks Yellow’s summaries for disagreement alerts.

use sentry_omega::{run_cli, Mode};

fn main() {
    if let Err(error) = run_cli(Mode::Red) {
        eprintln!("sentry-red failed: {error}");
        std::process::exit(1);
    }
}
