# Digterm

A terminal that helps you understand large command output, not just display it.

> **Status:** early development (pre-0.1). Linux first; macOS and Windows are planned.

Digterm is a normal terminal (your shell, `vim`, `ssh` and so on all work) with an analysis
layer on top. Output is captured to disk unchanged, so nothing is lost to scrollback limits.

## Planned for 0.1

- Per-command output blocks, detected through shell integration
- Search, jump to line, range selection and Copy All over very large outputs
- Conservative error and warning highlighting
- Collapsing of repeated lines (view only; the original is always kept)
- A small set of documented diagnostic presets

Later: run comparison and optional local AI assistance. Everything works offline, and logs
are never uploaded without an explicit choice.

## Built with

Tauri 2, xterm.js and portable-pty (Rust).

## Development

System packages (Fedora):

```bash
sudo dnf install -y gcc gcc-c++ make pkgconf-pkg-config webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel file
```

Rust and Node are installed into `./.toolchain` and never touch your home directory:

```bash
scripts/setup-toolchain.sh
source scripts/env.sh
npm install
npm run tauri dev
```

## License

MIT
