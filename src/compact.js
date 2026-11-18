// Compact view: shorter display text for noisy output. View-only; the saved output is never changed.
const PATH_RE = /(?<![\w:/.~@-])(?:~|\.{1,2})?\/[\w.@+%~-]+(?:\/[\w.@+%~-]+)+/g;
const MIN_PREFIX = 12; // folder prefixes shorter than this are not worth an alias
const MIN_COUNT = 4; // ... nor are folders that appear fewer times
const MAX_ALIASES = 6;
const TOKEN_MAX = 40;

// Runs of spaces and tabs become one space (indentation at the start of a line stays).
export function squeezeSpaces(t) {
  const lead = /^\s*/.exec(t)[0];
  return lead + t.slice(lead.length).replace(/[ \t]{2,}/g, " ");
}

// Very long words (hashes, base64, long ids) keep their start and end: abcdefghijklmnopqr…stuvwxyz0123
export function shortenTokens(t) {
  return t.replace(new RegExp(`\\S{${TOKEN_MAX + 1},}`, "g"), (s) => `${s.slice(0, 18)}…${s.slice(-14)}`);
}

// Folders that start many paths in `lines` get a short tag, e.g. ⟨1⟩ = /home/me/project
export function pickAliases(lines) {
  const counts = new Map();
  for (const l of lines) {
    for (const m of l.matchAll(PATH_RE)) {
      const segs = m[0].split("/"); // the last one is the file name
      let p = segs[0]; // "" for absolute paths, "~" or "." for relative ones
      for (let i = 1; i < segs.length - 1; i++) {
        p += "/" + segs[i];
        if (p.length >= MIN_PREFIX) counts.set(p, (counts.get(p) ?? 0) + 1);
      }
    }
  }
  const cands = [...counts]
    .filter(([, c]) => c >= MIN_COUNT)
    .map(([prefix, c]) => ({ prefix, save: c * (prefix.length - 3) }))
    .sort((a, b) => b.save - a.save);
  const out = [];
  for (const c of cands) {
    if (out.length >= MAX_ALIASES) break;
    if (out.some((o) => o.prefix.startsWith(c.prefix + "/") || c.prefix.startsWith(o.prefix + "/"))) continue;
    out.push({ prefix: c.prefix, tag: `⟨${out.length + 1}⟩` });
  }
  return out;
}

export function shortenPaths(t, aliases) {
  if (!aliases.length) return t;
  return t.replace(PATH_RE, (p) => {
    for (const a of aliases) if (p.startsWith(a.prefix + "/")) return a.tag + p.slice(a.prefix.length);
    return p;
  });
}

// A leading timestamp such as 2026-11-17T19:16:05.0638102Z becomes 19:16:05.06 (the date is shown once in a note).
// A time zone other than Z is kept. Lines that do not start with a timestamp are left alone.
const TIME_RE = /^(\[?)(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.,](\d+))?(Z|[+-]\d{2}:?\d{2})?/;
export function shortenTime(t, dropDate) {
  const m = TIME_RE.exec(t);
  if (!m) return t;
  const frac = m[4] ? "." + m[4].slice(0, 2) : "";
  const zone = m[5] && m[5] !== "Z" ? m[5] : "";
  return m[1] + (dropDate ? m[3] : `${m[2]} ${m[3]}`) + frac + zone + t.slice(m[0].length);
}

// The different dates (YYYY-MM-DD) that leading timestamps in `lines` show, in order of appearance (at most 4).
export function logDates(lines) {
  const seen = [];
  for (const l of lines) {
    const m = TIME_RE.exec(l);
    if (m && !seen.includes(m[2])) { seen.push(m[2]); if (seen.length > 3) break; }
  }
  return seen;
}

// opts: { spaces, tokens, paths, times } booleans; ctx.dropDate: leave the date out of timestamps
export function compactLine(t, opts, aliases, ctx = {}) {
  if (opts.times) t = shortenTime(t, !!ctx.dropDate);
  if (opts.paths) t = shortenPaths(t, aliases);
  if (opts.tokens) t = shortenTokens(t);
  if (opts.spaces) t = squeezeSpaces(t);
  return t;
}

// Tree view by minute: the time down to the minute is printed once, on the first line of each minute; the lines under
// it show only the seconds and are marked with a guide bar.
//   19:16 │ :05.06 [DEBUG]: one
//         │ :06.17 [DEBUG]: two
// `raws` are consecutive original lines; `prevRaw` is the line before them (or null). Lines without a timestamp stay in
// the current group. Needs the same options as compactLine; `ctx.dropDate` leaves the date out.
export function groupByMinute(raws, prevRaw, opts, aliases, ctx = {}) {
  const rest = { ...opts, times: false };
  const key = (m) => `${m[2]} ${m[3].slice(0, 5)}`;
  const pm = prevRaw === null ? null : TIME_RE.exec(prevRaw);
  let cur = pm ? key(pm) : null;
  const width = ctx.dropDate ? 5 : 16;
  return raws.map((t) => {
    const m = TIME_RE.exec(t);
    let label = "", body;
    if (m) {
      const k = key(m);
      if (k !== cur) label = ctx.dropDate ? m[3].slice(0, 5) : k;
      cur = k;
      const frac = m[4] ? "." + m[4].slice(0, 2) : "";
      const zone = m[5] && m[5] !== "Z" ? m[5] : "";
      body = m[1] + m[3].slice(5) + frac + zone + compactLine(t.slice(m[0].length), rest, aliases, ctx);
    } else {
      body = compactLine(t, rest, aliases, ctx);
    }
    return `${label.padEnd(width)} │ ${body}`;
  });
}
