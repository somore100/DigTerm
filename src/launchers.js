// Colour buttons: saved recipes (commands + folder + where to run) kept in localStorage. Pure helpers, no UI.
import { parseLines } from "./batch.js";

export const PALETTE = ["#7c3aed", "#2563eb", "#0891b2", "#16a34a", "#ca8a04", "#ea580c", "#dc2626", "#db2777"];
export const WHERE = [["tab", "In a new tab"], ["split", "In a new pane next to this one"], ["current", "In the current terminal"]];
const KEY = "digterm.buttons";

export function loadLaunchers() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list.map(normalize).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function saveLaunchers(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
}

// Cleans one recipe from the editor or from storage; null when it has no name or no command.
export function normalize(l) {
  if (!l || typeof l !== "object") return null;
  const name = String(l.name ?? "").trim().slice(0, 30);
  const commands = String(l.commands ?? "");
  if (!name || !parseLines(commands).length) return null;
  return {
    id: String(l.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    name,
    color: PALETTE.includes(l.color) ? l.color : PALETTE[0],
    cwd: String(l.cwd ?? "").trim(),
    commands,
    where: WHERE.some(([v]) => v === l.where) ? l.where : "tab",
  };
}
