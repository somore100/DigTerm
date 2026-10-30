#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicU32, Ordering}, Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{ipc::{Channel, InvokeResponseBody}, AppHandle, Emitter, Manager, State};

struct Session {
    /// Keystrokes and pastes go to a writer thread, so a shell that is slow to read never blocks the window.
    input: std::sync::mpsc::Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    run_path: PathBuf,
    pid: Option<u32>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
struct AppState {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
    analysis: Mutex<Option<Arc<Analysis>>>,
}

/// Line-offset index over one command's byte range of the run file.
struct Analysis {
    path: PathBuf,
    starts: Vec<u64>, // absolute file offset of each line start
    end: u64,
    /// Absolute end of each line, only when the lines come from several separate ranges (gaps between them).
    ends: Option<Vec<u64>>,
}

impl Analysis {
    fn line_end(&self, i: usize) -> u64 {
        match &self.ends {
            Some(e) => e[i],
            None if i + 1 < self.starts.len() => self.starts[i + 1],
            None => self.end,
        }
    }

    fn read(&self, from: usize, to: usize) -> Result<Vec<String>, String> {
        let to = to.min(self.starts.len());
        if from >= to {
            return Ok(Vec::new());
        }
        let base = self.starts[from];
        let stop = self.line_end(to - 1);
        let mut f = File::open(&self.path).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(base)).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; (stop - base) as usize];
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(to - from);
        for i in from..to {
            let s = (self.starts[i] - base) as usize;
            let mut e = (self.line_end(i) - base) as usize;
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
    session: u32,
    id: u32,
    /// Where the typed command begins (after the prompt); `start..end` is the output alone.
    cmd_start: u64,
    start: u64,
    end: u64,
    lines: u64,
    exit: Option<i32>,
    /// Wall-clock time between the output starting and the command finishing.
    ms: u64,
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
    cur: Option<(u32, u64, u64, u64)>, // id, output start, lines, command start
    b_pos: Option<u64>,
    t0: Option<Instant>,
    next_id: u32,
}

impl Scanner {
    fn new() -> Self {
        Scanner { st: St::Normal, esc_pos: 0, osc: Vec::new(), cur: None, b_pos: None, t0: None, next_id: 1 }
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
            Some(b'B') => self.b_pos = Some(end_pos),
            Some(b'C') => {
                let cmd_start = self.b_pos.take().unwrap_or(end_pos);
                self.cur = Some((self.next_id, end_pos, 0, cmd_start));
                self.t0 = Some(Instant::now());
                self.next_id += 1;
            }
            Some(b'D') => {
                if let Some((id, start, lines, cmd_start)) = self.cur.take() {
                    let exit = std::str::from_utf8(rest.get(2..).unwrap_or(&[]))
                        .ok()
                        .and_then(|s| s.parse().ok());
                    let ms = self.t0.take().map_or(0, |t| t.elapsed().as_millis() as u64);
                    emit(Block { session: 0, id, cmd_start, start, end: self.esc_pos, lines, exit, ms });
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

#[derive(Serialize)]
struct Spawned {
    id: u32,
    run_file: String,
}

#[derive(Clone, Serialize)]
struct LinesEvent {
    id: u32,
    lines: u64,
}

/// Starts the user's shell on a PTY in `cwd` (falling back to home). Every byte is appended to a
/// run file on disk (raw, unmodified) and streamed to the frontend.
#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    on_data: Channel<InvokeResponseBody>,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
) -> Result<Spawned, String> {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let shell_dir = data_dir.join("shell");
    fs::create_dir_all(&shell_dir).map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(windows) {
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
        } else {
            "/bin/sh".into()
        }
    });
    let mut cmd = shell_command(&shell, &shell_dir)?;
    let start_dir = cwd.filter(|d| Path::new(d).is_dir()).or_else(home_dir);
    if let Some(dir) = start_dir {
        cmd.cwd(dir);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let pid = child.process_id();
    let killer = child.clone_killer();

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let (input, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        // Writing blocks while the shell is busy and the terminal's input buffer is full (a big paste).
        // Doing it here, off the UI thread and without holding the sessions lock, keeps the app responsive.
        for data in input_rx {
            if writer.write_all(&data).is_err() {
                break;
            }
            let _ = writer.flush();
        }
    });

    let runs_dir = data_dir.join("runs");
    fs::create_dir_all(&runs_dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let path = runs_dir.join(format!("run-{ts}-{id}.raw"));
    let mut file = File::create(&path).map_err(|e| e.to_string())?;

    state.sessions.lock().unwrap().insert(
        id,
        Session { input, master: pair.master, run_path: path.clone(), pid, killer },
    );

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
                    scanner.feed(chunk, offset, &mut |mut block| {
                        block.session = id;
                        let _ = app.emit("pty-block", block);
                    });
                    offset += n as u64;
                    if on_data.send(InvokeResponseBody::Raw(chunk.to_vec())).is_err() {
                        break;
                    }
                    if last_emit.elapsed() >= Duration::from_millis(100) {
                        let _ = app.emit("pty-lines", LinesEvent { id, lines });
                        last_emit = Instant::now();
                    }
                }
            }
        }
        let _ = file.flush();
        let _ = app.emit("pty-lines", LinesEvent { id, lines });
        let _ = child.wait();
        let _ = app.emit("pty-exit", id);
    });

    Ok(Spawned { id, run_file: path.to_string_lossy().into_owned() })
}

