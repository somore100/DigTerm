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
  const total = await invoke("analyze_open", { start: block.start, end: block.end });

  const root = document.createElement("div");
  root.id = "analyze";
  root.innerHTML = `
    <div class="an-bar">
      <strong>Command #${block.id}</strong>
      <span class="an-count"></span>
      <input class="an-search" placeholder="Search (Enter = next, Shift+Enter = previous)" />
      <span class="an-matches"></span>
      <input class="an-goto" placeholder="Go to line" size="8" />
      <label class="an-toggle"><input type="checkbox" class="an-collapse" /> Collapse repeats</label>
      <label class="an-toggle"><input type="checkbox" class="an-hl-on" /> Highlight</label>
      <button class="an-hl-edit" title="Edit highlight words">Words…</button>
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
    <div class="an-body"><div class="an-spacer"></div><div class="an-rows"></div></div>`;
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
  const collapseEl = root.querySelector(".an-collapse");
  const copyAllEl = root.querySelector(".an-copy-all");

  const cache = new Map();
  let matches = [];
  let matchIdx = -1;
  let lastQuery = null;
  let anchor = null; // [firstLine, lastLine] of the clicked row
  let sel = null; // [firstLine, lastLine] original lines, inclusive
  let token = 0;

  // --- collapsed view model: runs of identical consecutive lines shown as one row ---
  let groups = null; // [{first, count}], loaded on first use
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
    if (vstart[k] === v) return { line: eff[k].first, count: eff[k].count };
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
    for (let v = first; v < last; v++) infos.push(rowAt(v));

    const need = infos.map((r) => r.line).filter((l) => !cache.has(l));
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
      const t = cache.get(r.line) ?? "";
      const end = r.line + r.count - 1;
      let cls = "row";
      if (matches.length && hasMatchIn(r.line, end)) cls += cur >= r.line && cur <= end ? " cur" : " hit";
      if (sel && r.line <= sel[1] && end >= sel[0]) cls += " sel";
      const badge = r.count > 1 ? `<span class="rep" title="Click to expand">×${r.count.toLocaleString()}</span>` : "";
      html += `<div class="${cls}" data-line="${r.line}" data-count="${r.count}"><span class="ln">${r.line + 1}</span><span class="tx">${highlight ? highlight(esc(t)) : esc(t)}</span>${badge}</div>`;
    }
    rows.style.top = `${first * ROW}px`;
    rows.innerHTML = html;
  }

  function jumpTo(line) {
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
      const [line] = await invoke("analyze_lines", { from: g.first, count: 1 });
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
    const span = [line, line + count - 1];
    if (e.shiftKey && anchor) sel = [Math.min(anchor[0], span[0]), Math.max(anchor[1], span[1])];
    else { anchor = span; sel = span; }
    render();
  });

  collapseEl.addEventListener("change", async () => {
    const topLine = rowAt(Math.floor(body.scrollTop / ROW)).line;
    if (collapseEl.checked && !groups) {
      groups = (await invoke("analyze_groups")).map(([first, count]) => ({ first, count }));
    }
    collapsed = collapseEl.checked;
    expanded = new Set();
    rebuild();
    body.scrollTop = viewOf(topLine) * ROW;
    render();
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
    if (sel) copyText(e.target, () => textFor(sel[0], sel[1] + 1));
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
  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.ctrlKey && !e.shiftKey && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoom(1); }
    if (e.ctrlKey && !e.shiftKey && e.key === "-") { e.preventDefault(); zoom(-1); }
    if (e.ctrlKey && !e.shiftKey && e.key === "0") { e.preventDefault(); zoom(0); }
    if (e.ctrlKey && e.shiftKey && e.code === "KeyC" && sel && !window.getSelection().toString()) {
      copyText(root.querySelector(".an-copy-sel"), () => textFor(sel[0], sel[1] + 1));
    }
  };
  document.addEventListener("keydown", onKey);
  root.querySelector(".an-close").onclick = close;

  rebuild();
  render();
  searchEl.focus();
}
