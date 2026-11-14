// "Run commands one by one": helpers for the queue (pure, no UI).

// One command per line; blank lines and # comments are skipped.
export function parseLines(text) {
  // other control characters (a pasted Ctrl+C, escape codes) are dropped: they would act as keystrokes, not text
  return text.split(/\r?\n/).map((l) => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim()).filter((l) => l && !l.startsWith("#"));
}

// Milliseconds until the queue starts. mode: "now" | "in" (value = minutes) | "at" (value = "HH:MM", today or tomorrow). null = invalid.
export function startDelayMs(mode, value, now = new Date()) {
  if (mode === "now") return 0;
  if (mode === "in") {
    const m = Number(value);
    return Number.isFinite(m) && m >= 0 && m <= 7 * 24 * 60 ? Math.round(m * 60000) : null;
  }
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (mode !== "at" || !t || Number(t[1]) > 23 || Number(t[2]) > 59) return null;
  const at = new Date(now);
  at.setHours(Number(t[1]), Number(t[2]), 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at - now;
}
