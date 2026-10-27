import { invoke } from "@tauri-apps/api/core";

let ROW = 18;

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Highlighting is purely client-side and never touches the stored output.
const DEFAULTS = {
  on: true,
  err: "error, errors, fail, failed, failure, fatal, panic, crash, crashed, segfault, denied",
  warn: "warn, warning, warnings, deprecated",
  note: "",
  font: 13,
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("digterm.viewer") || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem("digterm.viewer", JSON.stringify(s));
  } catch {}
}

const reEsc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildHighlighter(s) {
  if (!s.on) return null;
  const map = new Map();
  // later entries win, so errors beat warnings beat notes when a word is in several lists
  for (const [list, cls] of [[s.note, "note"], [s.warn, "warn"], [s.err, "err"]]) {
    for (const w of list.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) map.set(w, cls);
  }
  if (!map.size) return null;
  const words = [...map.keys()].sort((a, b) => b.length - a.length).map(reEsc);
  const re = new RegExp(`\\b(${words.join("|")})\\b`, "gi");
  return (escaped) => escaped.replace(re, (m) => `<mark class="w-${map.get(m.toLowerCase())}">${m}</mark>`);
}

export async function openAnalyze(block) {
  const total = await invoke("analyze_open", { session: block.session, start: block.start, end: block.end });

  const root = document.createElement("div");
  root.id = "analyze";
  root.innerHTML = `
    <div class="an-bar">
      <strong>${block.label ?? `Command #${block.id}`}</strong>
      <span class="an-count"></span>
      <input class="an-search" placeholder="Search (Enter = next, Shift+Enter = previous)" />
      <span class="an-matches"></span>
      <input class="an-goto" placeholder="Go to line" size="8" />
      <select class="an-mode" title="Fold repeated lines (view only)">
        <option value="off">No folding</option>
        <option value="exact">Fold exact repeats</option>
        <option value="numbers">Fold repeats + number patterns</option>
        <option value="fields">Fold repeats + word/field patterns</option>
      </select>
      <label class="an-toggle"><input type="checkbox" class="an-hl-on" /> Highlight</label>
      <button class="an-hl-edit" title="Edit highlight words">Words…</button>
      <button class="an-patterns-btn" title="Group all lines by pattern">Patterns</button>
      <button class="an-copy-sel">Copy selection</button>
      <button class="an-copy-all">Copy all</button>
      <button class="an-close">Close</button>
    </div>
    <div class="an-hl-panel" hidden>
      <label>Errors <input class="hl-err" /></label>
      <label>Warnings <input class="hl-warn" /></label>
      <label>Your words <input class="hl-note" placeholder="e.g. timeout, retry" /></label>
      <span class="an-hint">comma-separated, whole words, not case sensitive · Ctrl +/− zooms</span>
    </div>
    <div class="an-main"><div class="an-body"><div class="an-spacer"></div><div class="an-rows"></div></div><aside class="an-patterns" hidden></aside></div>`;
  document.body.append(root);

  const settings = loadSettings();
  let highlight = buildHighlighter(settings);
  const hlOn = root.querySelector(".an-hl-on");
  const hlPanel = root.querySelector(".an-hl-panel");
  hlOn.checked = settings.on;
  for (const k of ["err", "warn", "note"]) root.querySelector(`.hl-${k}`).value = settings[k];

  function applyFont() {
    ROW = Math.round(settings.font * 1.4);
    root.style.setProperty("--an-font", `${settings.font}px`);
    root.style.setProperty("--row", `${ROW}px`);
  }
  applyFont();

  const body = root.querySelector(".an-body");
  const spacer = root.querySelector(".an-spacer");
  const rows = root.querySelector(".an-rows");
  const searchEl = root.querySelector(".an-search");
  const matchesEl = root.querySelector(".an-matches");
  const gotoEl = root.querySelector(".an-goto");
  const countEl = root.querySelector(".an-count");
  const modeEl = root.querySelector(".an-mode");
  const patBtn = root.querySelector(".an-patterns-btn");
  const patEl = root.querySelector(".an-patterns");
  const copyAllEl = root.querySelector(".an-copy-all");

  const cache = new Map();
  let matches = [];
  let matchIdx = -1;
  let lastQuery = null;
  let anchor = null; // [firstLine, lastLine] of the clicked row
  let sel = null; // [firstLine, lastLine] original lines, inclusive
  let token = 0;
  let caret = null; // {v, col}: keyboard caret, in view rows
  let tpos = null; // anchor while selecting text with Shift
  let tsel = null; // {a, b} ordered text selection
  let wantCol = 0;
  let charW = 8;
  let moving = Promise.resolve();

  // --- collapsed view model: runs of identical consecutive lines shown as one row ---
  const groupsByMode = {}; // mode -> [{first, count, summary}], loaded on first use
  let groups = [];
  let collapsed = false;
  let expanded = new Set();
  let eff = []; // active (collapsed) groups
  let cum = []; // cumulative lines removed up to and including group k
  let vstart = []; // view index of group k's row
  let viewTotal = total;

  function rebuild() {
    eff = collapsed ? groups.filter((g) => !expanded.has(g.first)) : [];
    cum = [];
    vstart = [];
    let removed = 0;
    for (const g of eff) {
      vstart.push(g.first - removed);
      removed += g.count - 1;
      cum.push(removed);
    }
    viewTotal = total - removed;
    spacer.style.height = `${viewTotal * ROW}px`;
    countEl.textContent = collapsed
      ? `${total.toLocaleString()} lines · ${viewTotal.toLocaleString()} after collapsing`
      : `${total.toLocaleString()} lines`;
    copyAllEl.textContent = collapsed ? "Copy all (collapsed)" : "Copy all";
  }

  function lastGroupAtOrBefore(arr, key) {
    let lo = 0, hi = arr.length - 1, k = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (key(m)) { k = m; lo = m + 1; } else hi = m - 1;
    }
    return k;
  }

  function rowAt(v) {
    const k = lastGroupAtOrBefore(eff, (m) => vstart[m] <= v);
    if (k < 0) return { line: v, count: 1 };
    if (vstart[k] === v) return { line: eff[k].first, count: eff[k].count, summary: eff[k].summary };
    return { line: v + cum[k], count: 1 };
  }

  function viewOf(line) {
    const k = lastGroupAtOrBefore(eff, (m) => eff[m].first <= line);
    if (k < 0) return line;
    if (line < eff[k].first + eff[k].count) return vstart[k];
    return line - cum[k];
  }

  function hasMatchIn(a, b) {
    let lo = 0, hi = matches.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (matches[m] < a) lo = m + 1; else hi = m;
    }
    return lo < matches.length && matches[lo] <= b;
  }

  async function fetchLines(from, to) {
    const lines = await invoke("analyze_lines", { from, count: to - from });
    lines.forEach((t, i) => cache.set(from + i, t));
  }

  async function render() {
    const my = ++token;
    const first = Math.max(0, Math.floor(body.scrollTop / ROW) - 20);
    const last = Math.min(viewTotal, Math.ceil((body.scrollTop + body.clientHeight) / ROW) + 20);
    const infos = [];
    for (let v = first; v < last; v++) infos.push({ ...rowAt(v), v });

    const need = infos.filter((r) => !r.summary).map((r) => r.line).filter((l) => !cache.has(l));
    if (need.length) {
      if (cache.size > 20000) cache.clear();
      let runStart = need[0], prev = need[0];
      for (let i = 1; i <= need.length; i++) {
        if (i === need.length || need[i] !== prev + 1) {
          await fetchLines(runStart, prev + 1);
          if (i < need.length) { runStart = need[i]; prev = need[i]; }
        } else prev = need[i];
      }
      if (my !== token) return;
    }

    const cur = matchIdx >= 0 ? matches[matchIdx] : -1;
    let html = "";
    for (const r of infos) {
      const t = r.summary ?? cache.get(r.line) ?? "";
      const end = r.line + r.count - 1;
      let cls = "row";
      if (matches.length && hasMatchIn(r.line, end)) cls += cur >= r.line && cur <= end ? " cur" : " hit";
      if (sel && r.line <= sel[1] && end >= sel[0]) cls += " sel";
      const badge = r.count > 1 ? `<span class="rep" title="Click to expand">×${r.count.toLocaleString()}</span>` : "";
      html += `<div class="${cls}" data-line="${r.line}" data-count="${r.count}" data-v="${r.v}"><span class="ln">${r.line + 1}</span><span class="tx">${rowHtml(t, r.v)}</span>${badge}</div>`;
    }
    rows.style.top = `${first * ROW}px`;
    rows.innerHTML = html;
  }

  function segHtml(s) {
    return highlight ? highlight(esc(s)) : esc(s);
  }

  // Row text with the caret and any text selection drawn in; falls back to plain highlighted text.
  function rowHtml(text, v) {
    const c = caret && caret.v === v ? Math.min(caret.col, text.length) : -1;
    let from = -1, to = -1;
    if (tsel && v >= tsel.a.v && v <= tsel.b.v) {
      from = v === tsel.a.v ? Math.min(tsel.a.col, text.length) : 0;
      to = v === tsel.b.v ? Math.min(tsel.b.col, text.length) : text.length;
    }
    if (c < 0 && from < 0) return segHtml(text);
    const pts = [...new Set([0, text.length, ...(c >= 0 ? [c] : []), ...(from >= 0 ? [from, to] : [])])].sort((x, y) => x - y);
    let html = "";
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p === c) html += '<span class="caret"></span>';
      const q = pts[i + 1];
      if (q === undefined) break;
      const seg = text.slice(p, q);
      html += from >= 0 && p >= from && q <= to ? `<span class="tsel">${segHtml(seg)}</span>` : segHtml(seg);
    }
    return html;
  }

  function measureChar() {
    const probe = document.createElement("span");
    probe.className = "tx";
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    probe.textContent = "M".repeat(100);
    rows.append(probe);
    charW = probe.getBoundingClientRect().width / 100 || 8;
    probe.remove();
  }

  async function textOfView(v) {
    const r = rowAt(v);
    if (r.summary) return r.summary;
    if (!cache.has(r.line)) await fetchLines(r.line, r.line + 1);
    return cache.get(r.line) ?? "";
  }

  const textSync = (v) => {
    const r = rowAt(v);
    return r.summary ?? cache.get(r.line) ?? "";
  };
  const cmpPos = (p, q) => p.v - q.v || p.col - q.col;

  function setTextSel(anchorPos) {
    const c = cmpPos(anchorPos, caret);
    tpos = anchorPos;
    tsel = c === 0 ? null : c < 0 ? { a: anchorPos, b: caret } : { a: caret, b: anchorPos };
    sel = null;
  }

  function ensureVisible(v) {
    const top = v * ROW;
    if (top < body.scrollTop) body.scrollTop = top;
    else if (top + ROW > body.scrollTop + body.clientHeight) body.scrollTop = top + ROW - body.clientHeight;
  }

  // Arrow keys move the caret; at a line's end it wraps to the next or previous line.
  async function moveCaret(key, shift, ctrl) {
    if (!caret) { caret = { v: Math.floor(body.scrollTop / ROW), col: 0 }; wantCol = 0; }
    const start = { ...caret };
    let { v, col } = caret;
    const len = async (x) => (await textOfView(x)).length;
    const page = Math.max(1, Math.floor(body.clientHeight / ROW) - 1);
    switch (key) {
      case "ArrowLeft":
        if (col > 0) col--;
        else if (v > 0) { v--; col = await len(v); }
        wantCol = col;
        break;
      case "ArrowRight": {
        const l = await len(v);
        if (col < l) col++;
        else if (v < viewTotal - 1) { v++; col = 0; }
        wantCol = col;
        break;
      }
      case "ArrowUp": if (v > 0) { v--; col = Math.min(wantCol, await len(v)); } break;
      case "ArrowDown": if (v < viewTotal - 1) { v++; col = Math.min(wantCol, await len(v)); } break;
      case "PageUp": v = Math.max(0, v - page); col = Math.min(wantCol, await len(v)); break;
      case "PageDown": v = Math.min(viewTotal - 1, v + page); col = Math.min(wantCol, await len(v)); break;
      case "Home": if (ctrl) v = 0; col = 0; wantCol = 0; break;
      case "End": if (ctrl) v = viewTotal - 1; col = await len(v); wantCol = col; break;
    }
    caret = { v, col };
    if (shift) setTextSel(tpos ?? start);
    else {
      tpos = null;
      tsel = null;
      const r = rowAt(v);
      sel = [r.line, r.line + r.count - 1];
      anchor = sel;
    }
    ensureVisible(v);
    render();
  }

  async function tselText() {
    const { a, b } = tsel;
    if (!collapsed) {
      const lines = (await textFor(a.v, b.v + 1)).split("\n");
      if (a.v === b.v) return lines[0].slice(a.col, b.col);
      lines[0] = lines[0].slice(a.col);
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, b.col);
      return lines.join("\n");
    }
    const out = [];
    for (let v = a.v; v <= b.v; v++) {
      const t = await textOfView(v);
      out.push(t.slice(v === a.v ? a.col : 0, v === b.v ? b.col : t.length));
    }
    return out.join("\n");
  }

  function jumpTo(line) {
    caret = { v: viewOf(line), col: 0 };
    wantCol = 0;
    body.scrollTop = Math.max(0, viewOf(line) * ROW - body.clientHeight / 2);
    render();
  }

  async function textFor(from, to) {
    const parts = [];
    for (let i = from; i < to; i += 20000) {
      parts.push(...(await invoke("analyze_lines", { from: i, count: Math.min(20000, to - i) })));
    }
    return parts.join("\n");
  }

  async function collapsedText() {
    const parts = [];
    let cursor = 0;
    for (const g of eff) {
      if (g.first > cursor) parts.push(await textFor(cursor, g.first));
      const line = g.summary ?? (await invoke("analyze_lines", { from: g.first, count: 1 }))[0];
      parts.push(`${line}  ×${g.count}`);
      cursor = g.first + g.count;
    }
    if (cursor < total) parts.push(await textFor(cursor, total));
    return parts.join("\n");
  }

  async function copyText(button, getText) {
    await navigator.clipboard.writeText(await getText());
    const old = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = old), 1200);
  }

  function step(dir) {
    if (!matches.length) return;
    matchIdx = (matchIdx + dir + matches.length) % matches.length;
    matchesEl.textContent = `${matchIdx + 1} / ${matches.length.toLocaleString()}`;
    jumpTo(matches[matchIdx]);
  }

  body.addEventListener("scroll", render);
  body.addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    const line = Number(row.dataset.line);
    const count = Number(row.dataset.count);
    if (e.target.classList.contains("rep")) {
      expanded.add(line);
      rebuild();
      render();
      return;
    }
    const v = Number(row.dataset.v);
    const text = textSync(v);
    const tx = row.querySelector(".tx").getBoundingClientRect();
    const col = Math.max(0, Math.min(text.length, Math.round((e.clientX - tx.left) / charW)));
    const hadCaret = !!caret;
    const before = caret ? { ...caret } : { v, col };
    caret = { v, col };
    wantCol = col;
    if (e.shiftKey && hadCaret) {
      setTextSel(tpos ?? before);
    } else {
      tpos = null;
      tsel = null;
      const span = [line, line + count - 1];
      anchor = span;
      sel = span;
    }
    render();
  });

  modeEl.addEventListener("change", async () => {
    const topLine = rowAt(Math.floor(body.scrollTop / ROW)).line;
    const mode = modeEl.value;
    if (mode !== "off" && !groupsByMode[mode]) {
      modeEl.disabled = true;
      groupsByMode[mode] = await invoke("analyze_groups", { mode });
      modeEl.disabled = false;
    }
    collapsed = mode !== "off";
    groups = collapsed ? groupsByMode[mode] : [];
    expanded = new Set();
    rebuild();
    body.scrollTop = viewOf(topLine) * ROW;
    render();
  });

  // --- patterns: every line grouped by shape (numbers replaced), across the whole output
  let patterns = null;
  function renderPatterns() {
    patEl.replaceChildren();
    const head = document.createElement("div");
    head.className = "pat-head";
    head.textContent = `${patterns.length.toLocaleString()} patterns · click one to step through its lines`;
    patEl.append(head);
    patterns.forEach((p, i) => {
      const row = document.createElement("div");
      row.className = "pat";
      row.dataset.i = i;
      const count = document.createElement("span");
      count.className = "pc";
      count.textContent = `${p.count.toLocaleString()}×`;
      const tmpl = document.createElement("span");
      tmpl.className = "pt";
      const shown = p.template === "" ? "(empty line)" : p.template.replace(/#/g, "⟨#⟩");
      tmpl.innerHTML = segHtml(shown);
      row.title = `first at line ${p.first + 1}, last at line ${p.last + 1}`;
      row.append(count, tmpl);
      patEl.append(row);
    });
  }
  patBtn.onclick = async () => {
    patEl.hidden = !patEl.hidden;
    if (!patEl.hidden && !patterns) {
      patEl.textContent = "Scanning…";
      patterns = await invoke("analyze_patterns");
      renderPatterns();
    }
  };
  patEl.addEventListener("click", async (e) => {
    const row = e.target.closest(".pat");
    if (!row) return;
    const p = patterns[Number(row.dataset.i)];
    matches = await invoke("analyze_pattern_lines", { template: p.template });
    matchIdx = -1;
    lastQuery = null;
    searchEl.value = "";
    if (!matches.length) { matchesEl.textContent = "no lines"; render(); return; }
    step(1);
  });

  searchEl.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const q = searchEl.value;
    if (!q) { matches = []; matchIdx = -1; lastQuery = null; matchesEl.textContent = ""; render(); return; }
    if (q !== lastQuery) {
      matches = await invoke("analyze_search", { query: q, caseSensitive: false });
      matchIdx = -1;
      lastQuery = q;
      if (!matches.length) { matchesEl.textContent = "no matches"; render(); return; }
    }
    step(e.shiftKey ? -1 : 1);
  });
  gotoEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const n = Math.min(total, Math.max(1, parseInt(gotoEl.value, 10) || 1)) - 1;
    anchor = [n, n]; sel = [n, n];
    jumpTo(n);
  });
  root.querySelector(".an-copy-sel").onclick = (e) => {
    if (tsel) copyText(e.target, tselText);
    else if (sel) copyText(e.target, () => textFor(sel[0], sel[1] + 1));
  };
  copyAllEl.onclick = (e) => copyText(e.target, () => (collapsed ? collapsedText() : textFor(0, total)));

  function refreshHighlight() {
    settings.on = hlOn.checked;
    for (const k of ["err", "warn", "note"]) settings[k] = root.querySelector(`.hl-${k}`).value;
    saveSettings(settings);
    highlight = buildHighlighter(settings);
    render();
  }
  hlOn.addEventListener("change", refreshHighlight);
  hlPanel.addEventListener("input", refreshHighlight);
  root.querySelector(".an-hl-edit").onclick = () => { hlPanel.hidden = !hlPanel.hidden; };

  function zoom(delta) {
    const topLine = rowAt(Math.floor(body.scrollTop / ROW)).line;
    settings.font = delta === 0 ? DEFAULTS.font : Math.min(32, Math.max(8, settings.font + delta));
    saveSettings(settings);
    applyFont();
    measureChar();
    rebuild();
    body.scrollTop = viewOf(topLine) * ROW;
    render();
  }
  root.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  const close = () => { root.remove(); document.removeEventListener("keydown", onKey); };
  const NAV = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
  const onKey = (e) => {
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
    if (!typing && !e.altKey && NAV.has(e.key) && (!e.ctrlKey || e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      moving = moving.then(() => moveCaret(e.key, e.shiftKey, e.ctrlKey));
    }
    if (!typing && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "c" && tsel && !window.getSelection().toString()) {
      copyText(root.querySelector(".an-copy-sel"), tselText);
    }
    if (e.key === "Escape") close();
    if (e.ctrlKey && !e.shiftKey && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoom(1); }
    if (e.ctrlKey && !e.shiftKey && e.key === "-") { e.preventDefault(); zoom(-1); }
    if (e.ctrlKey && !e.shiftKey && e.key === "0") { e.preventDefault(); zoom(0); }
    if (e.ctrlKey && e.shiftKey && e.code === "KeyC" && !window.getSelection().toString()) {
      if (tsel) copyText(root.querySelector(".an-copy-sel"), tselText);
      else if (sel) copyText(root.querySelector(".an-copy-sel"), () => textFor(sel[0], sel[1] + 1));
    }
  };
  document.addEventListener("keydown", onKey);
  root.querySelector(".an-close").onclick = close;

  measureChar();
  rebuild();
  render();
  searchEl.focus();
}
