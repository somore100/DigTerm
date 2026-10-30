# Digterm

A terminal that helps you **understand** large command output, not just display it.

Digterm is a normal terminal (your own shell; `vim`, `ssh` and `htop` all work) with an analysis layer on top.
Everything a command prints is also saved to disk unchanged, so nothing is lost to scrollback limits, and you can
open any command's output in a viewer built for very large outputs.

> **Status:** early development (0.2). Linux is the primary platform. Windows and macOS builds are
> produced by CI but are not finished yet (see [Platform support](#platform-support)). Not yet code-signed.

## Why Digterm?

- **Nothing is lost.** Every byte a command prints is saved to disk, so a long build or a noisy log never scrolls out of
  reach, and any command's output can be reopened later.
- **Built to be understood, not just displayed.** Search, jump to a line, fold the thousands of repeated lines, and see
  which messages are the same kind (`item ⟨1…5000⟩`, `user ⟨alice ×50, bob ×50⟩ failed to log in`) instead of
  scrolling through them.
- **Never rewrites your output.** Folding, wrapping and highlighting only change what you see. Copy gives you the
  original text, or the folded version if you ask for it, and the saved output stays untouched.
- **Still a normal terminal.** Your shell, your tools, `vim` and `ssh` all work. The extra features appear only when you
  ask for them (Analyze, Patterns, Find), so nothing gets in the way.
- **Works with logs from anywhere.** Paste a log copied from another terminal, or drop a log file onto the window.
- **Private and offline.** No account, no network access, no telemetry. Your output never leaves your computer.
- **Open source.** MIT licensed, and built on open components.

## Features

**Terminal**
- Real shell sessions with full terminal support (powered by xterm.js).
- Tabs and tiled split panes, with a tab overview grid (like *Show Open Tabs* in Fedora's terminal).
- Reopens your tabs, splits and working directories on start (can be turned off).
- Light, dark or follow-system theme, zoom, find in terminal, fullscreen.
- Every shortcut can be rebound (Ctrl+Shift+?).

**Per-command output blocks**
- Each command you run becomes a numbered entry in the Commands panel (1., 2., 3. …) showing the command, its line
  count, how long it took and its exit code.
- **Copy** takes the output only, or the command and its output (choose with the ▾ button).
- **Analyze** opens that command's output in the viewer.
- **Split by entry** (checkbox above the list, default set in Preferences): when off, Analyze and Copy work on the
  whole run, so several pasted commands come out together. In the whole-run viewer, **Hide commands** leaves out the
  prompts and typed commands and shows only the output.
- The list can show the newest command at the top or at the bottom (Preferences). At the bottom it follows new commands.
- **History of earlier sessions** (menu): browse the saved output of earlier sessions, open any command in the viewer,
  or clear the history. Old saved output can also be deleted automatically after a number of days (Preferences, off by
  default), and the disk space it uses is shown there.

**Files, folders and links in the output**
- **Ctrl+click** a folder name (for example in `ls` output) to `cd` into it, a text file to open it in the viewer, any
  other file in its default application, and a `http(s)` or `localhost:port` link in the browser.
- **Right-click** the same names (or select one first) for all choices: open folder here, open in file manager, open in
  the viewer, show in the terminal (`cat`), open with the default app, show in file manager, open in browser, copy path.
- Can be switched off in Preferences. Names are looked up in the terminal's current folder.

**From the command line**
- `digterm file.log` opens a text file in the viewer.
- `some-command 2>&1 | digterm -` sends any command's output into the viewer. The window opens when the command has
  finished. Up to 1 GiB is kept.

**Output viewer**
- Opens outputs of millions of lines instantly: only the visible lines are ever loaded.
- Search, go to line, keyboard caret (arrows, Shift+arrows, Home/End) and exact text selection and copy.
- Highlighting of words such as `error`, `crash` or `warning`, with your own word lists. Purely visual.
- **Folding** repeated lines, view only (the original is never changed):
  - exact repeats: `line text ×4,213`
  - repeats with number patterns: `item ⟨1…5000, +1⟩ ×5,000`
  - repeats with word/field patterns: `user ⟨alice ×50, bob ×50⟩ failed to log in ×100`
  - repeated multi-line blocks (the same stack trace or record over and over), exact or ignoring numbers:
    `⟲ 3-line block × 40: first line …`
  - always shows both counts, for example `15,009 lines · 12 after collapsing`
- **Compact view** (the **Compact…** button, off by default): squeeze runs of spaces, shorten very long words such as
  hashes and ids, and replace folders that start many paths with a short tag (`⟨1⟩ = /home/me/project`, shown in the
  panel). **Best compression** measures every folding mode and all compact options and applies what saves the most.
  View only; while it is on, copying gives the compact text and long lines are not wrapped.
- **Errors:** jump to the next or previous error line with the ▲ ▼ buttons or F8 / Shift+F8, or show only error lines, or
  only warning and error lines (everything else collapses into `⋯ N lines hidden` rows). Uses the same word lists as the
  highlighting.
- Zoom with Ctrl +/−/0 or Ctrl+wheel.
- **Leave feedback…** (main menu): bug report, suggestion or question with an optional, previewed list of your computer
  specifications. It opens your email app (or Gmail, or copies the text) with the report ready; nothing is sent until you
  press Send, and no email password is stored in the app.

**Privacy:** everything stays on your machine. Nothing is uploaded, and no network access is needed.

## Keyboard shortcuts

| Action | Default |
|---|---|
| New tab / split pane / close pane | Ctrl+Shift+T / Ctrl+Shift+D / Ctrl+Shift+W |
| Previous / next tab | Ctrl+PageUp / Ctrl+PageDown |
| Go to tab 1–9 | Alt+1 … Alt+9 |
| Show open tabs | Ctrl+Shift+O |
| Find in terminal | Ctrl+Shift+F |
| Copy selection | Ctrl+Shift+C (plain Ctrl+C still interrupts the shell) |
| Show or hide the command list | Ctrl+Shift+B |
| Zoom in / out / reset | Ctrl+= / Ctrl+- / Ctrl+0 |
| Fullscreen | F11 |
| Preferences / keyboard shortcuts | Ctrl+, / Ctrl+? |

All of these except Alt+1–9 can be changed in the shortcuts dialog.

## How it works

1. The app starts your `$SHELL` on a pseudo-terminal and streams everything it prints into the window.
2. Every byte is also appended, unchanged, to a *run file* on disk.
3. A small shell-integration script (loaded automatically for bash and zsh, no config changes needed) makes the shell
   print invisible markers around each command. The backend uses them to record where each command's output starts
   and ends in the run file, and how many lines it has.
4. The viewer builds a line index over that byte range and reads only the lines on screen. Folding and highlighting are
   computed on top of it and never modify the saved output.

Run files are stored in the app data folder (on Linux, `~/.local/share/dev.digterm.terminal/runs/`).

## Install

Pre-built packages are published on the [Releases](https://github.com/somore100/DigTerm/releases) page when a version
is tagged:

| Platform | Packages |
|---|---|
| Linux (x86-64, arm64 experimental) | `.rpm` (Fedora, openSUSE), `.deb` (Debian, Ubuntu), `.AppImage` (any distribution) |
| Windows (x86-64, arm64 experimental) | `.exe` installer, `.msi` |
| macOS (Apple silicon and Intel) | `.dmg` |

The builds are not code-signed yet, so Windows SmartScreen and macOS Gatekeeper will warn before the first start.

## Build from source

System packages on Fedora:

```bash
sudo dnf install -y gcc gcc-c++ make pkgconf-pkg-config webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel file
```

Rust and Node are installed into `./.toolchain` and never touch your home directory:

```bash
scripts/setup-toolchain.sh
source scripts/env.sh
npm install
npm run tauri dev                              # run with live reload
npm run tauri build -- --bundles rpm,deb       # build Linux packages (in src-tauri/target/release/bundle/)
```

On Debian or Ubuntu use the equivalent `-dev` packages from the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

## Platform support

| Platform | State |
|---|---|
| Linux | Primary target. Full feature set, tested on Fedora. |
| Windows | Builds. Falls back to `cmd.exe`; no command blocks yet, folder restore not implemented. |
| macOS | Builds. Command blocks work with zsh; folder restore not implemented. |

## Roadmap

Roughly in the order I plan to do them. Nothing here is promised, and the order may change.

**Done in 0.2**
- Command text, duration and numbering in the Commands list; history of earlier sessions and cleanup of old saved
  output; jumping between errors and a severity filter; Ctrl+click and right-click on folders, files and links;
  whole-run analysis and copy; masking on copy; `digterm file` / `cmd | digterm -`; multi-line block folding; compact
  view with best compression; Rust unit tests.

**Next**
- Export or copy a viewer selection with sensitive details (usernames, IP addresses, paths) masked.
- Step through a pattern's lines with ▲ ▼ buttons, and group by words and ids as well as numbers.

**Then**
- Ctrl+click on `file:line` in the output to open it at that line.
- Follow a running command's output live in the viewer.
- Diagnostic command presets (read-only, documented, human-editable), with a clear explanation before anything needs elevated privileges.
- Comparing two runs of the same command, ignoring timestamps and process ids.
- New Window.

**Platforms**
- PowerShell, cmd and fish integration, and remembering folders on Windows and macOS.
- Code signing and automatic updates.

**Maybe**
- Optional local AI assistance (never sends logs anywhere without an explicit choice).
- Skipping full-screen programs such as `vim` in the command list.

## Built with

[Tauri 2](https://tauri.app), [xterm.js](https://xtermjs.org) and [portable-pty](https://crates.io/crates/portable-pty).

## License

MIT
