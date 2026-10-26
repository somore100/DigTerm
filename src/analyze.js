import { invoke } from "@tauri-apps/api/core";

const ROW = 18;
const ERR = /\b(error|errors|fail|failed|failure|fatal|panic|segfault|denied)\b/i;
const WARN = /\b(warn|warning|warnings|deprecated)\b/i;

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function openAnalyze(block) {
  const total = await invoke("analyze_open", { start: block.start, end: block.end });

  const root = document.createElement("div");
  root.id = "analyze";
  root.innerHTML = `
    <div class="an-bar">
      <strong>Command #${block.id}</strong>
      <span class="an-count">${total.toLocaleString()} lines</span>
      <input class="an-search" placeholder="Search (Enter = next, Shift+Enter = previous)" />
      <span class="an-matches"></span>
      <input class="an-goto" placeholder="Go to line" size="8" />
      <button class="an-copy-sel">Copy selection</button>
      <button class="an-copy-all">Copy all</button>
      <button class="an-close">Close</button>
    </div>
    <div class="an-body"><div class="an-spacer"></div><div class="an-rows"></div></div>`;
  document.body.append(root);

  const body = root.querySelector(".an-body");
  const spacer = root.querySelector(".an-spacer");
  const rows = root.querySelector(".an-rows");
  const searchEl = root.querySelector(".an-search");
  const matchesEl = root.querySelector(".an-matches");
  const gotoEl = root.querySelector(".an-goto");
  spacer.style.height = `${total * ROW}px`;

  const cache = new Map();
  let matches = [];
  let matchSet = new Set();
  let matchIdx = -1;
  let lastQuery = null;
  let anchor = null;
  let sel = null; // [from, to] inclusive
  let token = 0;

  async function fetchLines(from, to) {
    const lines = await invoke("analyze_lines", { from, count: to - from });
    lines.forEach((t, i) => cache.set(from + i, t));
  }

  async function render() {
    const my = ++token;
    const first = Math.max(0, Math.floor(body.scrollTop / ROW) - 20);
    const last = Math.min(total, Math.ceil((body.scrollTop + body.clientHeight) / ROW) + 20);
    let missing = false;
    for (let i = first; i < last; i++) if (!cache.has(i)) { missing = true; break; }
    if (missing) {
      if (cache.size > 20000) cache.clear();
      await fetchLines(first, last);
      if (my !== token) return;
    }
    const cur = matchIdx >= 0 ? matches[matchIdx] : -1;
    let html = "";
    for (let i = first; i < last; i++) {
      const t = cache.get(i) ?? "";
      let cls = "row";
      if (ERR.test(t)) cls += " err";
      else if (WARN.test(t)) cls += " warn";
      if (matchSet.has(i)) cls += i === cur ? " cur" : " hit";
      if (sel && i >= sel[0] && i <= sel[1]) cls += " sel";
      html += `<div class="${cls}" data-n="${i}"><span class="ln">${i + 1}</span><span class="tx">${esc(t)}</span></div>`;
    }
    rows.style.top = `${first * ROW}px`;
    rows.innerHTML = html;
  }

  function jumpTo(line) {
    body.scrollTop = Math.max(0, line * ROW - body.clientHeight / 2);
    render();
  }

  async function textFor(from, to) {
    const parts = [];
    for (let i = from; i < to; i += 20000) {
      parts.push(...(await invoke("analyze_lines", { from: i, count: Math.min(20000, to - i) })));
    }
    return parts.join("\n");
  }

  async function copy(button, from, to) {
    await navigator.clipboard.writeText(await textFor(from, to));
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
    const n = Number(row.dataset.n);
    if (e.shiftKey && anchor !== null) sel = [Math.min(anchor, n), Math.max(anchor, n)];
    else { anchor = n; sel = [n, n]; }
    render();
  });
  searchEl.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const q = searchEl.value;
    if (!q) { matches = []; matchSet = new Set(); matchIdx = -1; lastQuery = null; matchesEl.textContent = ""; render(); return; }
    if (q !== lastQuery) {
      matches = await invoke("analyze_search", { query: q, caseSensitive: false });
      matchSet = new Set(matches);
      matchIdx = -1;
      lastQuery = q;
      if (!matches.length) { matchesEl.textContent = "no matches"; render(); return; }
    }
    step(e.shiftKey ? -1 : 1);
  });
  gotoEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const n = Math.min(total, Math.max(1, parseInt(gotoEl.value, 10) || 1)) - 1;
    anchor = n; sel = [n, n];
    jumpTo(n);
  });
  root.querySelector(".an-copy-sel").onclick = (e) => {
    if (sel) copy(e.target, sel[0], sel[1] + 1);
  };
  root.querySelector(".an-copy-all").onclick = (e) => copy(e.target, 0, total);

  const close = () => { root.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.ctrlKey && e.shiftKey && e.code === "KeyC" && sel && !window.getSelection().toString()) {
      copy(root.querySelector(".an-copy-sel"), sel[0], sel[1] + 1);
    }
  };
  document.addEventListener("keydown", onKey);
  root.querySelector(".an-close").onclick = close;

  render();
  searchEl.focus();
}
