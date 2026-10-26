import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const term = new Terminal({
  fontFamily: "monospace",
  fontSize: 14,
  scrollback: 5000, // full output is kept on disk by the backend, not here
  theme: { background: "#111418" },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal"));
fit.fit();

const linesEl = document.getElementById("lines");
const runFileEl = document.getElementById("runfile");

await listen("pty-lines", (e) => {
  linesEl.textContent = `${e.payload.toLocaleString()} lines captured`;
});
await listen("pty-exit", () => {
  term.write("\r\n[process exited]\r\n");
});

const onData = new Channel();
onData.onmessage = (msg) => {
  term.write(msg instanceof ArrayBuffer ? new Uint8Array(msg) : new Uint8Array(msg));
};

const runFile = await invoke("pty_spawn", { onData, rows: term.rows, cols: term.cols });
runFileEl.textContent = runFile;

term.onData((data) => invoke("pty_write", { data }));
term.onResize(({ rows, cols }) => invoke("pty_resize", { rows, cols }));
window.addEventListener("resize", () => fit.fit());
term.focus();