#[tauri::command]
fn pty_write(state: State<'_, AppState>, id: u32, data: String) -> Result<(), String> {
    let guard = state.sessions.lock().unwrap();
    let session = guard.get(&id).ok_or("no session")?;
    session.input.send(data.into_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(state: State<'_, AppState>, id: u32, rows: u16, cols: u16) -> Result<(), String> {
    let guard = state.sessions.lock().unwrap();
    let session = guard.get(&id).ok_or("no session")?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// Ends a session: kills its shell and forgets it. The run file stays on disk.
#[tauri::command]
fn pty_close(state: State<'_, AppState>, id: u32) {
    if let Some(mut session) = state.sessions.lock().unwrap().remove(&id) {
        let _ = session.killer.kill();
    }
}

/// The shell's current working directory (Linux only for now).
#[tauri::command]
fn pty_cwd(state: State<'_, AppState>, id: u32) -> Option<String> {
    let pid = state.sessions.lock().unwrap().get(&id)?.pid?;
    #[cfg(target_os = "linux")]
    {
        return fs::read_link(format!("/proc/{pid}/cwd")).ok().map(|p| p.to_string_lossy().into_owned());
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

#[derive(Serialize)]
struct PathInfo {
    /// "dir", "text" (a file that looks like text), "file" (anything else) or "" (does not exist).
    kind: &'static str,
    /// Absolute path when it exists.
    path: String,
}

/// True when the start of the file has no NUL bytes and is valid UTF-8 (a cut-off last character is fine).
fn looks_like_text(path: &Path) -> bool {
    let Ok(mut f) = File::open(path) else { return false };
    let mut buf = [0u8; 4096];
    let n = f.read(&mut buf).unwrap_or(0);
    if buf[..n].contains(&0) {
        return false;
    }
    match std::str::from_utf8(&buf[..n]) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none(),
    }
}

/// Looks up words from the terminal output: what each one is on disk. Relative names are looked up
/// in `cwd`, `~` is the home folder.
#[tauri::command]
fn path_info(cwd: Option<String>, names: Vec<String>) -> Vec<PathInfo> {
    let home = home_dir();
    let none = || PathInfo { kind: "", path: String::new() };
    names
        .iter()
        .take(256)
        .map(|n| {
            let path = if n == "~" || n.starts_with("~/") {
                match &home {
                    Some(h) => PathBuf::from(h).join(n.trim_start_matches('~').trim_start_matches('/')),
                    None => return none(),
                }
            } else {
                PathBuf::from(n)
            };
            let full = if path.is_absolute() {
                path
            } else {
                match &cwd {
                    Some(c) => Path::new(c).join(path),
                    None => return none(),
                }
            };
            let kind = if full.is_dir() {
                "dir"
            } else if full.is_file() {
                if looks_like_text(&full) { "text" } else { "file" }
            } else {
                return none();
            };
            let full = fs::canonicalize(&full).unwrap_or(full);
            PathInfo { kind, path: full.to_string_lossy().into_owned() }
        })
        .collect()
}

/// Starts a command without waiting for it and reaps it in the background.
fn spawn_detached(mut cmd: std::process::Command) -> Result<(), String> {
    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start the system opener: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait(); // so it does not stay a zombie
    });
    Ok(())
}

/// Opens a file or folder with the system's default application.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("That path no longer exists.".into());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(&path);
    spawn_detached(cmd)
}

/// Opens an http(s) link in the default browser. Anything else is refused.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http and https links can be opened.".into());
    }
    open_default(&url)
}

/// Opens a `mailto:` link in the default email app (used by the feedback window). Anything else is refused.
#[tauri::command]
fn open_mailto(url: String) -> Result<(), String> {
    if !url.starts_with("mailto:") {
        return Err("Only mailto links can be opened here.".into());
    }
    open_default(&url)
}

fn open_default(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(url);
    spawn_detached(cmd)
}

fn os_release_name(text: &str) -> Option<String> {
    text.lines()
        .find_map(|l| l.strip_prefix("PRETTY_NAME="))
        .map(|v| v.trim().trim_matches('"').to_string())
}

fn cpu_model(text: &str) -> Option<String> {
    text.lines().find(|l| l.starts_with("model name")).and_then(|l| l.split_once(':')).map(|(_, v)| v.trim().to_string())
}

fn mem_total(text: &str) -> Option<String> {
    let kb: u64 = text.lines().find_map(|l| l.strip_prefix("MemTotal:"))?.trim().trim_end_matches("kB").trim().parse().ok()?;
    Some(format!("{:.1} GB", kb as f64 / 1_048_576.0))
}

/// Graphics adapters from `lspci` output (one line per device); the bus address and revision are dropped.
fn gpu_names(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| ["VGA compatible controller", "3D controller", "Display controller"].iter().any(|c| l.contains(c)))
        .filter_map(|l| l.split_once(": ").map(|(_, name)| name))
        .map(|name| name.split(" (rev").next().unwrap_or(name).trim().to_string())
        .collect()
}

/// What the feedback window offers to include, shown to the user before anything is sent: system, CPU, graphics
/// card, memory and architecture. No host name, user name, serial numbers, addresses or paths.
#[tauri::command]
async fn system_info() -> Vec<(String, String)> {
    let mut out = Vec::new();
    #[cfg(target_os = "linux")]
    {
        let read = |p: &str| fs::read_to_string(p).unwrap_or_default();
        let os = os_release_name(&read("/etc/os-release")).unwrap_or_else(|| "Linux".into());
        let kernel = read("/proc/sys/kernel/osrelease");
        out.push(("OS".to_string(), format!("{os}, kernel {}", kernel.trim())));
        out.push(("CPU".to_string(), cpu_model(&read("/proc/cpuinfo")).unwrap_or_else(|| "unknown".into())));
        let gpus = std::process::Command::new("lspci")
            .output()
            .ok()
            .map(|o| gpu_names(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_default();
        out.push(("GPU".to_string(), if gpus.is_empty() { "not detected (lspci missing?)".into() } else { gpus.join("; ") }));
        out.push(("RAM".to_string(), mem_total(&read("/proc/meminfo")).unwrap_or_else(|| "unknown".into())));
    }
    #[cfg(not(target_os = "linux"))]
    {
        out.push(("OS".to_string(), std::env::consts::OS.to_string()));
        for k in ["CPU", "GPU", "RAM"] {
            out.push((k.to_string(), "not available on this platform yet".to_string()));
        }
    }
    out.push(("Architecture".to_string(), std::env::consts::ARCH.to_string()));
    out
}

#[tauri::command]
fn save_layout(app: AppHandle, json: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("layout.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_layout(app: AppHandle) -> Result<Option<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(fs::read_to_string(dir.join("layout.json")).ok())
}

/// Saved output files (`run-*.raw`) as (path, size, age in seconds).
fn run_files(app: &AppHandle) -> Result<Vec<(PathBuf, u64, u64)>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("runs");
    let Ok(rd) = fs::read_dir(dir) else { return Ok(Vec::new()) };
    let now = SystemTime::now();
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("run-") && name.ends_with(".raw")) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let age = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).map_or(0, |d| d.as_secs());
        out.push((path, meta.len(), age));
    }
    Ok(out)
}

/// How many saved output files there are and their total size in bytes.
#[tauri::command]
fn runs_usage(app: AppHandle) -> Result<(u64, u64), String> {
    let files = run_files(&app)?;
    Ok((files.len() as u64, files.iter().map(|f| f.1).sum()))
}

/// Deletes saved output files not modified for `days` days (0 = all of them). Files of open
/// terminals are never touched. Returns (files deleted, bytes freed).
#[tauri::command]
fn cleanup_runs(app: AppHandle, state: State<'_, AppState>, days: u64) -> Result<(u64, u64), String> {
    let live: Vec<PathBuf> = state.sessions.lock().unwrap().values().map(|s| s.run_path.clone()).collect();
    let limit = days.saturating_mul(86_400);
    let (mut n, mut bytes) = (0u64, 0u64);
    for (path, size, age) in run_files(&app)? {
        if live.contains(&path) || (days > 0 && age < limit) {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            n += 1;
            bytes += size;
        }
    }
    Ok((n, bytes))
}

#[derive(Serialize)]
struct RunInfo {
    name: String,
    size: u64,
    /// Last modification, seconds since the Unix epoch.
    modified: u64,
    /// True while a terminal still writes to this file.
    open: bool,
}

