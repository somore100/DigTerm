export const channels = (globalThis.__channels = []); // one per terminal, so tests can push output in
export class Channel { constructor() { this.onmessage = null; channels.push(this); } }
let n = 0;
export const calls = (globalThis.__calls = []); // every invoke, so tests can check what the UI asked the backend to do
export async function invoke(cmd, args) {
  calls.push([cmd, args]);
  if (cmd === "pty_spawn") { n++; return { id: n, run_file: `/tmp/run${n}` }; }
  if (cmd === "home_dir" || cmd === "pty_cwd") return "/home/user";
  if (cmd === "path_info") return args.names.map((name) => ({ kind: name === "docs" ? "dir" : "text", path: `/home/user/${name}`, safe: !/^unsafe/.test(name) }));
  if (cmd.startsWith("analyze_open")) return 10; // a viewer with ten lines
  if (cmd === "read_text_file") return { text: /\.md$/.test(args.path) ? "# Title\n\nSome **bold** and a [link](https://example.com) and `x`.\n\n- one\n  - nested\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n<b>code</b>\n```\n\n![pic](http://evil/x.png)" : "hello\r\nworld", stamp: "1-1" };
  if (cmd === "write_text_file") return "2-2";
  if (cmd === "system_info") return [["OS", "TestOS"], ["RAM", "16.0 GB"]];
  if (cmd === "list_runs" && globalThis.__runs) return globalThis.__runs;
  if (cmd === "list_runs") { const now = Math.floor(Date.now() / 1000); return [{ name: "run-a.raw", size: 5000, modified: now - 60, open: false }, { name: "run-b.raw", size: 9000000, modified: now - 40 * 86400, open: false }, { name: "run-c.raw", size: 200000, modified: now - 3 * 86400, open: false }]; }
  if (cmd === "scan_run" && globalThis.__emptyRuns?.includes(args?.name)) return [];
  if (cmd === "scan_run") return [[{ id: 1, lines: 3, exit: 0, start: 0, end: 5, cmd_start: 0, ms: 0 }, "ls -la"]];
  if (cmd === "delete_runs") return [args.names.length, 1000];
  if (cmd === "read_block" && args.start === 7777) return "one 12:00:01\ntwo\nsame\n";
  if (cmd === "read_block" && args.start === 8888) return "one 13:30:00\nTWO\nsame\nextra\n";
  if (cmd === "session_len") return globalThis.__sessionLen ?? null;
  if (cmd === "analyze_extend") return globalThis.__extendTo ?? 10;
  if (cmd === "analyze_groups") return globalThis.__groups ?? null;
  if (cmd === "analyze_lines") return Array.from({ length: args.count }, (_, i) => globalThis.__lines?.[args.from + i] ?? `line ${args.from + i}`);
  return null;
}
