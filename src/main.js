import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  copyMode: "output", // output | command
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
  constructor(tab, cwd) {
    this.tab = tab;
    this.id = null;
    this.cwd = cwd ?? null;
    this.lines = 0;
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
    this.el.append(this.termEl, close);

    this.blocksEl = document.createElement("ul");
    this.blocksEl.className = "block-list";
    this.blocksEl.hidden = true;
    $("block-lists").append(this.blocksEl);

    tab.grid.append(this.el);
    tab.panes.push(this);
    layoutTab(tab);

    this.term = new Terminal({
      fontFamily: "monospace",
      fontSize: prefs.font,
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
      this.resizeTimer = setTimeout(() => { if (this.id !== null) invoke("pty_resize", { id: this.id, rows, cols }); }, 150);
    });
    new ResizeObserver(() => { try { this.fit.fit(); } catch {} }).observe(this.termEl);
    this.termEl.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setFont(prefs.font + (e.deltaY < 0 ? 1 : -1));
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
    const onData = new Channel();
    onData.onmessage = (msg) => this.term.write(new Uint8Array(msg));
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
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = b.exit === 0 ? "ok" : "fail";
    label.textContent = `#${b.id} · ${b.lines.toLocaleString()} lines · exit ${b.exit ?? "?"}`;
    const copy = document.createElement("button");
    copy.textContent = "Copy";
    const doCopy = async (mode) => {
      const start = mode === "command" ? b.cmd_start : b.start;
      const text = await invoke("read_block", { session: b.session, start, end: b.end });
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
    analyze.textContent = "Analyze";
    analyze.onclick = () => openAnalyze(b);
    const buttons = document.createElement("span");
    buttons.append(analyze, copy, more);
    li.append(label, buttons);
    this.blocksEl.prepend(li);
  }

  dispose() {
    this.term.dispose();
    this.el.remove();
    this.blocksEl.remove();
  }
}

async function analyzeFull(pane) {
  if (!pane || pane.id === null) return;
  const end = await invoke("session_len", { id: pane.id });
  if (end > 0) openAnalyze({ session: pane.id, id: "all", label: "Full output of this terminal", start: 0, end });
}

function layoutTab(tab) {
  const n = Math.max(1, tab.panes.length);
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  tab.grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  tab.grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
}

function focusPane(pane) {
  if (!pane) return;
  activePane = pane;
  activeTab = pane.tab;
  pane.tab.last = pane;
  for (const p of panes.values()) p.el.classList.toggle("focused", p === pane);
  for (const t of tabs) for (const p of t.panes) p.blocksEl.hidden = p !== pane;
  pane.term.focus();
  updateStatus();
}

function updateStatus() {
  $("lines").textContent = `${(activePane?.lines ?? 0).toLocaleString()} lines captured`;
  $("runfile").textContent = activePane?.runFile ?? "";
}