/// Saved output files of this and earlier sessions, newest first.
#[tauri::command]
fn list_runs(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<RunInfo>, String> {
    let live: Vec<PathBuf> = state.sessions.lock().unwrap().values().map(|s| s.run_path.clone()).collect();
    let mut out = Vec::new();
    for (path, size, age) in run_files(&app)? {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        out.push(RunInfo { open: live.contains(&path), name, size, modified: now.saturating_sub(age) });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then(b.name.cmp(&a.name)));
    Ok(out)
}

/// Path of a saved output file by name; refuses anything that is not a plain `run-*.raw` name.
fn run_path_by_name(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !(name.starts_with("run-") && name.ends_with(".raw")) || name.contains('/') || name.contains('\\') {
        return Err("not a saved output file".into());
    }
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("runs").join(name))
}

/// Finds the commands in a saved output file by running it through the same OSC 133 scanner
/// as live output. Returns each block with its command text. Durations are not known (`ms` is 0).
#[tauri::command]
async fn scan_run(app: AppHandle, name: String) -> Result<Vec<(Block, String)>, String> {
    let path = run_path_by_name(&app, &name)?;
    let mut f = File::open(&path).map_err(|e| e.to_string())?;
    let mut scanner = Scanner::new();
    let mut blocks = Vec::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut offset = 0u64;
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        scanner.feed(&buf[..n], offset, &mut |b| blocks.push(b));
        offset += n as u64;
    }
    let mut out = Vec::with_capacity(blocks.len());
    for b in blocks {
        let len = b.start.saturating_sub(b.cmd_start).min(2000) as usize;
        let mut cmd = vec![0u8; len];
        f.seek(SeekFrom::Start(b.cmd_start)).map_err(|e| e.to_string())?;
        f.read_exact(&mut cmd).map_err(|e| e.to_string())?;
        out.push((b, strip_ansi(&cmd)));
    }
    Ok(out)
}

/// Opens a command's output from a saved file of an earlier session in the viewer.
#[tauri::command]
async fn analyze_open_run(app: AppHandle, state: State<'_, AppState>, name: String, start: u64, end: u64) -> Result<u64, String> {
    if end < start {
        return Err("bad range".into());
    }
    let path = run_path_by_name(&app, &name)?;
    set_analysis(&state, path, start, end)
}

/// Size in bytes of a session's run file (for analysing its full output).
#[tauri::command]
fn session_len(state: State<'_, AppState>, id: u32) -> Result<u64, String> {
    let path = session_path(&state, id)?;
    Ok(fs::metadata(path).map_err(|e| e.to_string())?.len())
}

#[tauri::command]
fn home_dir() -> Option<String> {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok()
}

fn session_path(state: &State<'_, AppState>, id: u32) -> Result<PathBuf, String> {
    let guard = state.sessions.lock().unwrap();
    Ok(guard.get(&id).ok_or("no session")?.run_path.clone())
}

/// Returns the plain text of a byte range of a session's run file (escape sequences removed).
#[tauri::command]
fn read_block(state: State<'_, AppState>, session: u32, start: u64, end: u64) -> Result<String, String> {
    if end < start {
        return Err("bad range".into());
    }
    let path = session_path(&state, session)?;
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; (end - start) as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(strip_ansi(&buf))
}

fn current_analysis(state: &State<'_, AppState>) -> Result<Arc<Analysis>, String> {
    state.analysis.lock().unwrap().clone().ok_or_else(|| "no block open".to_string())
}

/// Line-start offsets of the byte range `start..end` of a file.
fn index_file(path: &Path, start: u64, end: u64) -> Result<Vec<u64>, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
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
    Ok(starts)
}

fn set_analysis(state: &State<'_, AppState>, path: PathBuf, start: u64, end: u64) -> Result<u64, String> {
    let starts = index_file(&path, start, end)?;
    let n = starts.len() as u64;
    *state.analysis.lock().unwrap() = Some(Arc::new(Analysis { path, starts, end, ends: None }));
    Ok(n)
}

/// Builds the line index for a command's output and returns its line count.
#[tauri::command]
async fn analyze_open(state: State<'_, AppState>, session: u32, start: u64, end: u64) -> Result<u64, String> {
    if end < start {
        return Err("bad range".into());
    }
    let path = session_path(&state, session)?;
    set_analysis(&state, path, start, end)
}

/// Opens several output ranges of a session's run file as one view, leaving out what lies between
/// them (prompts and typed commands).
#[tauri::command]
async fn analyze_open_ranges(state: State<'_, AppState>, session: u32, ranges: Vec<(u64, u64)>) -> Result<u64, String> {
    let path = session_path(&state, session)?;
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    for &(from, to) in &ranges {
        if to < from {
            return Err("bad range".into());
        }
        let seg = index_file(&path, from, to)?;
        for (i, &st) in seg.iter().enumerate() {
            starts.push(st);
            ends.push(seg.get(i + 1).copied().unwrap_or(to));
        }
    }
    let n = starts.len() as u64;
    let end = ends.last().copied().unwrap_or(0);
    *state.analysis.lock().unwrap() = Some(Arc::new(Analysis { path, starts, end, ends: Some(ends) }));
    Ok(n)
}

/// Analyzes text pasted by the user (for example a log copied from another terminal).
#[tauri::command]
async fn analyze_open_text(app: AppHandle, state: State<'_, AppState>, text: String) -> Result<u64, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("imports");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("last-paste.txt");
    fs::write(&path, text.as_bytes()).map_err(|e| e.to_string())?;
    set_analysis(&state, path, 0, text.len() as u64)
}

/// Analyzes any text file on disk (read only), for example a log file dropped onto the window.
#[tauri::command]
async fn analyze_open_file(state: State<'_, AppState>, path: String) -> Result<u64, String> {
    let path = PathBuf::from(path);
    let len = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if len > 1 << 30 {
        return Err("That file is larger than 1 GiB, which the viewer can't load yet.".into());
    }
    set_analysis(&state, path, 0, len)
}

/// Length of every line in UTF-16 units (what JavaScript counts), as little-endian u32s.
#[tauri::command]
async fn analyze_lengths(state: State<'_, AppState>) -> Result<tauri::ipc::Response, String> {
    let a = current_analysis(&state)?;
    let total = a.starts.len();
    let mut out: Vec<u8> = Vec::with_capacity(total * 4);
    let mut from = 0;
    while from < total {
        let to = (from + 20_000).min(total);
        for line in a.read(from, to)? {
            let n: usize = line.chars().map(|c| c.len_utf16()).sum();
            out.extend_from_slice(&(n.min(u32::MAX as usize) as u32).to_le_bytes());
        }
        from = to;
    }
    Ok(tauri::ipc::Response::new(out))
}

#[tauri::command]
async fn analyze_lines(state: State<'_, AppState>, from: u64, count: u64) -> Result<Vec<String>, String> {
    let a = current_analysis(&state)?;
    a.read(from as usize, (from + count) as usize)
}

