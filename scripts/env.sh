# source this file: puts the project-local Rust and Node first on PATH
_DT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export RUSTUP_HOME="$_DT_ROOT/.toolchain/rustup"
export CARGO_HOME="$_DT_ROOT/.toolchain/cargo"
export PATH="$_DT_ROOT/.toolchain/cargo/bin:$_DT_ROOT/.toolchain/node/bin:$PATH"