async function addPane(tab, cwd) {
  const pane = new Pane(tab, cwd);
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

async function newTab(cwd) {
  const el = document.createElement("div");
  el.className = "tab";
  const grid = document.createElement("div");
  grid.className = "grid";
  el.append(grid);
  $("stage").append(el);
  const tab = { el, grid, panes: [], last: null };
  tabs.push(tab);
  selectTab(tab);
  await addPane(tab, cwd);
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

function setFont(px) {
  prefs.font = Math.min(32, Math.max(8, px));
  savePrefs();
  for (const p of panes.values()) {
    p.term.options.fontSize = prefs.font;
    try { p.fit.fit(); } catch {}
  }
  const label = document.getElementById("zoom-label");
  if (label) label.textContent = `${Math.round((prefs.font / FONT_DEFAULT) * 100)}%`;
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
  { id: "overview", label: "Show open tabs", combo: "Ctrl+Shift+O" },
  { id: "prevTab", label: "Previous tab", combo: "Ctrl+PageUp" },
  { id: "nextTab", label: "Next tab", combo: "Ctrl+PageDown" },
  { id: "copy", label: "Copy selection", combo: "Ctrl+Shift+C" },
  { id: "find", label: "Find in terminal", combo: "Ctrl+Shift+F" },
  { id: "commands", label: "Show or hide command list", combo: "Ctrl+Shift+B" },
  { id: "zoomIn", label: "Zoom in", combo: "Ctrl+=" },
  { id: "zoomOut", label: "Zoom out", combo: "Ctrl+-" },
  { id: "zoomReset", label: "Reset zoom", combo: "Ctrl+0" },
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
    case "splitPane": if (activeTab) addPane(activeTab, activePane?.cwd); return true;
    case "closePane": if (activePane) closePane(activePane); return true;
    case "overview": toggleOverview(); return true;
    case "prevTab": cycleTab(-1); return true;
    case "nextTab": cycleTab(1); return true;
    case "copy": {
      const text = activePane?.term.getSelection();
      if (text && !analyzeOpen) { navigator.clipboard.writeText(text); return true; }
      return false; // nothing selected: let the key through
    }
    case "commands": setCommandsHidden(!prefs.commandsHidden); return true;
    case "find": if (activePane) activePane.toggleFind(true); return true;
    case "zoomIn": if (analyzeOpen) return false; setFont(prefs.font + 1); return true;
    case "zoomOut": if (analyzeOpen) return false; setFont(prefs.font - 1); return true;
    case "zoomReset": if (analyzeOpen) return false; setFont(FONT_DEFAULT); return true;
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
    font.onchange = () => setFont(Number(font.value) || FONT_DEFAULT);

    const titleStyle = document.createElement("select");
    for (const [v, l] of [["folder", "Folder name (src)"], ["short", "Shortened path (~/p/L/src)"], ["full", "Full path (~/projects/Local/src)"]]) {
      titleStyle.add(new Option(l, v, false, prefs.tabTitle === v));
    }
    titleStyle.onchange = () => { prefs.tabTitle = titleStyle.value; savePrefs(); renderTabBar(true); };

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

    body.append(
      heading("Appearance"), opt("Theme", theme), opt("Font size", font),
      heading("Tabs"), opt("Tab title", titleStyle),
      heading("Startup"), opt("Restore directories on start", restore),
      heading("Terminal"), opt("Scrollback lines (full output is always saved to disk)", scroll),
    );
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "Highlight words and folding are set inside the output viewer. Keyboard shortcuts are under the menu.";
    body.append(note);
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

function showAbout() {
  openDialog("About", (body) => {
    const wrap = document.createElement("div");
    wrap.className = "about";
    wrap.innerHTML = `<img src="/logo.png" alt="" /><h2>Digterm</h2><div>Version 0.0.1 · MIT license</div>
      <p>A terminal that helps you understand large command output.</p>
      <div class="note">github.com/somore100/DigTerm</div>`;
    body.append(wrap);
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
  const zoomRow = document.createElement("div");
  zoomRow.className = "zoom-row";
  const mk = (text, fn) => Object.assign(document.createElement("button"), { textContent: text, onclick: (e) => { e.stopPropagation(); fn(); } });
  const zl = Object.assign(document.createElement("span"), { id: "zoom-label", textContent: `${Math.round((prefs.font / FONT_DEFAULT) * 100)}%` });
  zoomRow.append(mk("−", () => setFont(prefs.font - 1)), zl, mk("+", () => setFont(prefs.font + 1)));
  menu.append(themeRow, zoomRow, document.createElement("hr"));

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
  item("Split pane", "splitPane", () => activeTab && addPane(activeTab, activePane?.cwd));
  item("Show open tabs", "overview", () => toggleOverview(true));
  sep();
  item("Find in terminal", "find", () => activePane?.toggleFind(true));
  item(prefs.commandsHidden ? "Show command list" : "Hide command list", "commands", () => setCommandsHidden(!prefs.commandsHidden));
  item("Analyze full output of this terminal", null, () => analyzeFull(activePane));
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
$("split-btn").onclick = () => { if (activeTab) addPane(activeTab, activePane?.cwd); };
$("overview-btn").onclick = () => toggleOverview();

// ---------------------------------------------------------------- persistence of tabs and directories

let lastSaved = "";
async function persist() {
  const data = {
    active: Math.max(0, tabs.indexOf(activeTab)),
    tabs: tabs.map((t) => ({ panes: t.panes.map((p) => p.cwd) })),
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
await listen("pty-block", (e) => panes.get(e.payload.session)?.addBlock(e.payload));
await listen("pty-exit", (e) => {
  const p = panes.get(e.payload);
  if (p) closePane(p); // the shell ended, like closing a terminal window's last shell
});

// ---------------------------------------------------------------- start

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
    const dirs = t.panes?.length ? t.panes : [null];
    const tab = await newTab(dirs[0]);
    for (const cwd of dirs.slice(1)) await addPane(tab, cwd);
  }
  selectTab(tabs[Math.min(layout.active ?? 0, tabs.length - 1)]);
} else {
  await newTab(null);
}
