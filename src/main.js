import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openAnalyze } from "./analyze.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- preferences

const FONT_DEFAULT = 14;
const PREF_DEFAULTS = {
  restoreDirs: true,
  font: FONT_DEFAULT,
  theme: "dark", // auto | light | dark
  tabTitle: "folder", // folder | short | full
  scrollback: 5000,
  commandsHidden: false,
  autoSize: false, // smaller text when there are more terminals in a tab
  copyMode: "output", // output | command
  splitByEntry: true, // Analyze opens one command (true) or the whole run (false)
  newestBottom: false, // Commands list: newest command at the bottom (list follows the bottom)
  cleanupDays: 0, // delete saved output older than this many days on start; 0 = never
  keys: {}, // action id -> combo overrides
};

function loadPrefs() {
  try {
    return { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem("digterm.prefs") || "{}") };
  } catch {
    return { ...PREF_DEFAULTS };
  }
}
function savePrefs() {
  try { localStorage.setItem("digterm.prefs", JSON.stringify(prefs)); } catch {}
}
const prefs = loadPrefs();

// ---------------------------------------------------------------- theme

const XTERM_THEMES = {
  dark: { background: "#111418" },
  light: {
    background: "#fbfbfc", foreground: "#1d2127", cursor: "#1d2127", cursorAccent: "#fbfbfc",
    selectionBackground: "#b7d3f5",
    black: "#1d2127", red: "#c01c28", green: "#26a269", yellow: "#a2734c", blue: "#1a5fb4",
    magenta: "#a347ba", cyan: "#2aa1b3", white: "#a5a8ad",
    brightBlack: "#5e6670", brightRed: "#e01b24", brightGreen: "#2ec27e", brightYellow: "#b5835a",
    brightBlue: "#3584e4", brightMagenta: "#c061cb", brightCyan: "#33b7c7", brightWhite: "#6e7681",
  },
};
const lightQuery = window.matchMedia("(prefers-color-scheme: light)");
const effectiveTheme = () => (prefs.theme === "auto" ? (lightQuery.matches ? "light" : "dark") : prefs.theme);

function applyTheme() {
  const t = effectiveTheme();
  document.documentElement.dataset.theme = t;
  for (const p of panes.values()) p.term.options.theme = XTERM_THEMES[t];
  // the window's own background shows briefly while resizing, before the page repaints
  getCurrentWindow().setBackgroundColor(t === "light" ? "#fbfbfc" : "#111418").catch(() => {});
}
lightQuery.addEventListener("change", () => { if (prefs.theme === "auto") applyTheme(); });

function setTheme(t) {
  prefs.theme = t;
  savePrefs();
  applyTheme();
}

// ---------------------------------------------------------------- state

const panes = new Map(); // session id -> Pane
const tabs = [];
let activeTab = null;
let activePane = null;
let HOME = "";

const basename = (p) => (p ? p.replace(/\/+$/, "").split("/").pop() || "/" : "");

function fmtPath(cwd, style) {
  if (!cwd) return "Terminal";
  let q = cwd;
  if (HOME && (q === HOME || q.startsWith(`${HOME}/`))) q = `~${q.slice(HOME.length)}`;
  if (style === "full") return q;
  if (style === "short") {
    const parts = q.split("/");
    return parts
      .map((s, i) => (i === parts.length - 1 || s === "" || s === "~" ? s : s[0] === "." ? s.slice(0, 2) : s[0]))
      .join("/") || "/";
  }
  return q === "~" ? "~" : basename(cwd);
}

// ---------------------------------------------------------------- panes

