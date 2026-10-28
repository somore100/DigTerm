# Digterm: notes for working on this repo

A terminal (Tauri 2 + xterm.js + portable-pty) with an analysis layer: per-command output blocks and a viewer for
very large outputs. MIT licensed. Public repo: github.com/somore100/DigTerm. Version 0.2.0 (early development).

## How the user and the assistant work together
- The assistant's sandbox is Ubuntu and has **no C compiler, no `git`, no `sudo`**. It can edit files and run Node,
  but it **cannot compile the Rust or launch the app**. The user builds and tests on their Fedora machine and pastes
  results back. Say clearly what is untested; never claim something works that was not run.
- Rust is written without a compiler to check it, so read it twice. `npm run test:ui` (jsdom smoke test) *can* be run
  in the sandbox and catches JS crashes such as a missing function; run it after changing `src/`.
- The user commits and pushes themselves: give a one-line `git add -A && git commit -m "..." && git push github main`.
- This folder (`~/AI_Workspace/projects/Local/DigTerm`) is the working repo. `~/Documents/Hot/.../DigTerm` is a mirror
  that pulls from it. The GitHub remote is called `github`.
- Run the app with one line: `cd <repo> && source scripts/env.sh && npm run tauri dev`. Rust and Node live in
  `./.toolchain` (gitignored); `scripts/setup-toolchain.sh` installs them. Never install tools outside the repo.
- The user likes: small steps, one-line commands, concrete test steps after each change, honest limits, and options
  that are off by default when they change behaviour.

## Layout
- `src-tauri/src/main.rs`: everything in Rust. Sessions (PTY + run file), the OSC 133 `Scanner` that finds each command's
  byte range, `analyze_*` commands (line index, lines, search, folding groups, patterns, lengths), layout save/load.
- `src-tauri/shell/`: bash and zsh integration scripts (print OSC 133 markers). Loaded automatically.
- `src/main.js`: tabs, panes (`Pane` class), overview, menu, preferences, shortcuts, dialogs, zoom, persistence.
- `src/analyze.js`: the viewer (virtualized rows, folding model, wrapping into sub-lines, caret, patterns, highlight).
- `src/style.css`: all styling, theme variables at the top (`[data-theme="light"]` overrides).
- `scripts/ui-smoke/`: jsdom smoke test (`npm run test:ui`). `.github/workflows/`: `check.yml`, `release.yml`.

## Ideas that matter
- Output is saved raw to `~/.local/share/dev.digterm.terminal/runs/run-*.raw`; blocks are byte ranges into it. The viewer
  only reads visible lines. Folding, wrapping and highlighting are view-only; the saved output is never changed.
- Viewer row math: view rows (after folding) map to original lines (`rowAt`/`viewOf`); long lines add extra visual rows
  (`ex`/`exCum`, `yOfV`/`vAtY`). Keep both models in sync when changing rendering.
- Linux only so far: folder restore reads `/proc/<pid>/cwd`; GDK_BACKEND=x11 and WebKit workarounds are set in `main()`
  to avoid ghosting while resizing under Wayland.
- Releases: pushing a tag `vX.Y.Z` runs `release.yml` and creates a DRAFT pre-release with installers. Keep the version
  in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` (and the About text in `src/main.js`) equal.

## Next up (see README roadmap)
Command text and duration in the Commands list; history of earlier sessions and cleanup of old run files; jump between
errors and severity filter; masking of sensitive details on export; compact view (squeeze spaces, shorten long tokens
and repeated path prefixes); multi-line block folding; Ctrl+click folders; `command | digterm`; presets; run comparison.
Rust unit tests for `Scanner`, `tokenize`, `group_fields` and `strip_ansi` are wanted but not written yet.
