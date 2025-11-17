# Vendor directory

This folder anchors vendored Rust crates so `cargo build --offline` can resolve dependencies without touching the network. The workspace currently uses only standard-library code, so there are no crates to vendor yet. Populate this directory with `cargo vendor` output before introducing external dependencies, and keep the `.cargo/config.toml` entry pointing here so offline builds stay reproducible.