class Pane {
  constructor(tab, cwd, font) {
    this.tab = tab;
    this.font = font ?? prefs.font; // zoom is per terminal
    this.manual = font !== undefined; // true once zoomed by hand; auto sizing then leaves it alone
    this.id = null;
    this.cwd = cwd ?? null;
    this.lines = 0;
    this.blocks = []; // finished commands, in order
    this.runFile = "";

    this.el = document.createElement("div");
    this.el.className = "pane";
    this.termEl = document.createElement("div");
    this.termEl.className = "pane-term";
    const close = document.createElement("button");
    close.className = "pane-close";
    close.textContent = "✕";
    close.title = "Close pane";
    close.onclick = (e) => { e.stopPropagation(); closePane(this); };
    const zoomBtn = document.createElement("button");
    zoomBtn.className = "pane-zoom";
    zoomBtn.textContent = "⤢";
    zoomBtn.title = "Zoom this pane to fill the tab (Ctrl+Shift+Z)";
    zoomBtn.onclick = (e) => { e.stopPropagation(); toggleZoomPane(this); };
    this.el.append(this.termEl, zoomBtn, close);

    this.blocksEl = document.createElement("ul");
    this.blocksEl.className = "block-list";
    this.blocksEl.hidden = true;
    $("block-lists").append(this.blocksEl);

    tab.grid.append(this.el);
    tab.panes.push(this);
    layoutTab(tab);
    if (!this.manual) this.font = baseFontFor(tab);

    this.term = new Terminal({
      fontFamily: "monospace",
      fontSize: this.font,
      scrollback: prefs.scrollback, // full output is kept on disk by the backend, not here
      theme: XTERM_THEMES[effectiveTheme()],
    });
    this.fit = new FitAddon();
    this.search = new SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.open(this.termEl);
    this.fit.fit();
    this.buildFindBar();

    this.term.onData((data) => { if (this.id !== null) invoke("pty_write", { id: this.id, data }); });
    // debounced: the shell redraws its prompt on every size change, so only send the settled size
    this.term.onResize(({ rows, cols }) => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        if (this.id === null || (this.sent?.rows === rows && this.sent?.cols === cols)) return;
        this.sent = { rows, cols };
        invoke("pty_resize", { id: this.id, rows, cols });
      }, 150);
    });
    new ResizeObserver(() => { try { this.fit.fit(); } catch {} }).observe(this.termEl);
    this.termEl.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setPaneFont(this, this.font + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });
    this.el.addEventListener("mousedown", () => focusPane(this));
  }

  buildFindBar() {
    const bar = document.createElement("div");
    bar.className = "findbar";
    bar.hidden = true;
    const input = document.createElement("input");
    input.placeholder = "Find in terminal";
    const mk = (text, title) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.title = title;
      return b;
    };
    const prev = mk("▲", "Previous (Shift+Enter)");
    const next = mk("▼", "Next (Enter)");
    const caseBtn = mk("Aa", "Match case");
    const all = mk("All output", "Search this terminal's full saved output in the viewer");
    const x = mk("✕", "Close (Esc)");
    let matchCase = false;
    const opts = () => ({ caseSensitive: matchCase });
    input.addEventListener("input", () => this.search.findNext(input.value, opts()));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) this.search.findPrevious(input.value, opts());
        else this.search.findNext(input.value, opts());
      } else if (e.key === "Escape") {
        this.toggleFind(false);
      }
    });
    prev.onclick = () => this.search.findPrevious(input.value, opts());
    next.onclick = () => this.search.findNext(input.value, opts());
    caseBtn.onclick = () => { matchCase = !matchCase; caseBtn.classList.toggle("on", matchCase); this.search.findNext(input.value, opts()); };
    all.onclick = () => analyzeFull(this);
    x.onclick = () => this.toggleFind(false);
    bar.append(input, prev, next, caseBtn, all, x);
    this.el.append(bar);
    this.findBar = bar;
    this.findInput = input;
  }

  toggleFind(show = this.findBar.hidden) {
    this.findBar.hidden = !show;
    if (show) { this.findInput.focus(); this.findInput.select(); }
    else { this.search.clearDecorations?.(); this.term.focus(); }
  }

  async start() {
    // let the layout settle first, so the shell starts at its final size and doesn't redraw its prompt
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try { this.fit.fit(); } catch {}
    const onData = new Channel();
    onData.onmessage = (msg) => this.term.write(new Uint8Array(msg));
    this.sent = { rows: this.term.rows, cols: this.term.cols };
    const info = await invoke("pty_spawn", {
      onData,
      rows: this.term.rows,
      cols: this.term.cols,
      cwd: this.cwd,
    });
    this.id = info.id;
    this.runFile = info.run_file;
    panes.set(this.id, this);
    if (activePane === this) updateStatus();
  }

  addBlock(b) {
    this.blocks.push(b);
    const num = this.blocks.length;
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = b.exit === 0 ? "ok" : "fail";
    label.textContent = `${b.lines.toLocaleString()} lines · ${formatDuration(b.ms)} · exit ${b.exit ?? "?"}`;
    const cmdText = document.createElement("span");
    cmdText.className = "cmd-text";
    invoke("read_block", { session: b.session, start: b.cmd_start, end: b.start })
      .then((t) => {
        const c = t.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
        cmdText.textContent = c;
        cmdText.title = c;
      })
      .catch(() => {});
    const info = document.createElement("span");
    info.className = "block-info";
    const numEl = document.createElement("span");
    numEl.className = "cmd-num";
    numEl.textContent = `${num}.`;
    const head = document.createElement("span");
    head.className = "block-head";
    head.append(numEl, cmdText);
    info.append(head, label);
    const copy = document.createElement("button");
    copy.textContent = "Copy";
    const doCopy = async (mode) => {
      let start = mode === "command" ? b.cmd_start : b.start;
      let end = b.end;
      if (!prefs.splitByEntry) { // split off: copy the whole run, not just this command
        start = 0;
        end = await invoke("session_len", { id: b.session });
      }
      const text = await invoke("read_block", { session: b.session, start, end });
      await navigator.clipboard.writeText(text.trimEnd());
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    };
    copy.onclick = () => doCopy(prefs.copyMode);
    copy.title = prefs.copyMode === "command" ? "Copy command and output" : "Copy output only";
    const more = document.createElement("button");
    more.textContent = "▾";
    more.title = "Copy options";
    more.onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll(".copy-pop").forEach((n) => n.remove());
      const pop = document.createElement("div");
      pop.className = "copy-pop";
      for (const [mode, label] of [["output", "Copy output only"], ["command", "Copy command + output"]]) {
        const item = document.createElement("button");
        item.textContent = (prefs.copyMode === mode ? "✓ " : "") + label;
        item.onclick = () => {
          prefs.copyMode = mode;
          savePrefs();
          copy.title = mode === "command" ? "Copy command and output" : "Copy output only";
          pop.remove();
          doCopy(mode);
        };
        pop.append(item);
      }
      li.append(pop);
    };
    const analyze = document.createElement("button");
    analyze.className = "analyze-btn";
    analyze.textContent = prefs.splitByEntry ? "Analyze" : "Analyze all";
    analyze.onclick = () => (prefs.splitByEntry ? openAnalyze(b) : analyzeFull(this));
    const buttons = document.createElement("span");
    buttons.append(analyze, copy, more);
    li.append(info, buttons);
    this.blocksEl.append(li); // order is done in CSS (column-reverse puts the newest on top)
    if (prefs.newestBottom) scrollBlocksToEnd();
  }

  dispose() {
    this.term.dispose();
    this.el.remove();
    this.blocksEl.remove();
  }
}

function formatDuration(ms) {
  if (!ms || ms < 1000) return `${ms || 0} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} m ${Math.round(s - m * 60)} s`;
}

async function analyzeFull(pane) {
  if (!pane || pane.id === null) return;
  const end = await invoke("session_len", { id: pane.id });
  const allRanges = pane.blocks.map((b) => [b.start, b.end]);
  if (end > 0) openAnalyze({ session: pane.id, id: "all", label: "Full output of this terminal", start: 0, end, whole: true, allRanges });
}

