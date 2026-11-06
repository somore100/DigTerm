// "Did you mean": after a command fails as "not found", suggest a fix for its first word. Pure functions, no UI.
// Only words we know are ever changed; anything unknown is left alone.
import { COMMANDS } from "./cmddict.js";

const EXTRA = ["git", "npm", "npx", "node", "yarn", "pnpm", "python", "python3", "pip", "pip3", "cargo", "rustc", "docker", "kubectl",
  "systemctl", "journalctl", "sudo", "ssh", "scp", "rsync", "curl", "wget", "make", "grep", "sed", "awk", "tar", "zip", "unzip",
  "ls", "cd", "pwd", "cat", "cp", "mv", "rm", "mkdir", "touch", "clear", "echo", "head", "tail", "find", "which", "man", "nano", "vim",
  "top", "htop", "ps", "kill", "df", "du", "free", "ping", "dnf", "apt", "brew", "chmod", "chown", "less", "sort", "diff", "history"];

export const KNOWN = new Set([...EXTRA, ...COMMANDS.map((r) => r[1].split(/\s+/)[0])]);

// commands that can destroy data: never run automatically
const DANGEROUS = new Set(["rm", "dd", "mkfs", "shred", "kill", "killall", "chmod", "chown", "mv", "del", "taskkill", "rmdir", "format"]);

// Windows word -> Linux/macOS command
const WIN_TO_UNIX = { dir: "ls", cls: "clear", type: "cat", copy: "cp", move: "mv", ren: "mv", del: "rm", tasklist: "ps aux", taskkill: "kill",
  ipconfig: "ip a", where: "which", findstr: "grep", notepad: "nano", start: "xdg-open", rmdir: "rm -r", md: "mkdir", fc: "diff" };
const UNIX_TO_WIN = { ls: "dir", clear: "cls", cat: "type", cp: "copy", mv: "move", rm: "del", ps: "tasklist", kill: "taskkill", which: "where",
  grep: "findstr", nano: "notepad", touch: "type nul >", pwd: "cd", diff: "fc", "xdg-open": "start" };

// Damerau-Levenshtein (adjacent swaps count as one edit, so "gti" is one away from "git")
export function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

export const LEVELS = { high: 0.85, medium: 0.7, low: 0.55 };

// -> { fixed, kind: "translate" | "typo", confidence: 0..1, safe } or null
export function suggest(cmdLine, win = false, known = KNOWN) {
  const m = /^(\s*)(\S+)([\s\S]*)$/.exec(cmdLine);
  if (!m) return null;
  const [, , word, rest] = m;
  if (/[/\\=$~.]/.test(word) || known.has(word.toLowerCase()) && !(win ? UNIX_TO_WIN : WIN_TO_UNIX)[word.toLowerCase()]) return null;
  const table = win ? UNIX_TO_WIN : WIN_TO_UNIX;
  const t = table[word.toLowerCase()];
  if (t) {
    const flags = /^\s+-/.test(rest); // flags differ between systems, so the translation may not behave the same
    return { fixed: t + rest, kind: "translate", confidence: flags ? 0.6 : 0.95, safe: !DANGEROUS.has(word.toLowerCase()) && !DANGEROUS.has(t.split(" ")[0]) };
  }
  const w = word.toLowerCase();
  if (w.length < 3) return null;
  const max = w.length <= 4 ? 1 : 2;
  let best = [], bd = max + 1;
  for (const k of known) {
    if (Math.abs(k.length - w.length) > max) continue;
    const d = distance(w, k);
    if (d < bd) { bd = d; best = [k]; } else if (d === bd) best.push(k);
  }
  if (bd > max || best.length !== 1) return null; // ties are not guessed
  const confidence = Math.max(0, 1 - bd / (w.length + 2)) * (bd === 1 ? 1 : 0.9);
  return { fixed: best[0] + rest, kind: "typo", confidence, safe: !DANGEROUS.has(best[0]) };
}
