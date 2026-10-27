export class Channel { constructor() { this.onmessage = null; } }
let n = 0;
export async function invoke(cmd) {
  if (cmd === "pty_spawn") { n++; return { id: n, run_file: `/tmp/run${n}` }; }
  if (cmd === "home_dir" || cmd === "pty_cwd") return "/home/user";
  return null;
}
