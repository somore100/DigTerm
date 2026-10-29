import { invoke } from "@tauri-apps/api/core";
import { maskCopy, loadMask, saveMask, MASK_KINDS } from "./mask.js";
import { copiedToast } from "./toast.js";
import { showContextMenu } from "./ctxmenu.js";

let ROW = 18;

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Highlighting is purely client-side and never touches the stored output.
const DEFAULTS = {
  on: true,
  err: "error, errors, fail, failed, failure, fatal, panic, crash, crashed, segfault, denied",
  warn: "warn, warning, warnings, deprecated",
  note: "",
  font: 13,
  wrap: true,
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
  let total;
  // whole-run view: optionally only the output of each command, without prompts and typed commands
  const hideCmd = !!block.whole && !!block.allRanges?.length && loadSettings().hideCmd;
  try {
    if (hideCmd) total = await invoke("analyze_open_ranges", { session: block.session, ranges: block.allRanges });
    else if (block.cmdRanges) total = await invoke("analyze_open_ranges", { session: block.session, ranges: block.cmdRanges });
    else if (block.importText !== undefined) total = await invoke("analyze_open_text", { text: block.importText });
    else if (block.run) total = await invoke("analyze_open_run", { name: block.run, start: block.start, end: block.end });
    else if (block.importPath) total = await invoke("analyze_open_file", { path: block.importPath });
    else total = await invoke("analyze_open", { session: block.session, start: block.start, end: block.end });
  } catch (err) {
    alert(String(err));
    return;
  }

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
        <option value="blocks">Fold repeated multi-line blocks</option>
        <option value="blocks-numbers">Fold repeated blocks (ignore numbers)</option>
        <option value="sev-err">Show only error lines</option>
        <option value="sev-warn">Show only warning + error lines</option>
      </select>
      <span class="an-sevnav" title="Jump between lines with error words (F8 / Shift+F8). Uses the filter's words; the filter above decides whether warnings count too.">
        <button class="an-prev-err">▲</button><button class="an-next-err">▼ Error</button>
      </span>
      <label class="an-toggle" title="Show only each command's output, without the prompts and typed commands" hidden><input type="checkbox" class="an-hide-cmd" /> Hide commands</label>
      <label class="an-toggle"><input type="checkbox" class="an-hl-on" /> Highlight</label>
      <label class="an-toggle" title="Show long lines as indented sub-lines instead of scrolling sideways"><input type="checkbox" class="an-wrap" /> Wrap long lines</label>
      <button class="an-hl-edit" title="Edit highlight words">Words…</button>
      <button class="an-patterns-btn" title="Group all lines by pattern">Patterns</button>
      <label class="an-toggle" title="Replace IP addresses, emails, user names and secrets with labels when copying (the output itself is not changed)"><input type="checkbox" class="an-mask-on" /> Mask on copy</label>
      <button class="an-mask-edit" title="Choose what is masked">Mask…</button>
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
    <div class="an-mask-panel" hidden></div>
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
  const wrapEl = root.querySelector(".an-wrap");
  wrapEl.checked = settings.wrap;
  const maskOn = root.querySelector(".an-mask-on");
  const maskPanel = root.querySelector(".an-mask-panel");
  {
    const m = loadMask();
    maskOn.checked = m.on;
    maskOn.onchange = () => saveMask({ ...loadMask(), on: maskOn.checked });
    for (const [k, text] of MASK_KINDS) {
      const l = document.createElement("label");
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = m[k];
      c.onchange = () => saveMask({ ...loadMask(), [k]: c.checked });
      l.append(c, ` ${text}`);
      maskPanel.append(l);
    }
    const hint = document.createElement("span");
    hint.className = "an-hint";
    hint.textContent = "applies to every Copy button · same value gets the same label · may hide a little too much";
    maskPanel.append(hint);
    root.querySelector(".an-mask-edit").onclick = () => { maskPanel.hidden = !maskPanel.hidden; };
  }
  const hideEl = root.querySelector(".an-hide-cmd");
  if (block.whole && block.allRanges?.length) {
    hideEl.parentElement.hidden = false;
    hideEl.checked = hideCmd;
    hideEl.onchange = () => {
      settings.hideCmd = hideEl.checked;
      saveSettings(settings);
      close();
      openAnalyze(block); // reopen with the new setting
    };
  }

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

  // --- long lines are shown as sub-lines; rows then differ in height, tracked as "extras"
  let lens = null; // UTF-16 length of every original line, loaded after the viewer opens
  let wrapOn = settings.wrap;
  let wrapW = Infinity; // characters per sub-line
  let ex = []; // [{v, n}] view rows that take n extra visual rows, sorted by v
  let exCum = []; // cumulative extra rows including each entry
  let visTotal = total;

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
    rebuildExtras();
    countEl.textContent = collapsed
      ? `${total.toLocaleString()} lines · ${viewTotal.toLocaleString()} after collapsing`
      : `${total.toLocaleString()} lines`;
    copyAllEl.textContent = collapsed ? "Copy all (collapsed)" : "Copy all";
  }

  function computeWrapW() {
    wrapW = wrapOn ? Math.max(30, Math.floor((body.clientWidth - 150) / charW)) : Infinity;
  }

  function rebuildExtras() {
    ex = [];
    exCum = [];
    if (wrapOn && lens && Number.isFinite(wrapW)) {
      const list = [];
      for (let L = 0; L < total; L++) {
        if (lens[L] <= wrapW) continue;
        const k = lastGroupAtOrBefore(eff, (m) => eff[m].first <= L);
        if (k >= 0 && L < eff[k].first + eff[k].count && (L !== eff[k].first || eff[k].summary)) continue;
        list.push({ v: viewOf(L), n: Math.ceil(lens[L] / wrapW) - 1 });
      }
      eff.forEach((g, k) => {
        if (g.summary && g.summary.length > wrapW) list.push({ v: vstart[k], n: Math.ceil(g.summary.length / wrapW) - 1 });
      });
      list.sort((a, b) => a.v - b.v);
      ex = list;
    }
    let c = 0;
    for (const e of ex) { c += e.n; exCum.push(c); }
    visTotal = viewTotal + c;
    spacer.style.height = `${visTotal * ROW + 28}px`;
  }

  function extraBefore(v) {
    const k = lastGroupAtOrBefore(ex, (m) => ex[m].v < v);
    return k < 0 ? 0 : exCum[k];
  }
  const yOfV = (v) => (v + extraBefore(v)) * ROW;
  function exN(v) {
    const k = lastGroupAtOrBefore(ex, (m) => ex[m].v <= v);
    return k >= 0 && ex[k].v === v ? ex[k].n : 0;
  }
  // which view row (and sub-line of it) is drawn at pixel height y
  function vAtY(y) {
    const r = Math.max(0, Math.floor(y / ROW));
    const k = lastGroupAtOrBefore(ex, (m) => ex[m].v + exCum[m] - ex[m].n <= r);
    if (k < 0) return { v: r, sub: 0 };
    const start = ex[k].v + exCum[k] - ex[k].n;
    if (r <= start + ex[k].n) return { v: ex[k].v, sub: r - start };
    return { v: r - exCum[k], sub: 0 };
  }

  function relayoutWrap() {
    const topLine = rowAt(vAtY(body.scrollTop).v).line;
    computeWrapW();
    rebuild();
    body.scrollTop = yOfV(viewOf(topLine));
    render();
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
    const first = Math.max(0, vAtY(body.scrollTop).v - 20);
    const last = Math.min(viewTotal, vAtY(body.scrollTop + body.clientHeight).v + 21);
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
      const nSub = wrapOn && lens && Number.isFinite(wrapW) && t.length > wrapW ? Math.ceil(t.length / wrapW) : 1;
      let inner = "";
      for (let j = 0; j < nSub; j++) {
        const start = nSub > 1 ? j * wrapW : 0;
        const chunk = nSub > 1 ? t.slice(start, start + wrapW) : t;
        const lastSub = j === nSub - 1;
        inner += `<div class="sl${j ? " cont" : ""}" data-sub="${j}"><span class="ln">${j ? "│" : r.line + 1}</span><span class="tx">${rowHtml(chunk, r.v, start, lastSub)}</span>${lastSub ? badge : ""}</div>`;
      }
      html += `<div class="${cls}" data-line="${r.line}" data-count="${r.count}" data-v="${r.v}">${inner}</div>`;
    }
    rows.style.top = `${yOfV(first)}px`;
    rows.innerHTML = html;
  }

  function segHtml(s) {
    return highlight ? highlight(esc(s)) : esc(s);
  }

  // Row text with the caret and any text selection drawn in; falls back to plain highlighted text.
  // `text` is one sub-line starting at column `start` of its row; `last` marks the final sub-line.
  function rowHtml(text, v, start = 0, last = true) {
    let c = -1;
    if (caret && caret.v === v) {
      const l = caret.col - start;
      if (l >= 0 && (l < text.length || (l === text.length && last))) c = l;
    }
    let from = -1, to = -1;
    if (tsel && v >= tsel.a.v && v <= tsel.b.v) {
      const a = v === tsel.a.v ? tsel.a.col : 0;
      const b = v === tsel.b.v ? tsel.b.col : Infinity;
      const f = Math.max(0, a - start);
      const t2 = Math.min(text.length, b - start);
      if (t2 > f) { from = f; to = t2; }
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
    const top = yOfV(v);
    const h = (1 + exN(v)) * ROW;
    if (top < body.scrollTop) body.scrollTop = top;
    else if (top + h > body.scrollTop + body.clientHeight) body.scrollTop = top + h - body.clientHeight;
  }

  // Arrow keys move the caret; at a line's end it wraps to the next or previous line.
  async function moveCaret(key, shift, ctrl) {
    if (!caret) { caret = { v: vAtY(body.scrollTop).v, col: 0 }; wantCol = 0; }
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
    body.scrollTop = Math.max(0, yOfV(viewOf(line)) - body.clientHeight / 2);
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
    await navigator.clipboard.writeText(maskCopy(await getText()));
    copiedToast();
    const old = button.textContent;
    button.textContent = loadMask().on ? "Copied (masked)" : "Copied";
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
    const sl = e.target.closest(".sl") ?? row.querySelector(".sl");
    const sub = Number(sl.dataset.sub || 0);
    const tx = sl.querySelector(".tx").getBoundingClientRect();
    const local = Math.max(0, Math.round((e.clientX - tx.left) / charW));
    const col = Math.max(0, Math.min(text.length, (sub ? sub * wrapW : 0) + local));
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

  // --- severity: lines with error / warning words (the highlight word lists), found by the backend
  let sev = null; // {err: [lines], warn: [lines]}, reset when the word lists change
  const wordList = (t) => t.split(",").map((w) => w.trim()).filter(Boolean);
  async function loadSeverity() {
    if (!sev) sev = await invoke("analyze_severity", { err: wordList(settings.err), warn: wordList(settings.warn) });
    return sev;
  }
  const sevLines = async (withWarn) => {
    const s = await loadSeverity();
    return withWarn ? [...s.err, ...s.warn].sort((a, b) => a - b) : s.err;
  };
  // everything between the kept lines becomes one collapsed row ("N lines hidden")
  function groupsAround(keep) {
    const out = [];
    const gap = (from, to) => {
      const n = to - from;
      if (n >= 2) out.push({ first: from, count: n, summary: `⋯ ${n.toLocaleString()} lines hidden` });
    };
    let prev = 0;
    for (const k of keep) { gap(prev, k); prev = k + 1; }
    gap(prev, total);
    return out;
  }

  async function stepSeverity(dir) {
    const lines = await sevLines(modeEl.value === "sev-warn");
    if (!lines.length) { matchesEl.textContent = "no error lines"; return; }
    const cur = caret ? rowAt(caret.v).line : -1;
    let next;
    if (dir > 0) next = lines.find((l) => l > cur) ?? lines[0];
    else next = [...lines].reverse().find((l) => l < cur) ?? lines[lines.length - 1];
    matchesEl.textContent = `line ${(next + 1).toLocaleString()} · ${lines.indexOf(next) + 1} / ${lines.length.toLocaleString()}`;
    jumpTo(next);
  }
  root.querySelector(".an-next-err").onclick = () => stepSeverity(1);
  root.querySelector(".an-prev-err").onclick = () => stepSeverity(-1);

  modeEl.addEventListener("change", async () => {
    const topLine = rowAt(vAtY(body.scrollTop).v).line;
    const mode = modeEl.value;
    if (mode.startsWith("sev-")) {
      modeEl.disabled = true;
      try { groupsByMode[mode] = groupsAround(await sevLines(mode === "sev-warn")); } finally { modeEl.disabled = false; }
    } else if (mode !== "off" && !groupsByMode[mode]) {
      modeEl.disabled = true;
      groupsByMode[mode] = await invoke("analyze_groups", { mode });
      modeEl.disabled = false;
    }
    collapsed = mode !== "off";
    groups = collapsed ? groupsByMode[mode] : [];
    expanded = new Set();
    rebuild();
    body.scrollTop = yOfV(viewOf(topLine));
    render();
  });

  wrapEl.addEventListener("change", () => {
    wrapOn = wrapEl.checked;
    settings.wrap = wrapOn;
    saveSettings(settings);
    relayoutWrap();
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
  root.addEventListener("contextmenu", (e) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return; // keep the native menu for typing fields
    e.preventDefault();
    const btn = root.querySelector(".an-copy-sel");
    const items = [];
    if (tsel) items.push(["Copy selection", () => copyText(btn, tselText)]);
    else if (sel) items.push(["Copy selection", () => copyText(btn, () => textFor(sel[0], sel[1] + 1))]);
    items.push([collapsed ? "Copy all (collapsed)" : "Copy all", () => copyText(copyAllEl, () => (collapsed ? collapsedText() : textFor(0, total)))]);
    showContextMenu(e.clientX, e.clientY, items);
  });
  copyAllEl.onclick = (e) => copyText(e.target, () => (collapsed ? collapsedText() : textFor(0, total)));

  function refreshHighlight() {
    settings.on = hlOn.checked;
    for (const k of ["err", "warn", "note"]) settings[k] = root.querySelector(`.hl-${k}`).value;
    saveSettings(settings);
    highlight = buildHighlighter(settings);
    render();
    // the error/warning word lists also define the severity lines: refresh them shortly after typing stops
    clearTimeout(sevTimer);
    sevTimer = setTimeout(() => {
      sev = null;
      delete groupsByMode["sev-err"];
      delete groupsByMode["sev-warn"];
      if (modeEl.value.startsWith("sev-")) modeEl.dispatchEvent(new Event("change"));
    }, 600);
  }
  let sevTimer = 0;
  hlOn.addEventListener("change", refreshHighlight);
  hlPanel.addEventListener("input", refreshHighlight);
  root.querySelector(".an-hl-edit").onclick = () => { hlPanel.hidden = !hlPanel.hidden; };

  function zoom(delta) {
    const topLine = rowAt(vAtY(body.scrollTop).v).line;
    settings.font = delta === 0 ? DEFAULTS.font : Math.min(32, Math.max(8, settings.font + delta));
    saveSettings(settings);
    applyFont();
    measureChar();
    computeWrapW();
    rebuild();
    body.scrollTop = yOfV(viewOf(topLine));
    render();
  }
  root.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  const close = () => { resizeObs.disconnect(); root.remove(); document.removeEventListener("keydown", onKey); };
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
    if (e.key === "F8") { e.preventDefault(); stepSeverity(e.shiftKey ? -1 : 1); }
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

  // Dragging selected text would start the browser's drag-and-drop ghost; the viewer has no use for it.
  root.addEventListener("dragstart", (e) => e.preventDefault());

  // Copying a mouse selection: build the text from the rows ourselves so every row ends in a newline
  // (also folded rows) and line numbers and "×N" badges are left out.
  body.addEventListener("copy", (e) => {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return;
    const range = s.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) return;
    const part = (el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
      return r.toString();
    };
    const lines = [];
    for (const row of rows.querySelectorAll(".row")) {
      if (!range.intersectsNode(row)) continue;
      lines.push([...row.querySelectorAll(".tx")].filter((t) => range.intersectsNode(t)).map(part).join(""));
    }
    if (!lines.length) return;
    e.clipboardData.setData("text/plain", maskCopy(lines.join("\n")));
    copiedToast();
    e.preventDefault();
  });

  // the sub-line width follows the viewer's width
  const resizeObs = new ResizeObserver(() => {
    const before = wrapW;
    computeWrapW();
    if (before !== wrapW) relayoutWrap();
  });
  resizeObs.observe(body);

  measureChar();
  computeWrapW();
  rebuild();
  render();
  searchEl.focus();
  invoke("analyze_lengths")
    .then((buf) => {
      lens = new Uint32Array(buf);
      relayoutWrap();
    })
    .catch(() => {});
}
