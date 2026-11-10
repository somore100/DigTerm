// Comparing two outputs: line normalisation, a line diff, and the side-by-side view.

const TIME = [
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, // 2026-11-09 12:30:01.123Z
  /\b[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\b/g, // Nov  9 12:30:01
  /\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, // 12:30:01
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{2}\/\d{2}\/\d{4}\b/g,
];
const ID = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // uuid
  /\b0x[0-9a-f]+\b/gi,
  /\b[0-9a-f]{12,}\b/gi, // long hashes, container ids
];

// What a line counts as when comparing. times: dates and clock times; numbers: every number (also hides ids like pids).
export function normalizeLine(line, { times = true, numbers = false } = {}) {
  let s = line;
  if (times) {
    for (const re of TIME) s = s.replace(re, "‹time›");
    for (const re of ID) s = s.replace(re, "‹id›");
  }
  if (numbers) s = s.replace(/\d+/g, "#");
  return s;
}

const MAX_CELLS = 12_000_000;

// Line diff of two arrays of lines (a = left, b = right). `key` maps a line to what is compared.
// Returns { rows: [{ k: "same" | "chg" | "del" | "add", l?, r?, li?, ri? }], tooBig } where l/r are the original lines
// and li/ri their 0-based line numbers. A run of removed lines followed by added lines is shown as changed pairs.
export function diffLines(a, b, key = (x) => x) {
  const ka = a.map(key), kb = b.map(key);
  let lo = 0;
  while (lo < ka.length && lo < kb.length && ka[lo] === kb[lo]) lo++;
  let ea = ka.length, eb = kb.length;
  while (ea > lo && eb > lo && ka[ea - 1] === kb[eb - 1]) { ea--; eb--; }
  const n = ea - lo, m = eb - lo;
  if (n * m > MAX_CELLS) return { rows: [], tooBig: true };
  const ops = [];
  for (let i = 0; i < lo; i++) ops.push(["=", i, i]);
  // longest common subsequence of the middle part
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = ka[lo + i] === kb[lo + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ka[lo + i] === kb[lo + j]) { ops.push(["=", lo + i, lo + j]); i++; j++; }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) ops.push(["-", lo + i++, -1]);
    else ops.push(["+", -1, lo + j++]);
  }
  while (i < n) ops.push(["-", lo + i++, -1]);
  while (j < m) ops.push(["+", -1, lo + j++]);
  for (let k = 0; k < a.length - ea; k++) ops.push(["=", ea + k, eb + k]);

  const rows = [];
  for (let p = 0; p < ops.length;) {
    if (ops[p][0] === "=") { rows.push({ k: "same", l: a[ops[p][1]], r: b[ops[p][2]], li: ops[p][1], ri: ops[p][2] }); p++; continue; }
    const dels = [], adds = [];
    while (p < ops.length && ops[p][0] !== "=") { (ops[p][0] === "-" ? dels : adds).push(ops[p]); p++; }
    for (let q = 0; q < Math.max(dels.length, adds.length); q++) {
      const d = dels[q], ad = adds[q];
      rows.push({ k: d && ad ? "chg" : d ? "del" : "add", l: d ? a[d[1]] : undefined, r: ad ? b[ad[2]] : undefined, li: d?.[1], ri: ad?.[2] });
    }
  }
  return { rows, tooBig: false };
}

// A line split into pieces for the word-level view: dates, times and ids stay whole when they are being ignored.
function tokens(line, times) {
  const src = (times ? [...TIME, ...ID].map((r) => r.source + "|") : []).join("");
  return line.match(new RegExp(src + "\\w+|\\s+|[^\\w\\s]", "gi")) ?? [];
}

// Which pieces of a changed line pair differ: { l: [[text, changed]], r: [[text, changed]] }, or null for very long lines.
export function wordDiff(left, right, opts = { times: true, numbers: false }) {
  const ta = tokens(left, opts.times), tb = tokens(right, opts.times);
  if (ta.length * tb.length > 250_000) return null;
  const { rows, tooBig } = diffLines(ta, tb, (x) => normalizeLine(x, opts));
  if (tooBig) return null;
  const l = [], r = [];
  for (const row of rows) {
    if (row.k === "same") { l.push([row.l, false]); r.push([row.r, false]); continue; }
    if (row.l !== undefined) l.push([row.l, true]);
    if (row.r !== undefined) r.push([row.r, true]);
  }
  return { l, r };
}