#[derive(Serialize)]
struct Group {
    first: u64,
    count: u64,
    /// Template with number ranges, e.g. `item ⟨1…5000, +1⟩`; None for exact repeats.
    summary: Option<String>,
}

enum Tok<'a> {
    Text(&'a str),
    Num(&'a str),
}

/// Splits a line into text and standalone numbers. A digit run only counts as a number when it is
/// not glued to letters or underscores (so `sda1`, `v2` and hex ids stay literal) and fits in an i64.
fn tokenize(line: &str) -> Vec<Tok<'_>> {
    let b = line.as_bytes();
    let mut toks = Vec::new();
    let mut text_start = 0;
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let glued = |c: u8| c.is_ascii_alphabetic() || c == b'_';
        let before = start > 0 && glued(b[start - 1]);
        let after = i < b.len() && glued(b[i]);
        if !before && !after && i - start <= 18 {
            toks.push(Tok::Text(&line[text_start..start]));
            toks.push(Tok::Num(&line[start..i]));
            text_start = i;
        }
    }
    toks.push(Tok::Text(&line[text_start..]));
    toks
}

fn shape_key(toks: &[Tok]) -> String {
    let mut k = String::new();
    for t in toks {
        match t {
            Tok::Text(s) => k.push_str(s),
            Tok::Num(_) => k.push('\u{1}'),
        }
    }
    k
}

struct Slot {
    min: i64,
    max: i64,
    min_s: String,
    max_s: String,
    prev: i64,
    step: Option<i64>,
    uniform: bool,
    seen: u64,
}

struct Run {
    key: String,
    first: usize,
    count: usize,
    texts: Vec<String>,
    slots: Vec<Slot>,
}

impl Run {
    fn new(i: usize, key: String, toks: &[Tok]) -> Run {
        let mut run = Run { key, first: i, count: 0, texts: Vec::new(), slots: Vec::new() };
        for t in toks {
            match t {
                Tok::Text(s) => run.texts.push((*s).to_string()),
                Tok::Num(n) => {
                    let v: i64 = n.parse().unwrap_or(0);
                    run.slots.push(Slot { min: v, max: v, min_s: (*n).into(), max_s: (*n).into(), prev: v, step: None, uniform: true, seen: 0 });
                }
            }
        }
        run
    }

    fn add(&mut self, toks: &[Tok]) {
        self.count += 1;
        let mut si = 0;
        for t in toks {
            if let Tok::Num(n) = t {
                let v: i64 = n.parse().unwrap_or(0);
                let s = &mut self.slots[si];
                if s.seen > 0 {
                    let d = v - s.prev;
                    match s.step {
                        None if s.seen == 1 => s.step = Some(d),
                        Some(prev_d) if prev_d == d => {}
                        _ => s.uniform = false,
                    }
                    if v < s.min {
                        s.min = v;
                        s.min_s = (*n).into();
                    }
                    if v > s.max {
                        s.max = v;
                        s.max_s = (*n).into();
                    }
                }
                s.prev = v;
                s.seen += 1;
                si += 1;
            }
        }
    }

    fn summary(&self) -> Option<String> {
        if self.slots.iter().all(|s| s.min == s.max) {
            return None;
        }
        let mut out = String::new();
        for (i, text) in self.texts.iter().enumerate() {
            out.push_str(text);
            if let Some(s) = self.slots.get(i) {
                if s.min == s.max {
                    out.push_str(&s.min_s);
                } else if let (true, Some(d)) = (s.uniform, s.step) {
                    out.push_str(&format!("⟨{}…{}, {:+}⟩", s.min_s, s.max_s, d));
                } else {
                    out.push_str(&format!("⟨{}…{}⟩", s.min_s, s.max_s));
                }
            }
        }
        Some(out)
    }
}


const MAX_VARS: usize = 3;
const MAX_VALUES: usize = 6;

/// The distinct values seen at one varying word position of a run of similar lines.
struct Field {
    vals: Vec<(String, u64)>,
    other: u64,
    all_num: bool,
    min: Option<(i64, String)>,
    max: Option<(i64, String)>,
}

impl Field {
    fn new(value: &str, n: u64) -> Field {
        let mut f = Field { vals: Vec::new(), other: 0, all_num: true, min: None, max: None };
        f.add(value, n);
        f
    }

    fn add(&mut self, v: &str, n: u64) {
        match v.parse::<i64>() {
            Ok(x) if v.len() <= 18 => {
                if self.min.as_ref().map_or(true, |m| x < m.0) {
                    self.min = Some((x, v.to_string()));
                }
                if self.max.as_ref().map_or(true, |m| x > m.0) {
                    self.max = Some((x, v.to_string()));
                }
            }
            _ => self.all_num = false,
        }
        if let Some(e) = self.vals.iter_mut().find(|e| e.0 == v) {
            e.1 += n;
        } else if self.vals.len() < MAX_VALUES {
            self.vals.push((v.to_string(), n));
        } else {
            self.other += n;
        }
    }

    fn render(&self) -> String {
        if self.other == 0 {
            let parts: Vec<String> = self.vals.iter().map(|(v, n)| format!("{v} ×{n}")).collect();
            format!("⟨{}⟩", parts.join(", "))
        } else if let (true, Some(lo), Some(hi)) = (self.all_num, &self.min, &self.max) {
            format!("⟨{}…{}⟩", lo.1, hi.1)
        } else {
            let parts: Vec<String> = self.vals.iter().take(4).map(|(v, n)| format!("{v} ×{n}")).collect();
            format!("⟨{}, +{} more lines⟩", parts.join(", "), self.other + self.vals.iter().skip(4).map(|v| v.1).sum::<u64>())
        }
    }
}

/// A run of consecutive lines with the same word count that differ in at most MAX_VARS positions.
struct FieldRun {
    first: usize,
    count: usize,
    base: Vec<String>,
    fields: Vec<Option<Field>>,
}

impl FieldRun {
    fn new(first: usize, toks: Vec<String>) -> FieldRun {
        let fields = (0..toks.len()).map(|_| None).collect();
        FieldRun { first, count: 1, base: toks, fields }
    }

    fn try_add(&mut self, toks: &[String]) -> bool {
        let len = self.base.len();
        if toks.len() != len {
            return false;
        }
        let new_vars: Vec<usize> = (0..len).filter(|&i| self.fields[i].is_none() && toks[i] != self.base[i]).collect();
        let vars = self.fields.iter().filter(|f| f.is_some()).count() + new_vars.len();
        let constants = len - vars;
        if vars > MAX_VARS || constants == 0 || constants * 2 < len {
            return false;
        }
        for i in new_vars {
            self.fields[i] = Some(Field::new(&self.base[i], self.count as u64));
        }
        for (i, f) in self.fields.iter_mut().enumerate() {
            if let Some(f) = f {
                f.add(&toks[i], 1);
            }
        }
        self.count += 1;
        true
    }