function setSplitByEntry(v) {
  prefs.splitByEntry = v;
  savePrefs();
  $("split-entry").checked = v;
  document.querySelectorAll(".analyze-btn").forEach((b) => (b.textContent = v ? "Analyze" : "Analyze all"));
}
$("split-entry").onchange = (e) => setSplitByEntry(e.target.checked);
$("split-entry").checked = prefs.splitByEntry;

const MIN_TILE_W = 320;
const MIN_TILE_H = 140;

function layoutTab(tab) {
  // a zoomed pane fills the whole tab; the others stay alive but hidden
  const zoomed = tab.zoomed && tab.panes.includes(tab.zoomed) ? tab.zoomed : null;
  tab.zoomed = zoomed;
  for (const p of tab.panes) p.el.style.display = zoomed && p !== zoomed ? "none" : "";
  if (zoomed) {
    tab.grid.style.gridTemplateColumns = "minmax(0, 1fr)";
    tab.grid.style.gridTemplateRows = "minmax(0, 1fr)";
    return;
  }
  const n = Math.max(1, tab.panes.length);
  // as many columns as fit at the minimum tile width; extra tiles wrap onto more rows
  const maxCols = Math.max(1, Math.floor(($("stage").clientWidth || 1000) / MIN_TILE_W));
  const cols = Math.min(Math.ceil(Math.sqrt(n)), maxCols);
  const rows = Math.ceil(n / cols);
  // tiles never shrink below a usable size; a smaller window scrolls the tab instead
  tab.grid.style.gridTemplateColumns = `repeat(${cols}, minmax(${MIN_TILE_W}px, 1fr))`;
  tab.grid.style.gridTemplateRows = `repeat(${rows}, minmax(${MIN_TILE_H}px, 1fr))`;
  applyAutoFonts(tab);
}

function applyCommandOrder() {
  $("block-lists").classList.toggle("newest-bottom", prefs.newestBottom);
  scrollBlocksToEnd();
}
function scrollBlocksToEnd() {
  const el = $("blocks");
  if (prefs.newestBottom) el.scrollTop = el.scrollHeight;
}

function focusPane(pane) {
  if (!pane) return;
  activePane = pane;
  activeTab = pane.tab;
  pane.tab.last = pane;
  for (const p of panes.values()) p.el.classList.toggle("focused", p === pane);
  for (const t of tabs) for (const p of t.panes) p.blocksEl.hidden = p !== pane;
  scrollBlocksToEnd();
  pane.term.focus();
  updateStatus();
  const zl = document.getElementById("zoom-label");
  if (zl) zl.textContent = zoomPercent(pane);
}

function updateStatus() {
  $("lines").textContent = `${(activePane?.lines ?? 0).toLocaleString()} lines captured`;
  $("runfile").textContent = activePane?.runFile ?? "";
}

function splitActive() {
  if (activeTab) addPane(activeTab, activePane?.cwd);
}

let toastTimer = null;
function showToast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2500);
}

function toggleZoomPane(pane = activePane) {
  if (!pane) return;
  const tab = pane.tab;
  tab.zoomed = tab.zoomed === pane ? null : pane;
  layoutTab(tab);
  focusPane(pane);
  requestAnimationFrame(() => tab.panes.forEach((p) => { try { p.fit.fit(); } catch {} }));
}

async function addPane(tab, cwd, font) {
  const pane = new Pane(tab, cwd, font);
  await pane.start();
  focusPane(pane);
  persist();
  return pane;
}

function closePane(pane) {
  const tab = pane.tab;
  if (pane.id !== null) {
    panes.delete(pane.id);
    invoke("pty_close", { id: pane.id });
  }
  tab.panes = tab.panes.filter((p) => p !== pane);
  if (tab.last === pane) tab.last = null;
  const wasActive = activePane === pane;
  pane.dispose();
  if (tab.panes.length === 0) {
    closeTab(tab);
    return;
  }
  layoutTab(tab);
  if (wasActive) focusPane(tab.last ?? tab.panes[0]);
  persist();
}

// ---------------------------------------------------------------- tabs

function createTab() {
  const el = document.createElement("div");
  el.className = "tab";
  const grid = document.createElement("div");
  grid.className = "grid";
  el.append(grid);
  $("stage").append(el);
  const tab = { el, grid, panes: [], last: null };
  tabs.push(tab);
  selectTab(tab);
  return tab;
}

async function newTab(cwd, font) {
  const tab = createTab();
  await addPane(tab, cwd, font);
  return tab;
}

function selectTab(tab) {
  activeTab = tab;
  for (const t of tabs) t.el.classList.toggle("active", t === tab);
  renderTabBar(true);
  const pane = tab.last ?? tab.panes[0];
  if (pane) {
    focusPane(pane);
    requestAnimationFrame(() => tab.panes.forEach((p) => { try { p.fit.fit(); } catch {} }));
  }
}

function closeTab(tab) {
  for (const p of [...tab.panes]) {
    if (p.id !== null) { panes.delete(p.id); invoke("pty_close", { id: p.id }); }
    p.dispose();
  }
  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);
  tab.el.remove();
  if (tabs.length === 0) {
    activePane = null;
    activeTab = null;
    newTab(null);
    return;
  }
  selectTab(tabs[Math.min(idx, tabs.length - 1)]);
  persist();
}

const tabTitle = (tab) => fmtPath(tab.panes[0]?.cwd, prefs.tabTitle);

