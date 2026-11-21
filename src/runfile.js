// "Run": the command that runs a file, chosen by its extension (or by being an executable file).
// The command is typed into the active terminal and entered, so it is visible there. Used only when you click Run.
const UNIX = { py: "python3", sh: "bash", bash: "bash", zsh: "zsh", js: "node", mjs: "node", cjs: "node", rb: "ruby", pl: "perl", php: "php", lua: "lua", r: "Rscript", jl: "julia" };
const WIN = { py: "python", js: "node", mjs: "node", cjs: "node", rb: "ruby", pl: "perl", php: "php", lua: "lua", ps1: "powershell -NoProfile -File", bat: "", cmd: "", exe: "" };

// path: absolute path of the file. exec: it has the executable permission (from the backend).
// quote: shell quoting for the path. Returns the command text, or null when the file is not runnable.
export function runCommand(path, exec, isWin, quote) {
  const ext = (path.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
  if (ext === "jar") return `java -jar ${quote(path)}`;
  const table = isWin ? WIN : UNIX;
  if (Object.hasOwn(table, ext)) return `${table[ext] ? table[ext] + " " : ""}${quote(path)}`;
  if (!isWin && exec) return quote(path);
  return null;
}

// One line of selected text that can be run as typed (no control characters, not huge)
export function runnableSelection(text) {
  const t = String(text ?? "").replace(/[\r\n]+$/, "").trim();
  return t && t.length <= 500 && !/[\x00-\x1f\x7f]/.test(t) ? t : null;
}
