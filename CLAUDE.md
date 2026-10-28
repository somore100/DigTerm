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
  Also: `list_runs`/`scan_run`/`analyze_open_run` (history of earlier sessions), `runs_usage`/`cleanup_runs`,
  `analyze_open_ranges` (several output ranges as one view, used by "Hide commands"), `analyze_severity` (error and
  warning lines), `path_info`/`open_path`/`open_url` (Ctrl+click and the right-click menu). `cargo test` runs the unit
  tests at the bottom of the file (Scanner, strip_ansi, tokenize, group_fields, Analysis, has_word, path_info).
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
Masking of sensitive details on export; compact view (squeeze spaces, shorten long tokens and repeated path prefixes);
multi-line block folding; `command | digterm`; presets; run comparison. Also wanted: `cargo test` in CI, showing a
command that is still running in the Commands list, remembering each command's folder so Ctrl+click on old output
resolves correctly, and trying everything on Windows and macOS.

## Testing notes
- `npm run test:ui` also checks the right-click menu (it must survive mousedown and blur, and `cd` must reach the shell).
  The stubs in `scripts/ui-smoke/stubs/` record every `invoke` in `globalThis.__calls`.
- A menu or popup that listens for `blur` or `mousedown` on `window` in the capture phase also sees every element's
  events: ignore events whose target is not the window or is inside the popup.
