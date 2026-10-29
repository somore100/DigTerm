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

// opts: { spaces, tokens, paths } booleans
export function compactLine(t, opts, aliases) {
  if (opts.paths) t = shortenPaths(t, aliases);
  if (opts.tokens) t = shortenTokens(t);
  if (opts.spaces) t = squeezeSpaces(t);
  return t;
}