    fn summary(&self) -> Option<String> {
        if self.fields.iter().all(|f| f.is_none()) {
            return None;
        }
        let parts: Vec<String> = self
            .base
            .iter()
            .zip(&self.fields)
            .map(|(b, f)| f.as_ref().map_or_else(|| b.clone(), |f| f.render()))
            .collect();
        Some(parts.join(" "))
    }
}

fn group_fields(a: &Analysis) -> Result<Vec<Group>, String> {
    let total = a.starts.len();
    let mut groups = Vec::new();
    let mut run: Option<FieldRun> = None;
    let mut from = 0;
    while from < total {
        let to = (from + 20_000).min(total);
        for (k, line) in a.read(from, to)?.into_iter().enumerate() {
            let toks: Vec<String> = line.split(' ').map(String::from).collect();
            if let Some(r) = run.as_mut() {
                if r.try_add(&toks) {
                    continue;
                }
            }
            if let Some(r) = run.take() {
                if r.count >= 2 {
                    groups.push(Group { first: r.first as u64, count: r.count as u64, summary: r.summary() });
                }
            }
            run = Some(FieldRun::new(from + k, toks));
        }
        from = to;
    }
    if let Some(r) = run.take() {
        if r.count >= 2 {
            groups.push(Group { first: r.first as u64, count: r.count as u64, summary: r.summary() });
        }
    }
    Ok(groups)
}

/// Longest block of lines that block folding looks for.
const MAX_BLOCK: usize = 12;

/// Finds runs where a block of 2..=MAX_BLOCK lines repeats back to back at least twice, given one
/// hash per line. Returns (first line, block length, repeats). Runs of identical neighbouring
/// lines (block length 1) are left to the other folding modes.
fn block_repeats(h: &[u64]) -> Vec<(usize, usize, usize)> {
    let n = h.len();
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        let mut best: Option<(usize, usize)> = None;
        for p in 2..=MAX_BLOCK {
            if i + 2 * p > n {
                break;
            }
            if (1..p).all(|j| h[i + j] == h[i]) {
                continue;
            }
            let mut r = 1;
            while i + (r + 1) * p <= n && (0..p).all(|j| h[i + r * p + j] == h[i + j]) {
                r += 1;
            }
            if r >= 2 && best.map_or(true, |(bp, br)| r * p > br * bp) {
                best = Some((p, r));
            }
        }
        if let Some((p, r)) = best {
            out.push((i, p, r));
            i += p * r;
        } else {
            i += 1;
        }
    }
    out
}

/// Folds repeated multi-line blocks (e.g. the same stack trace or record over and over).
/// With `numbers`, lines that differ only in standalone numbers count as equal.
fn group_blocks(a: &Analysis, numbers: bool) -> Result<Vec<Group>, String> {
    let total = a.starts.len();
    let mut h: Vec<u64> = Vec::with_capacity(total);
    let mut from = 0;
    while from < total {
        let to = (from + 20_000).min(total);
        for line in a.read(from, to)? {
            let mut s = DefaultHasher::new();
            if numbers {
                pattern_of(&line).hash(&mut s);
            } else {
                line.hash(&mut s);
            }
            h.push(s.finish());
        }
        from = to;
    }
    let mut groups = Vec::new();
    for (first, p, r) in block_repeats(&h) {
        let head = a.read(first, first + 1)?.into_iter().next().unwrap_or_default();
        let head: String = head.chars().take(80).collect();
        groups.push(Group { first: first as u64, count: (p * r) as u64, summary: Some(format!("⟲ {p}-line block × {r}: {head} …")) });
    }
    Ok(groups)
}

#[derive(Serialize)]
struct Pattern {
    template: String,
    count: u64,
    first: u64,
    last: u64,
}

/// A line with its standalone numbers replaced by `#`; lines with the same result share a pattern.
fn pattern_of(line: &str) -> String {
    shape_key(&tokenize(line)).replace('\u{1}', "#")
}

/// Groups every line of the output by pattern (not just neighbours), most frequent first.
#[tauri::command]
async fn analyze_patterns(state: State<'_, AppState>) -> Result<Vec<Pattern>, String> {
    let a = current_analysis(&state)?;
    let total = a.starts.len();
    let mut map: HashMap<String, (u64, u64, u64)> = HashMap::new();
    let mut from = 0;
    while from < total {
        let to = (from + 20_000).min(total);
        for (k, line) in a.read(from, to)?.iter().enumerate() {
            let key = pattern_of(line);
            let i = (from + k) as u64;
            if let Some(e) = map.get_mut(&key) {
                e.0 += 1;
                e.2 = i;
            } else if map.len() < 200_000 {
                map.insert(key, (1, i, i));
            }
        }
        from = to;
    }
    let mut v: Vec<Pattern> = map
        .into_iter()
        .map(|(template, (count, first, last))| Pattern { template, count, first, last })
        .collect();
    v.sort_by(|a, b| b.count.cmp(&a.count).then(a.first.cmp(&b.first)));
    v.truncate(1000);
    Ok(v)
}

/// Line numbers (0-based) belonging to one pattern, capped at 200k.
#[tauri::command]
async fn analyze_pattern_lines(state: State<'_, AppState>, template: String) -> Result<Vec<u64>, String> {
    let a = current_analysis(&state)?;
    let total = a.starts.len();
    let mut hits = Vec::new();
    let mut from = 0;
    while from < total && hits.len() < 200_000 {
        let to = (from + 20_000).min(total);
        for (k, line) in a.read(from, to)?.iter().enumerate() {
            if pattern_of(line) == template {
                hits.push((from + k) as u64);
            }
        }
        from = to;
    }
    Ok(hits)
}

/// Finds runs of consecutive lines to fold. `mode` is "exact" (identical lines) or "numbers"
/// (lines identical except for standalone numbers). Returns runs of 2 or more lines.
#[tauri::command]
async fn analyze_groups(state: State<'_, AppState>, mode: String) -> Result<Vec<Group>, String> {
    let a = current_analysis(&state)?;
    if mode == "fields" {
        return group_fields(&a);
    }
    if mode == "blocks" || mode == "blocks-numbers" {
        return group_blocks(&a, mode == "blocks-numbers");
    }
    let numbers = mode == "numbers";
    let total = a.starts.len();
    let mut groups = Vec::new();
    let mut run: Option<Run> = None;
    let mut from = 0;

    let mut close = |run: &mut Option<Run>| {
        if let Some(r) = run.take() {
            if r.count >= 2 {
                groups.push(Group { first: r.first as u64, count: r.count as u64, summary: r.summary() });
            }
        }
    };

    while from < total {
        let to = (from + 20_000).min(total);
        for (k, line) in a.read(from, to)?.into_iter().enumerate() {
            let i = from + k;
            let toks = if numbers { tokenize(&line) } else { vec![Tok::Text(&line)] };
            let key = shape_key(&toks);
            if run.as_ref().map_or(false, |r| r.key == key) {
                run.as_mut().unwrap().add(&toks);
            } else {
                close(&mut run);
                let mut r = Run::new(i, key, &toks);
                r.add(&toks);
                run = Some(r);
            }
        }
        from = to;
    }
    close(&mut run);
    Ok(groups)
}

