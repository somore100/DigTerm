#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{ipc::{Channel, InvokeResponseBody}, AppHandle, Emitter, Manager, State};

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    run_path: PathBuf,
}

#[derive(Default)]
struct AppState {
    session: Mutex<Option<Session>>,
    analysis: Mutex<Option<Arc<Analysis>>>,
}

/// Line-offset index over one command's byte range of the run file.
struct Analysis {
    path: PathBuf,
    starts: Vec<u64>, // absolute file offset of each line start
    end: u64,
}

impl Analysis {
    fn read(&self, from: usize, to: usize) -> Result<Vec<String>, String> {
        let to = to.min(self.starts.len());
        if from >= to {
            return Ok(Vec::new());
        }
        let base = self.starts[from];
        let stop = if to < self.starts.len() { self.starts[to] } else { self.end };
        let mut f = File::open(&self.path).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(base)).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; (stop - base) as usize];
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(to - from);
        for i in from..to {
            let s = (self.starts[i] - base) as usize;
            let mut e = ((if i + 1 < self.starts.len() { self.starts[i + 1] } else { self.end }) - base) as usize;
            if e > s && buf[e - 1] == b'\n' {
                e -= 1;
            }
            out.push(strip_ansi(&buf[s..e]));
        }
        Ok(out)
    }
}

/// One command's output: a byte range of the run file plus its line count and exit code.
#[derive(Clone, Serialize)]
struct Block {
    id: u32,
    start: u64,
    end: u64,
    lines: u64,
    exit: Option<i32>,
}

#[derive(Clone, Copy, PartialEq)]
enum St {
    Normal,
    Esc,
    Osc,
    OscEsc,
}

/// Scans the raw PTY stream for OSC 133 markers (C = output starts, D = command finished)
/// and counts newlines in between. State survives chunk boundaries.
struct Scanner {
    st: St,
    esc_pos: u64,
    osc: Vec<u8>,
    cur: Option<(u32, u64, u64)>, // id, start offset, lines
    next_id: u32,
}

impl Scanner {
    fn new() -> Self {
        Scanner { st: St::Normal, esc_pos: 0, osc: Vec::new(), cur: None, next_id: 1 }
    }

    fn feed(&mut self, chunk: &[u8], base: u64, emit: &mut impl FnMut(Block)) {
        for (i, &b) in chunk.iter().enumerate() {
            let pos = base + i as u64;
            match self.st {
                St::Normal => match b {
                    0x1b => {
                        self.st = St::Esc;
                        self.esc_pos = pos;
                    }
                    b'\n' => {
                        if let Some(c) = self.cur.as_mut() {
                            c.2 += 1;
                        }
                    }
                    _ => {}
                },
                St::Esc => match b {
                    b']' => {
                        self.st = St::Osc;
                        self.osc.clear();
                    }
                    0x1b => self.esc_pos = pos,
                    _ => self.st = St::Normal,
                },
                St::Osc => match b {
                    0x07 => {
                        self.finish(pos + 1, emit);
                        self.st = St::Normal;
                    }
                    0x1b => self.st = St::OscEsc,
                    _ => {
                        if self.osc.len() < 64 {
                            self.osc.push(b);
                        }
                    }
                },
                St::OscEsc => {
                    if b == b'\\' {
                        self.finish(pos + 1, emit);
                    }
                    self.st = St::Normal;
                }
            }
        }
    }

    fn finish(&mut self, end_pos: u64, emit: &mut impl FnMut(Block)) {
        let Some(rest) = self.osc.strip_prefix(b"133;") else { return };
        match rest.first() {
            Some(b'C') => {
                self.cur = Some((self.next_id, end_pos, 0));
                self.next_id += 1;
            }
            Some(b'D') => {
                if let Some((id, start, lines)) = self.cur.take() {
                    let exit = std::str::from_utf8(rest.get(2..).unwrap_or(&[]))
                        .ok()
                        .and_then(|s| s.parse().ok());
                    emit(Block { id, start, end: self.esc_pos, lines, exit });
                }
            }
            _ => {}
        }
    }
}

/// Writes the integration script for known shells and returns the command to launch.
fn shell_command(shell: &str, dir: &Path) -> Result<CommandBuilder, String> {
    let name = Path::new(shell).file_name().and_then(|s| s.to_str()).unwrap_or("");
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    match name {
        "bash" => {
            let rc = dir.join("integration.bash");
            fs::write(&rc, include_str!("../shell/integration.bash")).map_err(|e| e.to_string())?;
            cmd.arg("--rcfile");
            cmd.arg(&rc);
            cmd.arg("-i");
        }
        "zsh" => {
            let zdir = dir.join("zsh");
            fs::create_dir_all(&zdir).map_err(|e| e.to_string())?;
            fs::write(zdir.join(".zshrc"), include_str!("../shell/integration.zsh"))
                .map_err(|e| e.to_string())?;
            let user = std::env::var("ZDOTDIR")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_default();
            cmd.env("DT_USER_ZDOTDIR", user);
            cmd.env("ZDOTDIR", &zdir);
        }
        _ => {}
    }
    Ok(cmd)
}

