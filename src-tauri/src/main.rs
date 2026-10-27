#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicU32, Ordering}, Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{ipc::{Channel, InvokeResponseBody}, AppHandle, Emitter, Manager, State};

struct Session {
    writer: Box<dyn Write + Send>,
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
    session: u32,
    id: u32,
    /// Where the typed command begins (after the prompt); `start..end` is the output alone.
    cmd_start: u64,
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
    cur: Option<(u32, u64, u64, u64)>, // id, output start, lines, command start
    b_pos: Option<u64>,
    next_id: u32,
}

impl Scanner {
    fn new() -> Self {
        Scanner { st: St::Normal, esc_pos: 0, osc: Vec::new(), cur: None, b_pos: None, next_id: 1 }
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
                self.next_id += 1;
            }
            Some(b'D') => {
                if let Some((id, start, lines, cmd_start)) = self.cur.take() {
                    let exit = std::str::from_utf8(rest.get(2..).unwrap_or(&[]))
                        .ok()
                        .and_then(|s| s.parse().ok());
                    emit(Block { session: 0, id, cmd_start, start, end: self.esc_pos, lines, exit });
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
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let runs_dir = data_dir.join("runs");
    fs::create_dir_all(&runs_dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let path = runs_dir.join(format!("run-{ts}-{id}.raw"));
    let mut file = File::create(&path).map_err(|e| e.to_string())?;

    state.sessions.lock().unwrap().insert(
        id,
        Session { writer, master: pair.master, run_path: path.clone(), pid, killer },
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
    let mut guard = state.sessions.lock().unwrap();
    let session = guard.get_mut(&id).ok_or("no session")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
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

/// Builds the line index for a block and returns its line count.
#[tauri::command]
async fn analyze_open(state: State<'_, AppState>, session: u32, start: u64, end: u64) -> Result<u64, String> {
    if end < start {
        return Err("bad range".into());
    }
    let path = session_path(&state, session)?;
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
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, pty_close, pty_cwd, session_len, home_dir, save_layout, load_layout, read_block, analyze_open, analyze_lines, analyze_groups, analyze_patterns, analyze_pattern_lines, analyze_search])
        .run(tauri::generate_context!())
        .expect("error while running Digterm");
}