/// True when `hay` (already lower case) contains `word` (lower case) as a whole word.
fn has_word(hay: &str, word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let mut from = 0;
    while let Some(p) = hay[from..].find(word) {
        let s = from + p;
        let e = s + word.len();
        let before_ok = hay[..s].chars().next_back().map_or(true, |c| !is_word(c));
        let after_ok = hay[e..].chars().next().map_or(true, |c| !is_word(c));
        if before_ok && after_ok {
            return true;
        }
        from = s + hay[s..].chars().next().map_or(1, |c| c.len_utf8());
    }
    false
}

#[derive(Serialize)]
struct Severity {
    /// 0-based lines containing one of the error words, capped at 200k.
    err: Vec<u64>,
    /// Lines with a warning word but no error word, capped at 200k.
    warn: Vec<u64>,
}

/// Finds the lines that contain an error word or a warning word (whole words, any case).
#[tauri::command]
async fn analyze_severity(state: State<'_, AppState>, err: Vec<String>, warn: Vec<String>) -> Result<Severity, String> {
    let a = current_analysis(&state)?;
    let lower = |v: Vec<String>| -> Vec<String> { v.into_iter().map(|w| w.trim().to_lowercase()).filter(|w| !w.is_empty()).collect() };
    let (err, warn) = (lower(err), lower(warn));
    let (mut e_hits, mut w_hits) = (Vec::new(), Vec::new());
    let total = a.starts.len();
    let mut from = 0;
    while from < total {
        let to = (from + 20_000).min(total);
        for (k, line) in a.read(from, to)?.iter().enumerate() {
            let low = line.to_lowercase();
            let i = (from + k) as u64;
            if e_hits.len() < 200_000 && err.iter().any(|w| has_word(&low, w)) {
                e_hits.push(i);
            } else if w_hits.len() < 200_000 && warn.iter().any(|w| has_word(&low, w)) {
                w_hits.push(i);
            }
        }
        from = to;
    }
    Ok(Severity { err: e_hits, warn: w_hits })
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

/// What the command line asks for: `digterm file.log`, or `some-command | digterm -` for piped input.
#[derive(Debug, PartialEq)]
enum Startup {
    Nothing,
    File(String),
    Stdin,
}

fn parse_startup(args: &[String]) -> Startup {
    // flags (the windowing system may add some) are ignored; `-` alone means "read standard input"
    match args.iter().find(|a| a.as_str() == "-" || !a.starts_with('-')) {
        Some(a) if a == "-" => Startup::Stdin,
        Some(a) => Startup::File(a.clone()),
        None => Startup::Nothing,
    }
}

/// File the viewer should open when the app starts (a file argument, or piped input saved to a temp file).
static STARTUP: OnceLock<PathBuf> = OnceLock::new();

/// Handles the command line before the window opens. Piped input is read to its end first, so the
/// window appears when the producing command has finished.
fn resolve_startup() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = match parse_startup(&args) {
        Startup::Nothing => return,
        Startup::File(f) => {
            let p = PathBuf::from(&f);
            if !p.is_file() {
                eprintln!("digterm: {f} is not a file");
                return;
            }
            fs::canonicalize(&p).unwrap_or(p)
        }
        Startup::Stdin => {
            let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let p = std::env::temp_dir().join(format!("digterm-pipe-{ts}-{}.txt", std::process::id()));
            let Ok(mut f) = File::create(&p) else { return };
            // the viewer can open up to 1 GiB, so that is all that is kept
            let n = std::io::copy(&mut std::io::stdin().lock().take(1 << 30), &mut f).unwrap_or(0);
            if n == 0 {
                let _ = fs::remove_file(&p);
                eprintln!("digterm: nothing was piped in");
                return;
            }
            p
        }
    };
    let _ = STARTUP.set(path);
}

/// The file given on the command line (or the piped input), for the viewer to open at start.
#[tauri::command]
fn startup_open() -> Option<String> {
    STARTUP.get().map(|p| p.to_string_lossy().into_owned())
}