let lastBar = "";
function renderTabBar(force = false) {
  const sig = JSON.stringify(tabs.map((t) => [tabTitle(t), t === activeTab]));
  if (!force && sig === lastBar) return;
  lastBar = sig;
  const host = $("tabs");
  host.replaceChildren();
  tabs.forEach((tab) => {
    const b = document.createElement("div");
    b.className = "tab-btn" + (tab === activeTab ? " active" : "");
    b.title = fmtPath(tab.panes[0]?.cwd, "full");
    const title = document.createElement("span");
    title.textContent = tabTitle(tab);
    const x = document.createElement("button");
    x.textContent = "✕";
    x.onclick = (e) => { e.stopPropagation(); closeTab(tab); };
    b.append(title, x);
    b.onclick = () => selectTab(tab);
    b.onauxclick = (e) => { if (e.button === 1) closeTab(tab); };
    host.append(b);
  });
}

function cycleTab(dir) {
  if (tabs.length < 2) return;
  selectTab(tabs[(tabs.indexOf(activeTab) + dir + tabs.length) % tabs.length]);
}

// ---------------------------------------------------------------- overview (all tabs at a glance)

function snapshot(term) {
  const buf = term.buffer.active;
  const out = [];
  for (let i = Math.max(0, buf.length - 14); i < buf.length; i++) {
    out.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  return out.join("\n").trimEnd();
}

function toggleOverview(force) {
  const ov = $("overview");
  const show = force ?? ov.hidden;
  if (!show) { ov.hidden = true; activePane?.term.focus(); return; }
  ov.replaceChildren();
  const head = document.createElement("div");
  head.className = "ov-head";
  head.textContent = `${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}`;
  const grid = document.createElement("div");
  grid.className = "ov-grid";
  for (const tab of tabs) {
    const card = document.createElement("div");
    card.className = "ov-card" + (tab === activeTab ? " active" : "");
    const pre = document.createElement("pre");
    pre.textContent = snapshot((tab.last ?? tab.panes[0]).term);
    const cap = document.createElement("div");
    cap.className = "ov-cap";
    cap.textContent = tab.panes.length > 1 ? `${tabTitle(tab)} · ${tab.panes.length} panes` : tabTitle(tab);
    const x = document.createElement("button");
    x.textContent = "✕";
    x.onclick = (e) => { e.stopPropagation(); closeTab(tab); toggleOverview(true); };
    card.append(x, pre, cap);
    card.onclick = () => { ov.hidden = true; selectTab(tab); };
    grid.append(card);
  }
  const add = document.createElement("button");
  add.className = "ov-new";
  add.textContent = "+ New tab";
  add.onclick = () => { ov.hidden = true; newTab(activePane?.cwd); };
  ov.append(head, grid, add);
  ov.hidden = false;
}

// ---------------------------------------------------------------- command list panel

function setCommandsHidden(hidden) {
  prefs.commandsHidden = hidden;
  savePrefs();
  $("main").classList.toggle("cmd-hidden", hidden);
  $("blocks-toggle").textContent = hidden ? "‹" : "›";
  requestAnimationFrame(() => { for (const p of panes.values()) { try { p.fit.fit(); } catch {} } });
}
$("blocks-toggle").onclick = () => setCommandsHidden(!prefs.commandsHidden);

// ---------------------------------------------------------------- zoom, fullscreen

const clampFont = (px) => Math.min(32, Math.max(8, px));
const zoomPercent = (pane) => `${Math.round(((pane?.font ?? prefs.font) / FONT_DEFAULT) * 100)}%`;

// Text size: the default (Preferences), optionally scaled down as a tab gets more terminals,
// and zoom by hand, which applies to one terminal only so the others are not redrawn.
function autoFontFor(n) {
  const factor = n <= 1 ? 1 : n === 2 ? 0.93 : n <= 4 ? 0.86 : n <= 6 ? 0.79 : 0.72;
  return clampFont(Math.round(prefs.font * factor));
}
const baseFontFor = (tab) => (prefs.autoSize ? autoFontFor(tab.panes.length) : prefs.font);

function applyPaneFont(pane, px) {
  px = clampFont(px);
  if (!pane.term || pane.font === px) return;
  pane.font = px;
  pane.term.options.fontSize = px;
  try { pane.fit.fit(); } catch {}
  const label = document.getElementById("zoom-label");
  if (label && pane === activePane) label.textContent = zoomPercent(pane);
  persist();
}

function applyAutoFonts(tab) {
  for (const p of tab.panes) if (!p.manual) applyPaneFont(p, baseFontFor(tab));
}

function setPaneFont(pane, px) {
  if (!pane) return;
  pane.manual = true;
  applyPaneFont(pane, px);
}

function resetPaneFont(pane) {
  if (!pane) return;
  pane.manual = false;
  applyPaneFont(pane, baseFontFor(pane.tab));
}

// Zoom every terminal by the same step; terminals zoomed by hand keep their difference.
function zoomAll(delta) {
  prefs.font = clampFont(prefs.font + delta);
  savePrefs();
  for (const p of panes.values()) applyPaneFont(p, p.manual ? p.font + delta : baseFontFor(p.tab));
  refreshZoomLabels();
}

function refreshZoomLabels() {
  const a = document.getElementById("zoom-all-label");
  const t = document.getElementById("zoom-label");
  if (a) a.textContent = zoomPercent(null);
  if (t) t.textContent = zoomPercent(activePane);
}

// the default size for new terminals (Preferences); also resets every open terminal to it
function setDefaultFont(px) {
  prefs.font = clampFont(px);
  savePrefs();
  for (const p of panes.values()) resetPaneFont(p);
  refreshZoomLabels();
}

async function toggleFullscreen() {
  const w = getCurrentWindow();
  await w.setFullscreen(!(await w.isFullscreen()));
}

// ---------------------------------------------------------------- keyboard shortcuts

const ACTIONS = [
  { id: "newTab", label: "New tab", combo: "Ctrl+Shift+T" },
  { id: "splitPane", label: "Split pane", combo: "Ctrl+Shift+D" },
  { id: "closePane", label: "Close pane or tab", combo: "Ctrl+Shift+W" },
  { id: "zoomPane", label: "Zoom pane (toggle)", combo: "Ctrl+Shift+Z" },
  { id: "overview", label: "Show open tabs", combo: "Ctrl+Shift+O" },
  { id: "prevTab", label: "Previous tab", combo: "Ctrl+PageUp" },
  { id: "nextTab", label: "Next tab", combo: "Ctrl+PageDown" },
  { id: "copy", label: "Copy selection", combo: "Ctrl+Shift+C" },
  { id: "find", label: "Find in terminal", combo: "Ctrl+Shift+F" },
  { id: "analyzeText", label: "Analyze pasted text", combo: "Ctrl+Shift+L" },
  { id: "commands", label: "Show or hide command list", combo: "Ctrl+Shift+B" },
  { id: "zoomIn", label: "Zoom in", combo: "Ctrl+=" },
  { id: "zoomOut", label: "Zoom out", combo: "Ctrl+-" },
  { id: "zoomReset", label: "Reset zoom", combo: "Ctrl+0" },
  { id: "zoomAllIn", label: "Zoom all terminals in", combo: "Ctrl+Alt+=" },
  { id: "zoomAllOut", label: "Zoom all terminals out", combo: "Ctrl+Alt+-" },
  { id: "zoomAllReset", label: "Reset zoom of all terminals", combo: "Ctrl+Alt+0" },
  { id: "fullscreen", label: "Fullscreen", combo: "F11" },
  { id: "prefs", label: "Preferences", combo: "Ctrl+," },
  { id: "shortcuts", label: "Keyboard shortcuts", combo: "Ctrl+Shift+/" },
];
const comboFor = (a) => prefs.keys[a.id] ?? a.combo;
const pretty = (c) => c.replace("Ctrl+Shift+/", "Ctrl+?").replace("Ctrl+Shift+=", "Ctrl++");
const labelFor = (id) => pretty(comboFor(ACTIONS.find((a) => a.id === id)));

const MODIFIER_CODES = new Set(["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);
const PUNCT = { Slash: "/", Comma: ",", Period: ".", Equal: "=", Minus: "-", Semicolon: ";", Quote: "'", Backquote: "`", BracketLeft: "[", BracketRight: "]", Backslash: "\\" };

function comboOf(e) {
  if (MODIFIER_CODES.has(e.code)) return null;
  let name = e.code;
  if (name.startsWith("Key")) name = name.slice(3);
  else if (name.startsWith("Digit")) name = name.slice(5);
  else if (PUNCT[name]) name = PUNCT[name];
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(name);
  return parts.join("+");
}

let recorder = null; // set while the shortcuts dialog is waiting for a key

function runAction(id) {
  const analyzeOpen = !!document.getElementById("analyze");
  switch (id) {
    case "newTab": newTab(activePane?.cwd); return true;
    case "splitPane": splitActive(); return true;
    case "closePane": if (activePane) closePane(activePane); return true;
    case "zoomPane": toggleZoomPane(); return true;
    case "overview": toggleOverview(); return true;
    case "prevTab": cycleTab(-1); return true;
    case "nextTab": cycleTab(1); return true;
    case "copy": {
      const text = activePane?.term.getSelection();
      if (text && !analyzeOpen) { navigator.clipboard.writeText(text); return true; }
      return false; // nothing selected: let the key through
    }
    case "analyzeText": showPasteDialog(); return true;
    case "commands": setCommandsHidden(!prefs.commandsHidden); return true;
    case "find": if (activePane) activePane.toggleFind(true); return true;
    case "zoomIn": if (analyzeOpen) return false; setPaneFont(activePane, (activePane?.font ?? prefs.font) + 1); return true;
    case "zoomOut": if (analyzeOpen) return false; setPaneFont(activePane, (activePane?.font ?? prefs.font) - 1); return true;
    case "zoomAllIn": if (analyzeOpen) return false; zoomAll(1); return true;
    case "zoomAllOut": if (analyzeOpen) return false; zoomAll(-1); return true;
    case "zoomAllReset": if (analyzeOpen) return false; setDefaultFont(FONT_DEFAULT); return true;
    case "zoomReset": if (analyzeOpen) return false; resetPaneFont(activePane); return true;
    case "fullscreen": toggleFullscreen(); return true;
    case "prefs": showPreferences(); return true;
    case "shortcuts": showShortcuts(); return true;
  }
  return false;
}

function handleShortcut(e) {
  if (e.type !== "keydown") return false;
  const combo = comboOf(e);
  if (!combo) return false;
  if (recorder) { recorder(combo); return true; }
  if (combo === "Escape") {
    if (!$("dialog-host").hidden) { closeDialog(); return true; }
    if (!$("overview").hidden) { toggleOverview(false); return true; }
    return false;
  }
  const alt = /^Alt\+([1-9])$/.exec(combo);
  if (alt) {
    const t = tabs[Number(alt[1]) - 1];
    if (t) { selectTab(t); return true; }
    return false;
  }
  for (const a of ACTIONS) {
    if (comboFor(a) === combo || (a.id === "zoomIn" && combo === "Ctrl+Shift+=")) return runAction(a.id);
  }
  return false;
}
// capture phase: handled before xterm sees the key, so shortcuts never reach the shell
document.addEventListener("keydown", (e) => {
  if (handleShortcut(e)) { e.preventDefault(); e.stopPropagation(); }
}, true);

// ---------------------------------------------------------------- dialogs

function closeDialog() {
  const host = $("dialog-host");
  host.hidden = true;
  host.replaceChildren();
  recorder = null;
  activePane?.term.focus();
}

function openDialog(title, build) {
  const host = $("dialog-host");
  host.replaceChildren();
  const box = document.createElement("div");
  box.className = "dialog";
  const head = document.createElement("header");
  const t = document.createElement("span");
  t.textContent = title;
  const x = document.createElement("button");
  x.textContent = "✕";
  x.onclick = closeDialog;
  head.append(t, x);
  const body = document.createElement("div");
  body.className = "body";
  box.append(head, body);
  host.append(box);
  host.onmousedown = (e) => { if (e.target === host) closeDialog(); };
  build(body);
  host.hidden = false;
}

function opt(label, control) {
  const row = document.createElement("div");
  row.className = "opt";
  const l = document.createElement("span");
  l.textContent = label;
  row.append(l, control);
  return row;
}
const heading = (t) => Object.assign(document.createElement("h3"), { textContent: t });

function showPreferences() {
  openDialog("Preferences", (body) => {
    const theme = document.createElement("select");
    for (const [v, l] of [["auto", "Follow system"], ["light", "Light"], ["dark", "Dark"]]) theme.add(new Option(l, v, false, prefs.theme === v));
    theme.onchange = () => setTheme(theme.value);

    const font = document.createElement("input");
    font.type = "number"; font.min = 8; font.max = 32; font.value = prefs.font;
    font.onchange = () => setDefaultFont(Number(font.value) || FONT_DEFAULT);

    const titleStyle = document.createElement("select");
    for (const [v, l] of [["folder", "Folder name (src)"], ["short", "Shortened path (~/p/L/src)"], ["full", "Full path (~/projects/Local/src)"]]) {
      titleStyle.add(new Option(l, v, false, prefs.tabTitle === v));
    }
    titleStyle.onchange = () => { prefs.tabTitle = titleStyle.value; savePrefs(); renderTabBar(true); };

    const auto = document.createElement("input");
    auto.type = "checkbox"; auto.checked = prefs.autoSize;
    auto.onchange = () => { prefs.autoSize = auto.checked; savePrefs(); tabs.forEach(applyAutoFonts); };

    const restore = document.createElement("input");
    restore.type = "checkbox"; restore.checked = prefs.restoreDirs;
    restore.onchange = () => { prefs.restoreDirs = restore.checked; savePrefs(); };

    const scroll = document.createElement("input");
    scroll.type = "number"; scroll.min = 500; scroll.max = 200000; scroll.step = 500; scroll.value = prefs.scrollback;
    scroll.onchange = () => {
      prefs.scrollback = Math.min(200000, Math.max(500, Number(scroll.value) || 5000));
      savePrefs();
      for (const p of panes.values()) p.term.options.scrollback = prefs.scrollback;
    };

    const fmtBytes = (n) => (n < 1048576 ? `${Math.round(n / 1024)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
    const split = document.createElement("input");
    split.type = "checkbox"; split.checked = prefs.splitByEntry;
    split.onchange = () => setSplitByEntry(split.checked);

    const order = document.createElement("select");
    for (const [v, l] of [[false, "Newest at the top"], [true, "Newest at the bottom (follows new commands)"]]) order.add(new Option(l, v, false, prefs.newestBottom === v));
    order.onchange = () => { prefs.newestBottom = order.value === "true"; savePrefs(); applyCommandOrder(); };

    const days = document.createElement("input");
    days.type = "number"; days.min = 0; days.max = 3650; days.value = prefs.cleanupDays;
    days.onchange = () => { prefs.cleanupDays = Math.min(3650, Math.max(0, Math.floor(Number(days.value)) || 0)); savePrefs(); };
    const usage = document.createElement("span");
    const showUsage = async () => {
      try { const [n, b] = await invoke("runs_usage"); usage.textContent = `${n} files, ${fmtBytes(b)}`; } catch {}
    };
    showUsage();
    const clean = document.createElement("button");
    clean.textContent = "Delete older than that now";
    clean.title = "Deletes saved output of closed terminals (all of it when the number of days is 0)";
    clean.onclick = async () => {
      const d = Math.floor(Number(days.value)) || 0;
      if (!clean.armed) { // second click confirms; native confirm() is not relied on in the webview
        clean.armed = true;
        clean.textContent = d > 0 ? `Click again: delete older than ${d} days` : "Click again: delete ALL closed output";
        setTimeout(() => { clean.armed = false; clean.textContent = "Delete older than that now"; }, 4000);
        return;
      }
      clean.armed = false;
      clean.textContent = "Delete older than that now";
      try { const [n, b] = await invoke("cleanup_runs", { days: d }); usage.textContent = n ? `Done: removed ${n} files, freed ${fmtBytes(b)}` : "Nothing to remove"; setTimeout(showUsage, 2500); } catch (e) { usage.textContent = String(e); }
    };
    const cleanRow = document.createElement("span");
    cleanRow.append(clean, " ", usage);

    body.append(
      heading("Appearance"), opt("Theme", theme), opt("Font size", font),
      opt("Smaller text when a tab has more terminals", auto),
      heading("Tabs"), opt("Tab title", titleStyle),
      heading("Startup"), opt("Restore directories on start", restore),
      heading("Terminal"), opt("Scrollback lines (full output is always saved to disk)", scroll),
      heading("Commands list"), opt("Order", order),
      opt("Analyze one command at a time (off: Analyze opens the whole run)", split),
      heading("Saved output"), opt("Delete saved output older than (days, 0 = never)", days), opt("Disk used", cleanRow),
    );
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "Highlight words and folding are set inside the output viewer. Keyboard shortcuts are under the menu.";
    body.append(note);
  });
}

function showPasteDialog() {
  openDialog("Analyze pasted text", (body) => {
    const area = document.createElement("textarea");
    area.placeholder = "Paste a log here (for example copied from another terminal)…";
    area.style.cssText = "width:100%;height:300px;box-sizing:border-box;font-family:monospace;font-size:12px;color:inherit;background:var(--bg);border:1px solid var(--line2);border-radius:6px;padding:8px;resize:vertical";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:10px";
    const mk = (text, fn) => Object.assign(document.createElement("button"), { className: "linkbtn", textContent: text, onclick: fn });
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "You can also drop a log file onto the window. Nothing is uploaded; it stays on this computer.";
    row.append(
      mk("Paste from clipboard", async () => { try { area.value = await navigator.clipboard.readText(); } catch {} }),
      mk("Analyze", () => {
        const text = area.value;
        if (!text) return;
        closeDialog();
        openAnalyze({ label: "Pasted text", importText: text });
      }),
    );
    body.append(area, row, note);
    area.focus();
  });
}

function showShortcuts() {
  openDialog("Keyboard shortcuts", (body) => {
    const warn = document.createElement("div");
    warn.className = "warn";
    const render = () => {
      body.replaceChildren();
      body.append(warn);
      for (const a of ACTIONS) {
        const b = document.createElement("button");
        b.className = "kb";
        b.textContent = pretty(comboFor(a));
        b.title = "Click, then press the new keys (Esc cancels)";
        b.onclick = () => {
          b.classList.add("recording");
          b.textContent = "Press keys…";
          warn.textContent = "";
          recorder = (combo) => {
            recorder = null;
            if (combo === "Escape") { render(); return; }
            const hasMod = combo.includes("Ctrl") || combo.includes("Alt") || /^F\d+$/.test(combo);
            const taken = ACTIONS.find((o) => o.id !== a.id && comboFor(o) === combo);
            if (!hasMod) warn.textContent = "A shortcut needs Ctrl or Alt (or be an F-key).";
            else if (taken) warn.textContent = `${pretty(combo)} is already used by “${taken.label}”.`;
            else { prefs.keys[a.id] = combo; savePrefs(); warn.textContent = ""; }
            render();
          };
        };
        body.append(opt(a.label, b));
      }
      body.append(opt("Go to tab 1–9", Object.assign(document.createElement("span"), { textContent: "Alt+1 … Alt+9" })));
      const reset = document.createElement("button");
      reset.className = "linkbtn";
      reset.textContent = "Reset all to defaults";
      reset.onclick = () => { prefs.keys = {}; savePrefs(); warn.textContent = ""; render(); };
      body.append(reset);
    };
    render();
  });
}

function showHistory() {
  openDialog("History", (body) => {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "Saved output of this and earlier sessions. Click a session to see its commands. Delete old files under Preferences.";
    const list = document.createElement("div");
    list.className = "history";
    const clear = document.createElement("button");
    clear.textContent = "Clear history";
    clear.title = "Deletes the saved output of all closed terminals; open terminals are kept";
    clear.onclick = async () => {
      if (!clear.armed) { // second click confirms
        clear.armed = true;
        clear.textContent = "Click again to delete all closed history";
        setTimeout(() => { clear.armed = false; clear.textContent = "Clear history"; }, 4000);
        return;
      }
      clear.armed = false;
      clear.textContent = "Clear history";
      try { await invoke("cleanup_runs", { days: 0 }); } catch (e) { list.textContent = String(e); return; }
      load();
    };
    body.append(note, clear, list);
    const fmtSize = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
    const addRun = (r) => {
      const row = document.createElement("div");
      row.className = "hist-run";
      const head = document.createElement("button");
      head.className = "hist-head";
      head.textContent = `${new Date(r.modified * 1000).toLocaleString()} · ${fmtSize(r.size)}${r.open ? " · open now" : ""}`;
      const cmds = document.createElement("div");
      cmds.className = "hist-cmds";
      cmds.hidden = true;
      let loaded = false;
      head.onclick = async () => {
        cmds.hidden = !cmds.hidden;
        if (cmds.hidden || loaded) return;
        loaded = true;
        cmds.textContent = "Reading…";
        try {
          const found = await invoke("scan_run", { name: r.name });
          cmds.replaceChildren();
          if (!found.length) cmds.textContent = "No commands recorded in this file.";
          for (const [b, text] of found.reverse()) {
            const line = document.createElement("div");
            line.className = "hist-cmd";
            const label = document.createElement("span");
            const c = text.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
            label.textContent = `${c || "(unknown command)"}  ·  ${b.lines.toLocaleString()} lines · exit ${b.exit ?? "?"}`;
            label.title = c;
            const open = document.createElement("button");
            open.textContent = "Analyze";
            open.onclick = () => { closeDialog(); openAnalyze({ run: r.name, start: b.start, end: b.end, label: c || `Command #${b.id}` }); };
            line.append(label, open);
            cmds.append(line);
          }
        } catch (e) {
          cmds.textContent = String(e);
          loaded = false;
        }
      };
      row.append(head, cmds);
      list.append(row);
    };
    const load = () => invoke("list_runs").then((runs) => {
      list.replaceChildren();
      if (!runs.length) list.textContent = "No saved output yet.";
      runs.forEach(addRun);
    }).catch((e) => { list.textContent = String(e); });
    load();
  });
}

