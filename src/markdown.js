// Small Markdown renderer for the viewer's Formatted mode. It builds DOM nodes with textContent only (never innerHTML), so
// nothing in the file can run script. Images are shown as their alt text (nothing is loaded from the internet) and links
// carry no href: a click calls opts.openUrl, and only for http(s) addresses.
// Covers headings, paragraphs, **bold**, *italic*, ~~strike~~, `code`, fenced code, lists (nested), quotes, rules, tables, links.

const el = (tag, cls) => Object.assign(document.createElement(tag), cls ? { className: cls } : {});
const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\s][^*]*)\*|(?<![A-Za-z0-9])_([^_\s][^_]*)_(?![A-Za-z0-9])|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<)]+)/g;

function link(text, url, opts) {
  const a = el("a", "md-link");
  a.title = url;
  if (typeof text === "string") a.textContent = text; else a.append(text);
  a.onclick = (e) => {
    e.preventDefault();
    if (/^https?:\/\//i.test(url) && opts.openUrl) opts.openUrl(url);
  };
  return a;
}

export function inline(text, parent, opts = {}, depth = 0) {
  let pos = 0;
  const put = (s) => { if (s) parent.append(document.createTextNode(s)); };
  for (const m of text.matchAll(INLINE)) {
    put(text.slice(pos, m.index));
    pos = m.index + m[0].length;
    if (m[2] !== undefined) parent.append(Object.assign(el("code"), { textContent: m[2].replace(/^ (.*) $/, "$1") }));
    else if (m[4] !== undefined) put(`[image: ${m[3] || m[4]}]`);
    else if (m[6] !== undefined) { const f = document.createDocumentFragment(); depth < 4 ? inline(m[5], f, opts, depth + 1) : put(m[5]); parent.append(link(f, m[6], opts)); }
    else if (m[7] !== undefined || m[8] !== undefined || m[9] !== undefined || m[10] !== undefined || m[11] !== undefined) {
      const tag = m[9] !== undefined ? "del" : m[7] !== undefined || m[8] !== undefined ? "strong" : "em";
      const node = el(tag);
      const inner = m[7] ?? m[8] ?? m[9] ?? m[10] ?? m[11];
      depth < 4 ? inline(inner, node, opts, depth + 1) : (node.textContent = inner);
      parent.append(node);
    } else if (m[12] !== undefined) parent.append(link(m[12], m[12], opts));
    else if (m[13] !== undefined) parent.append(link(m[13], m[13], opts));
  }
  put(text.slice(pos));
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const startsBlock = (l, next) => FENCE.test(l) || HEAD.test(l) || RULE.test(l) || QUOTE.test(l) || ITEM.test(l) || (l.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-"));

export function renderMarkdown(text, opts = {}) {
  const root = document.createDocumentFragment();
  blocks(text.replace(/\r\n?/g, "\n").split("\n"), root, opts, 0);
  return root;
}

function blocks(lines, out, opts, depth) {
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = FENCE.exec(l))) {
      const fence = m[1];
      const code = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) code.push(lines[i++]);
      i++;
      const pre = el("pre", "md-code");
      if (m[2]) pre.dataset.lang = m[2];
      pre.append(Object.assign(el("code"), { textContent: code.join("\n") }));
      out.append(pre);
    } else if ((m = HEAD.exec(l))) {
      const h = el("h" + m[1].length);
      inline(m[2], h, opts);
      out.append(h);
      i++;
    } else if (RULE.test(l)) {
      out.append(el("hr"));
      i++;
    } else if (QUOTE.test(l) && depth < 6) {
      const q = [];
      while (i < lines.length && QUOTE.test(lines[i])) q.push(QUOTE.exec(lines[i++])[1]);
      const bq = el("blockquote");
      blocks(q, bq, opts, depth + 1);
      out.append(bq);
    } else if (ITEM.test(l)) {
      i = list(lines, i, out, opts, depth);
    } else if (l.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const table = el("table", "md-table");
      const head = cells(l);
      const tr = table.createTHead().insertRow();
      for (const c of head) { const th = document.createElement("th"); inline(c, th, opts); tr.append(th); }
      const tb = table.createTBody();
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        const r = tb.insertRow();
        for (const c of cells(lines[i++])) inline(c, r.insertCell(), opts);
      }
      out.append(table);
    } else {
      const para = [l.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].trim());
      const p = el("p");
      inline(para.join(" "), p, opts);
      out.append(p);
    }
  }
}

// A list starting at lines[i]; nested lists follow the indentation. Returns the index after the list.
function list(lines, i, out, opts, depth) {
  const base = ITEM.exec(lines[i])[1].length;
  const ordered = /\d/.test(ITEM.exec(lines[i])[2]);
  const ul = el(ordered ? "ol" : "ul");
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length < base) break;
    if (m[1].length > base) {
      if (!ul.lastChild || depth > 8) break;
      i = list(lines, i, ul.lastChild, opts, depth + 1);
      continue;
    }
    const li = el("li");
    const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
    if (task) { const cb = Object.assign(el("input"), { type: "checkbox", disabled: true, checked: task[1] !== " " }); li.append(cb, document.createTextNode(" ")); inline(task[2], li, opts); }
    else inline(m[3], li, opts);
    i++;
    // continuation lines of the item (indented, not a new item)
    while (i < lines.length && lines[i].trim() && /^\s/.test(lines[i]) && !ITEM.test(lines[i])) { li.append(document.createTextNode(" ")); inline(lines[i++].trim(), li, opts); }
    ul.append(li);
    while (i < lines.length && !lines[i].trim() && i + 1 < lines.length && ITEM.test(lines[i + 1]) && ITEM.exec(lines[i + 1])[1].length >= base) i++; // blank line inside a list
  }
  out.append(ul);
  return i;
}
