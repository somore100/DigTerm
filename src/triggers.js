// Output triggers ("when this text appears in the output, tell me"). Pure helpers, no UI. For now the only action is
// to notify: a message, a mark on the tab, and a desktop notification if the system allows it. A trigger never runs a
// command, because text printed by a program must not be able to start one.
const KEY = "digterm.triggers";
const MAX_LINE = 2000; // longer lines are cut before matching, so a pattern cannot stall the window
const COOLDOWN_MS = 5000; // the same trigger fires at most this often per terminal

export function loadTriggers() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list.map(normalizeTrigger).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function saveTriggers(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
}

// Nested repeats such as (a+)+ can take forever on some text; refuse the obvious forms.
export function riskyRegex(src) {
  return /\([^)]*[+*}][^)]*\)[+*{]/.test(src) || /(\.\*){3,}/.test(src);
}

/** Cleans one trigger; null when it has no usable pattern. */
export function normalizeTrigger(t) {
  if (!t || typeof t !== "object") return null;
  const text = String(t.text ?? "").trim().slice(0, 200);
  if (!text || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) return null;
  const regex = !!t.regex;
  if (regex) {
    if (riskyRegex(text)) return null;
    try { new RegExp(text); } catch { return null; }
  }
  return {
    id: String(t.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    text,
    regex,
    caseless: t.caseless !== false,
    on: t.on !== false,
  };
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

function compile(t) {
  return t.regex ? new RegExp(t.text, t.caseless ? "i" : "") : null;
}

/** Whether one line of text matches a trigger. */
export function matches(t, line, re = compile(t)) {
  if (re) return re.test(line);
  return t.caseless ? line.toLowerCase().includes(t.text.toLowerCase()) : line.includes(t.text);
}

/** Per-terminal watcher: feed it the raw bytes, it returns the triggers that fired. */
export class Watcher {
  constructor(getTriggers) {
    this.get = getTriggers;
    this.dec = new TextDecoder("utf-8");
    this.rest = "";
    this.last = new Map(); // trigger id -> time it last fired
    this.cache = new Map(); // trigger id -> [text, compiled regex]
  }

  feed(bytes, now = Date.now()) {
    const list = this.get().filter((t) => t.on);
    if (!list.length) { this.rest = ""; return []; }
    const text = this.rest + this.dec.decode(bytes, { stream: true }).replace(ANSI, "");
    const lines = text.split(/\r\n|\n|\r/);
    this.rest = lines.pop().slice(-MAX_LINE);
    const hits = [];
    for (const raw of lines) {
      const line = raw.slice(0, MAX_LINE);
      if (!line) continue;
      for (const t of list) {
        if (now - (this.last.get(t.id) ?? -Infinity) < COOLDOWN_MS) continue;
        let re = null;
        if (t.regex) {
          const c = this.cache.get(t.id);
          re = c && c[0] === t.text + t.caseless ? c[1] : compile(t);
          this.cache.set(t.id, [t.text + t.caseless, re]);
        }
        if (matches(t, line, re)) {
          this.last.set(t.id, now);
          hits.push({ trigger: t, line: line.trim().slice(0, 160) });
        }
      }
    }
    return hits;
  }
}