function showAbout() {
  openDialog("About", (body) => {
    const wrap = document.createElement("div");
    wrap.className = "about";
    wrap.innerHTML = `<img src="/logo.png" alt="" /><h2>Digterm</h2><div>Version <span id="about-version">…</span> · MIT license</div>
      <p>A terminal that helps you understand large command output.</p>
      <div class="note">github.com/somore100/DigTerm</div>`;
    body.append(wrap);
    getVersion().then((v) => { wrap.querySelector("#about-version").textContent = v; }).catch(() => {});
  });
}

// ---------------------------------------------------------------- menu

const menu = $("menu");

function renderMenu() {
  menu.replaceChildren();
  const themeRow = document.createElement("div");
  themeRow.className = "theme-row";
  for (const t of ["auto", "light", "dark"]) {
    const b = document.createElement("button");
    b.className = `theme-btn theme-${t}` + (prefs.theme === t ? " active" : "");
    b.title = { auto: "Follow system", light: "Light", dark: "Dark" }[t];
    b.onclick = (e) => { e.stopPropagation(); setTheme(t); renderMenu(); };
    themeRow.append(b);
  }
  const mk = (text, fn) => Object.assign(document.createElement("button"), { textContent: text, onclick: (e) => { e.stopPropagation(); fn(); } });
  const zoomRow = (caption, labelId, pct, minus, plus) => {
    const row = document.createElement("div");
    row.className = "zoom-row";
    const cap = Object.assign(document.createElement("span"), { className: "zoom-cap", textContent: caption });
    const lab = Object.assign(document.createElement("span"), { id: labelId, className: "zoom-pct", textContent: pct });
    row.append(cap, mk("−", minus), lab, mk("+", plus));
    return row;
  };
  const cur = () => activePane?.font ?? prefs.font;
  menu.append(
    themeRow,
    zoomRow("All terminals", "zoom-all-label", zoomPercent(null), () => zoomAll(-1), () => zoomAll(1)),
    zoomRow("This terminal", "zoom-label", zoomPercent(activePane), () => setPaneFont(activePane, cur() - 1), () => setPaneFont(activePane, cur() + 1)),
    document.createElement("hr"),
  );

  const item = (label, shortcutId, fn) => {
    const b = document.createElement("button");
    const l = document.createElement("span");
    l.textContent = label;
    b.append(l);
    if (shortcutId) b.append(Object.assign(document.createElement("kbd"), { textContent: labelFor(shortcutId) }));
    b.onclick = () => { menu.hidden = true; fn(); };
    menu.append(b);
  };
  const sep = () => menu.append(document.createElement("hr"));
  item("New tab", "newTab", () => newTab(activePane?.cwd));
  item("Split pane", "splitPane", splitActive);
  item("Zoom this pane", "zoomPane", () => toggleZoomPane());
  item("Show open tabs", "overview", () => toggleOverview(true));
  sep();
  item("Find in terminal", "find", () => activePane?.toggleFind(true));
  item(prefs.commandsHidden ? "Show command list" : "Hide command list", "commands", () => setCommandsHidden(!prefs.commandsHidden));
  item("Analyze full output of this terminal", null, () => analyzeFull(activePane));
  item("Analyze pasted text…", "analyzeText", showPasteDialog);
  item("History of earlier sessions…", null, showHistory);
  sep();
  item("Fullscreen", "fullscreen", toggleFullscreen);
  sep();
  item("Preferences", "prefs", showPreferences);
  item("Keyboard shortcuts", "shortcuts", showShortcuts);
  item("About Digterm", null, showAbout);
}