const MAX_ROWS = 3000;

// Fills `body` with the comparison of two texts. Built with textContent only.
export function renderCompare(body, a, b, labelA, labelB) {
  const split = (t) => t.replace(/\r/g, "").replace(/\n$/, "").split("\n");
  const la = split(a), lb = split(b);
  const times = Object.assign(document.createElement("input"), { type: "checkbox", checked: true });
  const numbers = Object.assign(document.createElement("input"), { type: "checkbox", checked: false });
  const only = Object.assign(document.createElement("input"), { type: "checkbox", checked: false });
  const mkLabel = (box, text) => { const l = document.createElement("label"); l.className = "cmp-opt"; l.append(box, " " + text); return l; };
  const summary = Object.assign(document.createElement("span"), { className: "cmp-sum" });
  const next = Object.assign(document.createElement("button"), { textContent: "Next difference ▼" });
  const bar = document.createElement("div");
  bar.className = "cmp-bar";
  bar.append(mkLabel(times, "Ignore dates, times and ids"), mkLabel(numbers, "Ignore all numbers"), mkLabel(only, "Only differences"), summary, next);
  const head = document.createElement("div");
  head.className = "cmp-head";
  head.append(Object.assign(document.createElement("span"), { textContent: labelA, title: labelA }), Object.assign(document.createElement("span"), { textContent: labelB, title: labelB }));
  const grid = document.createElement("div");
  grid.className = "cmp";
  body.append(bar, head, grid);
  let cur = -1;

  const render = () => {
    const key = (x) => normalizeLine(x, { times: times.checked, numbers: numbers.checked });
    const { rows, tooBig } = diffLines(la, lb, key);
    grid.replaceChildren();
    cur = -1;
    if (tooBig) { summary.textContent = "Too different or too long to compare line by line (limit reached)."; return; }
    const diffs = rows.filter((r) => r.k !== "same").length;
    summary.textContent = diffs ? `${diffs.toLocaleString()} differing rows` : "No differences";
    const shown = only.checked ? rows.filter((r) => r.k !== "same") : rows;
    const opts = { times: times.checked, numbers: numbers.checked };
    for (const r of shown.slice(0, MAX_ROWS)) {
      const words = r.k === "chg" ? wordDiff(r.l, r.r, opts) : null;
      for (const [side, text, n] of [["l", r.l, r.li], ["r", r.r, r.ri]]) {
        const cell = document.createElement("div");
        cell.className = `cmp-cell ${r.k}${r.k !== "same" && text === undefined ? " gap" : ""}${r.k === "same" ? "" : " diff"}`;
        cell.dataset.side = side;
        const num = Object.assign(document.createElement("span"), { className: "cmp-n", textContent: n === undefined ? "" : String(n + 1) });
        const sign = Object.assign(document.createElement("span"), { className: "cmp-s", textContent: text === undefined || r.k === "same" ? "" : side === "l" ? "−" : "+" });
        const line = document.createElement("span");
        if (words) for (const [piece, changed] of words[side]) {
          if (changed) line.append(Object.assign(document.createElement("span"), { className: "w", textContent: piece }));
          else line.append(piece);
        } else line.textContent = text ?? "";
        cell.append(num, sign, line);
        grid.append(cell);
      }
    }
    if (shown.length > MAX_ROWS) grid.append(Object.assign(document.createElement("div"), { className: "cmp-more", textContent: `Showing the first ${MAX_ROWS.toLocaleString()} of ${shown.length.toLocaleString()} rows. Tick "Only differences" to narrow it.` }));
  };
  next.onclick = () => {
    const cells = [...grid.querySelectorAll('.cmp-cell.diff[data-side="l"]')];
    if (!cells.length) return;
    cur = (cur + 1) % cells.length;
    cells[cur].scrollIntoView({ block: "center" });
    grid.querySelectorAll(".cur").forEach((c) => c.classList.remove("cur"));
    cells[cur].classList.add("cur");
    cells[cur].nextElementSibling?.classList.add("cur");
  };
  for (const el of [times, numbers, only]) el.onchange = render;
  render();
}