/// Starts the user's shell on a PTY. Every byte is appended to a run file on disk
/// (raw, unmodified) and streamed to the frontend. Returns the run file path.
#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    on_data: Channel<InvokeResponseBody>,
    rows: u16,
    cols: u16,
) -> Result<String, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let shell_dir = data_dir.join("shell");
    fs::create_dir_all(&shell_dir).map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut cmd = shell_command(&shell, &shell_dir)?;
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let runs_dir = data_dir.join("runs");
    fs::create_dir_all(&runs_dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let path = runs_dir.join(format!("run-{ts}.raw"));
    let mut file = File::create(&path).map_err(|e| e.to_string())?;

    *state.session.lock().unwrap() =
        Some(Session { writer, master: pair.master, run_path: path.clone() });

    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut offset: u64 = 0;
        let mut lines: u64 = 0;
        let mut scanner = Scanner::new();
        let mut last_emit = Instant::now();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    let _ = file.write_all(chunk);
                    lines += chunk.iter().filter(|&&b| b == b'\n').count() as u64;
                    scanner.feed(chunk, offset, &mut |block| {
                        let _ = app.emit("pty-block", block);
                    });
                    offset += n as u64;
                    if on_data.send(InvokeResponseBody::Raw(chunk.to_vec())).is_err() {
                        break;
                    }
                    if last_emit.elapsed() >= Duration::from_millis(100) {
                        let _ = app.emit("pty-lines", lines);
                        last_emit = Instant::now();
                    }
                }
            }
        }
        let _ = file.flush();
        let _ = app.emit("pty-lines", lines);
        let _ = child.wait();
        let _ = app.emit("pty-exit", ());
    });

    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn pty_write(state: State<'_, AppState>, data: String) -> Result<(), String> {
    let mut guard = state.session.lock().unwrap();
    let session = guard.as_mut().ok_or("no session")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(state: State<'_, AppState>, rows: u16, cols: u16) -> Result<(), String> {
    let guard = state.session.lock().unwrap();
    let session = guard.as_ref().ok_or("no session")?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// Returns the plain text of a byte range of the run file (escape sequences removed).
#[tauri::command]
fn read_block(state: State<'_, AppState>, start: u64, end: u64) -> Result<String, String> {
    if end < start {
        return Err("bad range".into());
    }
    let path = {
        let guard = state.session.lock().unwrap();
        guard.as_ref().ok_or("no session")?.run_path.clone()
    };
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; (end - start) as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(strip_ansi(&buf))
}

fn current_analysis(state: &State<'_, AppState>) -> Result<Arc<Analysis>, String> {
    state.analysis.lock().unwrap().clone().ok_or_else(|| "no block open".to_string())
}

/// Builds the line index for a block and returns its line count.
#[tauri::command]
async fn analyze_open(state: State<'_, AppState>, start: u64, end: u64) -> Result<u64, String> {
    if end < start {
        return Err("bad range".into());
    }
    let path = {
        let guard = state.session.lock().unwrap();
        guard.as_ref().ok_or("no session")?.run_path.clone()
    };
    let mut f = File::open(&path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; (end - start) as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let mut starts = Vec::new();
    if !buf.is_empty() {
        starts.push(start);
        for (i, &b) in buf.iter().enumerate() {
            if b == b'\n' && i + 1 < buf.len() {
                starts.push(start + i as u64 + 1);
            }
        }
    }
    let n = starts.len() as u64;
    *state.analysis.lock().unwrap() = Some(Arc::new(Analysis { path, starts, end }));
    Ok(n)
}

#[tauri::command]
async fn analyze_lines(state: State<'_, AppState>, from: u64, count: u64) -> Result<Vec<String>, String> {
    let a = current_analysis(&state)?;
    a.read(from as usize, (from + count) as usize)
}

/// Returns the line numbers (0-based) containing the query, capped at 200k matches.
#[tauri::command]
async fn analyze_search(state: State<'_, AppState>, query: String, case_sensitive: bool) -> Result<Vec<u64>, String> {
    let a = current_analysis(&state)?;
    let needle = if case_sensitive { query } else { query.to_lowercase() };
    let mut hits = Vec::new();
    let total = a.starts.len();
    let mut from = 0;
    while from < total && hits.len() < 200_000 {
        let to = (from + 20_000).min(total);
        for (k, line) in a.read(from, to)?.iter().enumerate() {
            let found = if case_sensitive { line.contains(&needle) } else { line.to_lowercase().contains(&needle) };
            if found {
                hits.push((from + k) as u64);
            }
        }
        from = to;
    }
    Ok(hits)
}

/// Removes escape sequences and collapses carriage-return rewrites to the final text of each line.
fn strip_ansi(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != 0x1b {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        i += 1;
        match bytes.get(i) {
            Some(b'[') => {
                i += 1;
                while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                    i += 1;
                }
                i += 1;
            }
            Some(b']') => {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == 0x07 {
                        i += 1;
                        break;
                    }
                    if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            }
            Some(_) => i += 1,
            None => {}
        }
    }
    String::from_utf8_lossy(&out)
        .split('\n')
        .map(|l| l.trim_end_matches('\r').rsplit('\r').next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, read_block, analyze_open, analyze_lines, analyze_search])
        .run(tauri::generate_context!())
        .expect("error while running Digterm");
}