$("menu-btn").onclick = (e) => { e.stopPropagation(); if (menu.hidden) renderMenu(); menu.hidden = !menu.hidden; };
document.addEventListener("click", (e) => {
  if (!menu.contains(e.target)) menu.hidden = true;
  document.querySelectorAll(".copy-pop").forEach((n) => n.remove());
});
$("new-tab").onclick = () => newTab(activePane?.cwd);
$("split-btn").onclick = splitActive;
$("overview-btn").onclick = () => toggleOverview();

// ---------------------------------------------------------------- persistence of tabs and directories

let lastSaved = "";
async function persist() {
  const data = {
    active: Math.max(0, tabs.indexOf(activeTab)),
    tabs: tabs.map((t) => ({ panes: t.panes.map((p) => ({ cwd: p.cwd, font: p.font, manual: p.manual })) })),
  };
  const json = JSON.stringify(data);
  if (json === lastSaved) return;
  lastSaved = json;
  try { await invoke("save_layout", { json }); } catch {}
}

setInterval(async () => {
  for (const p of panes.values()) {
    const cwd = await invoke("pty_cwd", { id: p.id });
    if (cwd) p.cwd = cwd;
  }
  renderTabBar();
  persist();
}, 2000);

// ---------------------------------------------------------------- backend events