fn main() {
    resolve_startup();
    // WebKitGTK can leave ghost copies of the page while the window is dragged or resized under
    // native Wayland (seen on Fedora). Running through XWayland and disabling its GPU compositing
    // avoids that. Any value you set yourself (for example GDK_BACKEND=wayland) is respected.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        for var in ["WEBKIT_DISABLE_DMABUF_RENDERER", "WEBKIT_DISABLE_COMPOSITING_MODE"] {
            if std::env::var_os(var).is_none() {
                std::env::set_var(var, "1");
            }
        }
    }
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![startup_open, pty_spawn, pty_write, pty_resize, pty_close, pty_cwd, path_info, open_path, open_url, open_mailto, system_info, session_len, home_dir, save_layout, load_layout, runs_usage, cleanup_runs, list_runs, scan_run, analyze_open_run, analyze_open_ranges, analyze_severity, read_block, analyze_open, analyze_open_text, analyze_open_file, analyze_lines, analyze_lengths, analyze_groups, analyze_patterns, analyze_pattern_lines, analyze_search])
        .run(tauri::generate_context!())
        .expect("error while running Digterm");
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &[u8] = b"\x1b]133;A\x07";
    const B: &[u8] = b"\x1b]133;B\x07";
    const C: &[u8] = b"\x1b]133;C\x07";

    fn cat(parts: &[&[u8]]) -> Vec<u8> {
        parts.concat()
    }

    fn d(code: &str) -> Vec<u8> {
        format!("\x1b]133;D;{code}\x07").into_bytes()
    }

    /// One command as the shell integration prints it: prompt, typed text, output, finish marker.
    fn command(typed: &str, output: &str, code: &str) -> Vec<u8> {
        cat(&[A, b"$ ", B, typed.as_bytes(), b"\r\n", C, output.as_bytes(), &d(code)])
    }

    type Row = (u32, u64, u64, u64, u64, u64, Option<i32>);

    fn scan(data: &[u8], chunk: usize) -> Vec<Row> {
        let mut sc = Scanner::new();
        let mut out = Vec::new();
        let mut base = 0u64;
        for part in data.chunks(chunk) {
            sc.feed(part, base, &mut |b| out.push((b.id, b.cmd_start, b.start, b.end, b.lines, 0, b.exit)));
            base += part.len() as u64;
        }
        out
    }

    #[test]
    fn scanner_finds_one_command() {
        let data = command("ls", "a\nb\n", "0");
        let rows = scan(&data, data.len());
        assert_eq!(rows.len(), 1);
        let (id, cmd_start, start, end, lines, _, exit) = rows[0];
        assert_eq!(id, 1);
        assert_eq!(exit, Some(0));
        assert_eq!(lines, 2);
        assert_eq!(&data[start as usize..end as usize], b"a\nb\n");
        assert_eq!(&data[cmd_start as usize..start as usize - C.len()], b"ls\r\n");
    }

    #[test]
    fn scanner_numbers_commands_and_keeps_exit_codes() {
        let data = [command("true", "", "0"), command("false", "boom\n", "1"), command("x", "", "130")].concat();
        let rows = scan(&data, data.len());
        let ids: Vec<u32> = rows.iter().map(|r| r.0).collect();
        let exits: Vec<Option<i32>> = rows.iter().map(|r| r.6).collect();
        assert_eq!(ids, vec![1, 2, 3]);
        assert_eq!(exits, vec![Some(0), Some(1), Some(130)]);
        assert_eq!(rows[0].4, 0);
        assert_eq!(rows[1].4, 1);
    }

    #[test]
    fn scanner_gives_same_result_for_any_chunk_size() {
        let data = [command("echo hi", "hi\n", "0"), command("seq 3", "1\n2\n3\n", "0")].concat();
        let whole = scan(&data, data.len());
        for size in [1, 2, 3, 5, 7, 64] {
            assert_eq!(scan(&data, size), whole, "chunk size {size}");
        }
    }

    #[test]
    fn scanner_accepts_string_terminator_and_missing_exit() {
        let data = cat(&[A, B, b"x\r\n", C, b"out\n", b"\x1b]133;D;7\x1b\\", A, B, b"y\r\n", C, b"\x1b]133;D\x07"]);
        let rows = scan(&data, data.len());
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].6, Some(7));
        assert_eq!(&data[rows[0].2 as usize..rows[0].3 as usize], b"out\n");
        assert_eq!(rows[1].6, None);
    }

    #[test]
    fn scanner_ignores_output_without_a_finished_command() {
        let data = cat(&[A, B, b"sleep 100\r\n", C, b"partial\n"]);
        assert!(scan(&data, data.len()).is_empty());
        // a finish marker with no start marker emits nothing and does not panic
        assert!(scan(&d("0"), 1).is_empty());
    }

    #[test]
    fn scanner_ignores_other_escape_sequences() {
        let data = cat(&[A, B, b"ls\r\n", C, b"\x1b[31mred\x1b[0m\n", b"\x1b]0;title\x07", &d("0")]);
        let rows = scan(&data, 3);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].4, 1);
        assert_eq!(rows[0].6, Some(0));
    }

    #[test]
    fn strip_ansi_removes_colors_and_titles() {
        assert_eq!(strip_ansi(b"\x1b[1;31mred\x1b[0m text"), "red text");
        assert_eq!(strip_ansi(b"\x1b]0;title\x07x"), "x");
        assert_eq!(strip_ansi(b"\x1b]0;title\x1b\\x"), "x");
        assert_eq!(strip_ansi(b"\x1b]133;A\x07$ "), "$ ");
    }

    #[test]
    fn strip_ansi_keeps_final_text_of_carriage_return_rewrites() {
        assert_eq!(strip_ansi(b"10%\r50%\r100%\nnext"), "100%\nnext");
        assert_eq!(strip_ansi(b"a\r\nb\r\n"), "a\nb\n");
    }

    #[test]
    fn strip_ansi_survives_truncated_input() {
        assert_eq!(strip_ansi(b"ab\x1b"), "ab");
        assert_eq!(strip_ansi(b"ab\x1b["), "ab");
        assert_eq!(strip_ansi(b"ab\x1b]0;never ends"), "ab");
        assert_eq!(strip_ansi(b""), "");
        assert!(strip_ansi(b"ok \xff\xfe").starts_with("ok "));
    }

    fn toks(line: &str) -> Vec<(bool, String)> {
        tokenize(line)
            .iter()
            .map(|t| match t {
                Tok::Text(s) => (false, s.to_string()),
                Tok::Num(s) => (true, s.to_string()),
            })
            .collect()
    }

    fn nums(line: &str) -> Vec<String> {
        toks(line).into_iter().filter(|t| t.0).map(|t| t.1).collect()
    }

    #[test]
    fn tokenize_splits_standalone_numbers() {
        assert_eq!(
            toks("item 12 of 40"),
            vec![
                (false, "item ".to_string()),
                (true, "12".to_string()),
                (false, " of ".to_string()),
                (true, "40".to_string()),
                (false, String::new())
            ]
        );
        assert_eq!(nums("5"), vec!["5"]);
        assert_eq!(nums("no digits here"), Vec::<String>::new());
    }

    #[test]
    fn tokenize_keeps_digits_glued_to_letters_literal() {
        assert!(nums("/dev/sda1").is_empty());
        assert!(nums("v2 build").is_empty());
        assert!(nums("a_1 b_22").is_empty());
        assert!(nums("0xdeadbeef 3f").is_empty());
        assert_eq!(nums("sda1 42"), vec!["42"]);
    }

    #[test]
    fn tokenize_limits_number_length_and_handles_unicode() {
        assert_eq!(nums("n 123456789012345678 x"), vec!["123456789012345678"]); // 18 digits
        assert!(nums("n 1234567890123456789 x").is_empty()); // 19 digits would not fit an i64 safely
        assert_eq!(nums("größe 7 äö 8"), vec!["7", "8"]);
    }

    #[test]
    fn pattern_of_replaces_numbers() {
        assert_eq!(pattern_of("item 12 of 40"), "item # of #");
        assert_eq!(pattern_of("item 13 of 40"), pattern_of("item 12 of 40"));
        assert_ne!(pattern_of("sda1"), pattern_of("sda2"));
    }

    /// Runs `f` on an Analysis built from `text` (a real temp file, as in the app).
    fn with_analysis<T>(text: &str, f: impl FnOnce(&Analysis) -> T) -> T {
        static N: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!("digterm-test-{}-{}.txt", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        fs::write(&path, text).unwrap();
        let len = text.len() as u64;
        let starts = index_file(&path, 0, len).unwrap();
        let a = Analysis { path: path.clone(), starts, end: len, ends: None };
        let out = f(&a);
        let _ = fs::remove_file(&path);
        out
    }

    fn groups_of(text: &str) -> Vec<(u64, u64, Option<String>)> {
        with_analysis(text, |a| group_fields(a).unwrap().into_iter().map(|g| (g.first, g.count, g.summary)).collect())
    }

    #[test]
    fn group_fields_folds_lines_that_differ_in_one_word() {
        let g = groups_of("user alice logged in\nuser bob logged in\nuser carol logged in\nsomething else entirely now\n");
        assert_eq!(g.len(), 1);
        assert_eq!((g[0].0, g[0].1), (0, 3));
        let s = g[0].2.clone().expect("a summary for lines with a varying word");
        assert!(s.starts_with("user "), "{s}");
        assert!(s.ends_with(" logged in"), "{s}");
    }

    #[test]
    fn group_fields_reports_exact_repeats_without_summary() {
        let g = groups_of("same line\nsame line\nother\n");
        assert_eq!(g, vec![(0, 2, None)]);
    }

    #[test]
    fn group_fields_does_not_group_unrelated_lines() {
        assert!(groups_of("a b\nc d\ne f\n").is_empty());
        assert!(groups_of("one two three\nonly two\n").is_empty());
        assert!(groups_of("").is_empty());
    }

    #[test]
    fn block_repeats_finds_back_to_back_blocks() {
        // x [A B A B] y  -> block of 2, twice, starting at line 1
        assert_eq!(block_repeats(&[9, 1, 2, 1, 2, 8]), vec![(1, 2, 2)]);
        // A B C D A B C D -> one block of 4 rather than two blocks of 2
        assert_eq!(block_repeats(&[1, 2, 3, 4, 1, 2, 3, 4]), vec![(0, 4, 2)]);
        // A B A B A B -> 3 repeats of 2
        assert_eq!(block_repeats(&[1, 2, 1, 2, 1, 2]), vec![(0, 2, 3)]);
    }

    #[test]
    fn block_repeats_ignores_single_line_repeats_and_unique_lines() {
        assert!(block_repeats(&[1, 1, 1, 1]).is_empty());
        assert!(block_repeats(&[1, 2, 3, 4, 5]).is_empty());
        assert!(block_repeats(&[]).is_empty());
    }

    #[test]
    fn group_blocks_folds_repeated_blocks_and_can_ignore_numbers() {
        let text = "start\nGET /a 200\ndone 1\nGET /a 200\ndone 2\nend\n";
        let exact = with_analysis(text, |a| group_blocks(a, false).unwrap().len());
        assert_eq!(exact, 0);
        let g = with_analysis(text, |a| group_blocks(a, true).unwrap());
        assert_eq!(g.len(), 1);
        assert_eq!((g[0].first, g[0].count), (1, 4));
        assert!(g[0].summary.as_deref().unwrap().starts_with("⟲ 2-line block × 2: GET /a 200"));
    }

    #[test]
    fn system_info_parsers_read_linux_files() {
        assert_eq!(os_release_name("NAME=Fedora\nPRETTY_NAME=\"Fedora Linux 44 (Workstation)\"\n").as_deref(), Some("Fedora Linux 44 (Workstation)"));
        assert_eq!(cpu_model("processor\t: 0\nmodel name\t: AMD Ryzen 7 5800X 8-Core Processor\n").as_deref(), Some("AMD Ryzen 7 5800X 8-Core Processor"));
        assert_eq!(mem_total("MemTotal:       16777216 kB\nMemFree: 1 kB\n").as_deref(), Some("16.0 GB"));
        let lspci = "00:00.0 Host bridge: Intel Corp\n01:00.0 VGA compatible controller: NVIDIA Corporation GA104 [GeForce RTX 3070] (rev a1)\n";
        assert_eq!(gpu_names(lspci), vec!["NVIDIA Corporation GA104 [GeForce RTX 3070]".to_string()]);
        assert!(gpu_names("").is_empty());
        assert_eq!(cpu_model("nothing"), None);
    }

    #[test]
    fn has_word_matches_whole_words_only() {
        assert!(has_word("build failed: x", "failed"));
        assert!(has_word("error", "error"));
        assert!(has_word("an error.", "error"));
        assert!(!has_word("errors found", "error"));
        assert!(!has_word("no_error_here", "error"));
        assert!(!has_word("terror", "error"));
        assert!(has_word("terror and error", "error"));
        assert!(has_word("segmentation fault (core dumped)", "core dumped"));
        assert!(!has_word("anything", ""));
        assert!(has_word("fehler: größe fehler", "fehler"));
    }

    #[test]
    fn looks_like_text_tells_text_from_binary() {
        let dir = std::env::temp_dir();
        let t = dir.join(format!("digterm-test-text-{}.txt", std::process::id()));
        let b = dir.join(format!("digterm-test-bin-{}.bin", std::process::id()));
        fs::write(&t, "hello\nwörld\n").unwrap();
        fs::write(&b, [0x89u8, b'P', b'N', b'G', 0, 1, 2]).unwrap();
        assert!(looks_like_text(&t));
        assert!(!looks_like_text(&b));
        assert!(!looks_like_text(&dir.join("digterm-does-not-exist")));
        let _ = fs::remove_file(&t);
        let _ = fs::remove_file(&b);
    }

    #[test]
    fn path_info_classifies_names() {
        let base = std::env::temp_dir().join(format!("digterm-test-paths-{}", std::process::id()));
        fs::create_dir_all(base.join("sub")).unwrap();
        fs::write(base.join("a.log"), "x\n").unwrap();
        fs::write(base.join("p.bin"), [0u8, 1, 2]).unwrap();
        let cwd = Some(base.to_string_lossy().into_owned());
        let names: Vec<String> = ["sub", "a.log", "p.bin", "nope"].iter().map(|s| s.to_string()).collect();
        let kinds: Vec<&str> = path_info(cwd.clone(), names).iter().map(|i| i.kind).collect();
        assert_eq!(kinds, vec!["dir", "text", "file", ""]);
        assert!(path_info(None, vec!["relative".into()])[0].kind.is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn parse_startup_reads_the_command_line() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(parse_startup(&a(&[])), Startup::Nothing);
        assert_eq!(parse_startup(&a(&["-"])), Startup::Stdin);
        assert_eq!(parse_startup(&a(&["build.log"])), Startup::File("build.log".into()));
        assert_eq!(parse_startup(&a(&["--gtk-flag", "x.log"])), Startup::File("x.log".into()));
        assert_eq!(parse_startup(&a(&["--gtk-flag"])), Startup::Nothing);
        assert_eq!(parse_startup(&a(&["-psn_0_1234"])), Startup::Nothing);
    }

    #[test]
    fn analysis_reads_contiguous_lines() {
        with_analysis("one\ntwo\nthree", |a| {
            assert_eq!(a.starts.len(), 3);
            assert_eq!(a.read(0, 3).unwrap(), vec!["one", "two", "three"]);
            assert_eq!(a.read(1, 2).unwrap(), vec!["two"]);
            assert_eq!(a.read(2, 99).unwrap(), vec!["three"]);
            assert!(a.read(3, 3).unwrap().is_empty());
        });
    }

    #[test]
    fn analysis_reads_lines_from_separate_ranges() {
        // "AAA\n" and "BBB\n" with a prompt and typed command between them that must not appear
        with_analysis("AAA\n$ ls\nBBB\n", |a| {
            let gapped = Analysis { path: a.path.clone(), starts: vec![0, 9], end: 13, ends: Some(vec![4, 13]) };
            assert_eq!(gapped.read(0, 2).unwrap(), vec!["AAA", "BBB"]);
            assert_eq!(gapped.read(1, 2).unwrap(), vec!["BBB"]);
        });
    }
}
