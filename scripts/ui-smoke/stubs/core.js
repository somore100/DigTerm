export class Channel { constructor() { this.onmessage = null; } }
let n = 0;
export const calls = (globalThis.__calls = []); // every invoke, so tests can check what the UI asked the backend to do
export async function invoke(cmd, args) {
  calls.push([cmd, args]);
  if (cmd === "pty_spawn") { n++; return { id: n, run_file: `/tmp/run${n}` }; }
  if (cmd === "home_dir" || cmd === "pty_cwd") return "/home/user";
  if (cmd === "path_info") return args.names.map((name) => ({ kind: name === "docs" ? "dir" : "text", path: `/home/user/${name}` }));
  if (cmd.startsWith("analyze_open")) return 10; // a viewer with ten lines
  if (cmd === "analyze_lines") return Array.from({ length: args.count }, (_, i) => globalThis.__lines?.[args.from + i] ?? `line ${args.from + i}`);
  return null;
}
