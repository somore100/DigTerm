#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, File},
    io::{Read, Write},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{ipc::{Channel, InvokeResponseBody}, AppHandle, Emitter, Manager, State};

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
}

#[derive(Default)]
struct AppState {
    session: Mutex<Option<Session>>,
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

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("runs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let path = dir.join(format!("run-{ts}.raw"));
    let mut file = File::create(&path).map_err(|e| e.to_string())?;

    *state.session.lock().unwrap() = Some(Session { writer, master: pair.master });

    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut lines: u64 = 0;
        let mut last_emit = Instant::now();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    let _ = file.write_all(chunk);
                    lines += chunk.iter().filter(|&&b| b == b'\n').count() as u64;
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

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize])
        .run(tauri::generate_context!())
        .expect("error while running Digterm");
}
