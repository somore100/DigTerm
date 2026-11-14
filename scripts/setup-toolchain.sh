#!/usr/bin/env bash
# Installs Rust and Node.js into ./.toolchain (project-local, gitignored).
# Usage: scripts/setup-toolchain.sh   then   source scripts/env.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TC="$ROOT/.toolchain"
mkdir -p "$TC"

export RUSTUP_HOME="$TC/rustup" CARGO_HOME="$TC/cargo"
if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable
fi

if [ ! -x "$TC/node/bin/node" ]; then
  base=https://nodejs.org/dist/latest-v22.x
  sums=$(curl -sf "$base/SHASUMS256.txt")
  file=$(printf '%s\n' "$sums" | grep -o 'node-v[0-9.]*-linux-x64\.tar\.xz' | head -1)
  want=$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f { print $1 }')
  curl -sf "$base/$file" -o "$TC/$file"
  # the download must match the published checksum before anything is unpacked
  echo "$want  $TC/$file" | sha256sum -c - || { rm -f "$TC/$file"; echo "Node download does not match its checksum" >&2; exit 1; }
  tar -xJ -C "$TC" -f "$TC/$file"
  rm -f "$TC/$file"
  mv "$TC/${file%.tar.xz}" "$TC/node"
fi

"$CARGO_HOME/bin/rustc" --version
"$TC/node/bin/node" --version
