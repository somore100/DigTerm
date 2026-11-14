// Test of the MCP server against a fake data folder. Usage: npm run test:mcp
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digterm-mcp-"));
fs.mkdirSync(path.join(dir, "runs"));
const m = (s) => `\x1b]133;${s}\x07`;
const raw = [
  m("A"), "$ ", m("B"), "echo hi", m("C"), "hi\r\n", m("D;0"),
  m("A"), "$ ", m("B"), "\x1b[1mfalse\x1b[0m token=abc123secret", m("C"), "line1\r\nERROR boom\r\n\x1b[31mred\x1b[0m\r\nprogress 1\rprogress 2\r\n", m("D;1"),
  m("A"), "$ ", m("B"), "ls", m("C"), "a\r\nb\r\n", "-----BEGIN RSA PRIVATE KEY-----\nXXXX\n-----END RSA PRIVATE KEY-----\n",
].join("");
fs.writeFileSync(path.join(dir, "runs", "run-1700000000-1.raw"), raw);
fs.writeFileSync(path.join(dir, "runs", "notes.txt"), "not a run");
process.env.DIGTERM_DATA = dir;
const s = await import("./digterm-mcp.mjs");

const call = (name, args) => s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }).result;
const text = (r) => r.content[0].text;

assert.equal(s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }).result.serverInfo.name, "digterm");
assert.equal(s.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
assert.deepEqual(s.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }).result.tools.map((t) => t.name), ["list_runs", "list_commands", "read_output", "search"]);
assert.equal(s.handle({ jsonrpc: "2.0", id: 3, method: "bogus" }).error.code, -32601);

assert.match(text(call("list_runs", {})), /run-1700000000-1\.raw/);
assert.doesNotMatch(text(call("list_runs", {})), /notes/);
const cmds = text(call("list_commands", {}));
assert.match(cmds, /2 finished commands/);
assert.match(cmds, /#1  exit 0 .*"echo hi"/);
assert.match(cmds, /#2  exit 1 .*false/);
assert.doesNotMatch(cmds, /abc123secret/, "secret in a command is hidden");
assert.equal(text(call("read_output", { id: 1 })).split("\n").slice(-1)[0], "hi");
const out2 = text(call("read_output", { id: 2 }));
assert.match(out2, /ERROR boom/);
assert.match(out2, /\nred\n/, "colour codes removed");
assert.match(out2, /progress 2/);
assert.doesNotMatch(out2, /progress 1/, "carriage-return rewrite keeps the final text");
assert.match(text(call("read_output", { id: 2, from_line: 2, max_lines: 1 })), /lines 2-2 of 4; more: ask with from_line=3/);
assert.equal(call("read_output", { id: 99 }).isError, true);
assert.equal(call("read_output", { id: 1, run: "../../etc/passwd" }).isError, true);
assert.equal(call("read_output", { id: 1, run: "run-1-1.raw" }).isError, true);
assert.match(text(call("search", { query: "error" })), /#2 line 2 .*ERROR boom/);
assert.equal(text(call("search", { query: "zzz-none" })), "No matches.");
assert.equal(call("bogus", {}).isError, true);
// an unfinished command (no D marker) is not listed, and a private key in output is hidden
assert.doesNotMatch(text(call("list_commands", {})), /"ls"/);
const raw2 = raw + m("D;0");
fs.writeFileSync(path.join(dir, "runs", "run-1700000001-2.raw"), raw2);
assert.match(text(call("read_output", { id: 3, run: "run-1700000001-2.raw" })), /\[hidden private key\]/);
assert.doesNotMatch(text(call("read_output", { id: 3, run: "run-1700000001-2.raw" })), /XXXX/);

// over stdio, as a real client uses it
const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "digterm-mcp.mjs")], { env: process.env });
let got = "";
child.stdout.on("data", (d) => (got += d));
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\nnot json\n");
await new Promise((r) => setTimeout(r, 500));
child.kill();
const lines = got.trim().split("\n").map((l) => JSON.parse(l));
assert.equal(lines[0].result.tools.length, 4);
assert.equal(lines[1].error.code, -32700);
fs.rmSync(dir, { recursive: true });
console.log("mcp: all checks passed");