await listen("pty-lines", (e) => {
  const p = panes.get(e.payload.id);
  if (!p) return;
  p.lines = e.payload.lines;
  if (p === activePane) updateStatus();
});
// dropping a log file onto the window opens it in the viewer
await listen("tauri://drag-drop", (e) => {
  const path = e.payload?.paths?.[0];
  if (path) openAnalyze({ label: `File: ${basename(path)}`, importPath: path });
});
await listen("pty-block", (e) => panes.get(e.payload.session)?.addBlock(e.payload));
await listen("pty-exit", (e) => {
  const p = panes.get(e.payload);
  if (p) closePane(p); // the shell ended, like closing a terminal window's last shell
});

// ---------------------------------------------------------------- start

applyCommandOrder();
if (prefs.cleanupDays > 0) invoke("cleanup_runs", { days: prefs.cleanupDays }).catch(() => {});

new ResizeObserver(() => tabs.forEach(layoutTab)).observe($("stage"));
applyTheme();
setCommandsHidden(prefs.commandsHidden);
try { HOME = (await invoke("home_dir")) ?? ""; } catch {}

let layout = null;
try {
  const raw = await invoke("load_layout");
  layout = raw ? JSON.parse(raw) : null;
} catch {}

if (prefs.restoreDirs && layout?.tabs?.length) {
  for (const t of layout.tabs) {
    // entries are {cwd, font}; older saves are plain directory strings
    const entries = (t.panes?.length ? t.panes : [null]).map((e) => (e && typeof e === "object" ? e : { cwd: e }));
    // create every pane first and start the shells together, so none is resized right after starting
    const tab = createTab();
    const created = entries.map((e) => new Pane(tab, e.cwd, e.manual ? e.font : undefined));
    await Promise.all(created.map((p) => p.start()));
    focusPane(created[0]);
    persist();
  }
  selectTab(tabs[Math.min(layout.active ?? 0, tabs.length - 1)]);
} else {
  await newTab(null);
}
