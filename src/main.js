import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openAnalyze } from "./analyze.js";

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

// Font zoom: Ctrl +/-/0 and Ctrl+wheel, remembered between runs
const TERM_FONT = 14;
function setTermFont(px) {
  term.options.fontSize = Math.min(32, Math.max(8, px));
  try { localStorage.setItem("digterm.termfont", String(term.options.fontSize)); } catch {}
  fit.fit();
}
try {
  const saved = Number(localStorage.getItem("digterm.termfont"));
  if (saved) { term.options.fontSize = saved; fit.fit(); }
} catch {}
document.getElementById("terminal").addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setTermFont(term.options.fontSize + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });

term.attachCustomKeyEventHandler((e) => {
  if (e.type !== "keydown" || !e.ctrlKey) return true;
  // Ctrl+Shift+C copies the terminal selection (plain Ctrl+C still goes to the shell as SIGINT)
  if (e.shiftKey && e.code === "KeyC") {
    const text = term.getSelection();
    if (text) navigator.clipboard.writeText(text);
    return false;
  }
  if (!e.shiftKey && (e.key === "=" || e.key === "+")) { setTermFont(term.options.fontSize + 1); return false; }
  if (!e.shiftKey && e.key === "-") { setTermFont(term.options.fontSize - 1); return false; }
  if (!e.shiftKey && e.key === "0") { setTermFont(TERM_FONT); return false; }
  return true;
});

const linesEl = document.getElementById("lines");
const runFileEl = document.getElementById("runfile");

await listen("pty-lines", (e) => {
  linesEl.textContent = `${e.payload.toLocaleString()} lines captured`;
});
const blockList = document.getElementById("block-list");
await listen("pty-block", (e) => {
  const b = e.payload;
  const li = document.createElement("li");
  const label = document.createElement("span");
  label.className = b.exit === 0 ? "ok" : "fail";
  label.textContent = `#${b.id} · ${b.lines.toLocaleString()} lines · exit ${b.exit ?? "?"}`;
  const copy = document.createElement("button");
  copy.textContent = "Copy";
  copy.onclick = async () => {
    const text = await invoke("read_block", { start: b.start, end: b.end });
    await navigator.clipboard.writeText(text);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1200);
  };
  const analyze = document.createElement("button");
  analyze.textContent = "Analyze";
  analyze.onclick = () => openAnalyze(b);
  const buttons = document.createElement("span");
  buttons.append(analyze, copy);
  li.append(label, buttons);
  blockList.prepend(li);
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
