// UI smoke test: runs the real src/main.js in a fake browser page (jsdom) with the Tauri and xterm.js
// modules stubbed out. It catches crashes such as a missing function when a menu opens.
// Usage: npm run test:ui
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "digterm-ui-")), "bundle.mjs");
const stub = (f) => path.join(here, "stubs", f);

await build({
  entryPoints: [path.join(root, "src/main.js")],
  bundle: true, format: "esm", target: "esnext", outfile: out, logLevel: "error",
  loader: { ".css": "empty" },
  alias: {
    "@tauri-apps/api/core": stub("core.js"),
    "@tauri-apps/api/event": stub("event.js"),
    "@tauri-apps/api/app": stub("app.js"),
    "@tauri-apps/api/window": stub("window.js"),
    "@xterm/addon-fit": stub("xterm.js"),
    "@xterm/addon-search": stub("xterm.js"),
  },
  plugins: [{
    name: "xterm-exact",
    setup(b) {
      b.onResolve({ filter: /^@xterm\/xterm$/ }, () => ({ path: stub("xterm.js") }));
      b.onResolve({ filter: /^@xterm\/xterm\/css/ }, () => ({ path: "x.css", namespace: "empty" }));
      b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
    },
  }],
});

const html = fs.readFileSync(path.join(root, "index.html"), "utf8").replace(/<script[^>]*><\/script>/, "");
const dom = new JSDOM(html, { pretendToBeVisual: true, url: "http://localhost/" });
const w = dom.window;
for (const k of ["window", "document", "localStorage", "navigator", "HTMLElement", "Node", "Option", "getComputedStyle", "requestAnimationFrame"]) {
  Object.defineProperty(globalThis, k, { value: k === "window" ? w : typeof w[k] === "function" ? w[k].bind(w) : w[k], configurable: true, writable: true });
}
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.matchMedia = w.matchMedia = () => ({ matches: false, addEventListener() {} });

const problems = [];
w.addEventListener("error", (e) => problems.push(e.error?.stack || e.message));
process.on("unhandledRejection", (e) => problems.push(`unhandled: ${e?.stack || e}`));

await import(pathToFileURL(out).href);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(100);

const press = (init) => document.dispatchEvent(new w.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
const menu = document.getElementById("menu");
const check = (cond, msg) => { if (!cond) problems.push(`check failed: ${msg}`); };

check(document.querySelectorAll(".tab-btn").length === 1, "one tab at start");
check(document.querySelectorAll(".pane").length === 1, "one pane at start");

// open the menu and click every entry (dialogs are closed again with Escape)
document.getElementById("menu-btn").click();
await wait(20);
check(!menu.hidden && menu.children.length > 5, "menu opens with entries");
const count = menu.querySelectorAll("button").length;
for (let i = 0; i < count; i++) {
  document.getElementById("menu-btn").click();
  menu.querySelectorAll("button")[i]?.click();
  await wait(20);
  if (!document.getElementById("dialog-host").hidden) press({ key: "Escape", code: "Escape" });
}

// feedback window: required fields, system information only when ticked, relay POST (fetch is stubbed: nothing is sent)
{
  const cfgFile = JSON.parse(fs.readFileSync(path.join(root, "feedback.json"), "utf8"));
  const posts = [];
  let answer = async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' });
  globalThis.fetch = async (url, init) => { posts.push([url, init]); return answer(); };
  document.getElementById("menu-btn").click();
  [...menu.querySelectorAll("button")].find((b) => /Leave feedback/.test(b.textContent))?.click();
  await wait(30);
  const fb = document.querySelector("#dialog-host .fb");
  check(fb, "the feedback window opens");
  if (fb) {
    const set = (sel, v) => { const el = fb.querySelector(sel); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
    const warnText = () => fb.querySelector(".fb-warn").textContent;
    check(cfgFile.endpoint && !fb.querySelector(".fb-send").hidden, "Send is offered when feedback.json has an endpoint");
    fb.querySelector(".fb-send").click();
    await wait(10);
    check(/title/i.test(warnText()), "feedback asks for a title");
    set(".fb-title", "abc");
    fb.querySelector(".fb-send").click();
    await wait(10);
    check(/too short/i.test(warnText()), "a very short title is refused");
    set(".fb-title", "UI is not working");
    fb.querySelector(".fb-send").click();
    await wait(10);
    check(/describe/i.test(warnText()), "feedback asks for a description");
    set(".fb-desc", "It froze");
    fb.querySelector(".fb-send").click();
    await wait(10);
    check(/too short/i.test(warnText()), "a very short description is refused");
    check(posts.length === 0, "nothing is posted while the form is invalid");
    set(".fb-desc", "The window froze right after startup");
    check(!/OS: TestOS/.test(fb.querySelector(".fb-preview pre").textContent), "no system information unless ticked");
    check(/\(not included\)/.test(fb.querySelector(".fb-preview pre").textContent), "the preview says system information is not included");
    const sys = fb.querySelector(".fb-sys");
    sys.checked = true;
    sys.dispatchEvent(new w.Event("change", { bubbles: true }));
    await wait(20);
    const preview = fb.querySelector(".fb-preview pre").textContent;
    check(/OS: TestOS/.test(preview) && /App version: 9\.9\.9/.test(preview), "ticking the box adds the system information to the preview");

    // a failing server: an error is shown and Send works again
    answer = async () => { throw new TypeError("offline"); };
    fb.querySelector(".fb-send").click();
    await wait(20);
    check(/Could not confirm/.test(warnText()) && !fb.querySelector(".fb-send").disabled, "a failed send shows an error and can be retried");
    answer = async () => ({ ok: false, status: 500, text: async () => "" });
    fb.querySelector(".fb-send").click();
    await wait(20);
    check(/answered 500/.test(warnText()), "a server error is reported");

    // success: the documented JSON payload goes to the configured endpoint
    answer = async () => ({ ok: true, status: 200, text: async () => '{"ok": true}' });
    posts.length = 0;
    fb.querySelector(".fb-send").click();
    await wait(20);
    const [url, init] = posts[0] ?? [];
    check(url === cfgFile.endpoint && init?.method === "POST", "Send posts to the endpoint from feedback.json");
    check(init?.headers?.["Content-Type"] === "text/plain;charset=utf-8", "the post is a simple text/plain request");
    const payload = init ? JSON.parse(init.body) : {};
    check(payload.to === cfgFile.to && payload.app === "Digterm" && payload.version === "9.9.9" && payload.type === "BUG", `payload has to, app, version, type: got ${JSON.stringify(payload).slice(0, 120)}`);
    check(payload.subject === "[Digterm] [BUG] UI is not working", `subject format: got ${payload.subject}`);
    check(payload.body?.startsWith("== FEEDBACK REPORT ==") && payload.body.includes("OS: TestOS") && payload.body.includes("The window froze right after startup"), "the body is the structured report with the system information");
    check(fb.querySelector(".fb-send").disabled && /Thank you/.test(fb.querySelector(".fb-note").textContent), "success is shown and Send is disabled");
    check(!/@|\/home\//.test(payload.body.split("== SYSTEM")[1] ?? ""), "the system section has no addresses or paths");

    // the fallback buttons still work
    fb.querySelector(".fb-mail").click();
    await wait(20);
    const call = globalThis.__calls.find(([c]) => c === "open_mailto");
    check(call && call[1].url.startsWith(`mailto:${cfgFile.to}?subject=%5BDigterm%5D%20%5BBUG%5D%20UI%20is%20not%20working&body=`), `feedback opens a mailto link: got ${call?.[1].url}`);
  }
  delete globalThis.fetch;
  press({ key: "Escape", code: "Escape" });
}

// shortcuts: split, zoom (terminal and all), zoom pane, overview, new tab
const chord = (code, key, mods) => press({ code, key, ...mods });
chord("KeyD", "D", { ctrlKey: true, shiftKey: true });
await wait(30);
chord("Equal", "=", { ctrlKey: true });
chord("Equal", "=", { ctrlKey: true, altKey: true });
chord("Digit0", "0", { ctrlKey: true, altKey: true });
chord("KeyZ", "Z", { ctrlKey: true, shiftKey: true });
chord("KeyZ", "Z", { ctrlKey: true, shiftKey: true });
chord("KeyO", "O", { ctrlKey: true, shiftKey: true });
chord("Escape", "Escape", {});
chord("KeyT", "T", { ctrlKey: true, shiftKey: true });
await wait(30);
check(document.querySelectorAll(".tab-btn").length >= 2, "new tab shortcut opens a tab");

// following a running command: the viewer grows with the output and stops at the command's final end
{
  const sid = globalThis.__calls.filter(([c]) => c === "pty_spawn").length;
  globalThis.__sessionLen = 1000;
  globalThis.__extendTo = 10;
  await globalThis.__events["pty-block-start"]({ payload: { session: sid, id: 40, cmd_start: 2000, start: 2010 } });
  const btn = [...document.querySelectorAll(".block-list li.running button")].pop();
  check(btn && /Follow/.test(btn.textContent), "a running command has a Follow button");
  btn?.click();
  await wait(40);
  const v = document.getElementById("analyze");
  check(v && !v.querySelector(".an-follow-wrap").hidden && v.querySelector(".an-mode").disabled, "following shows the Follow box and pauses folding");
  const open = globalThis.__calls.find(([c, a]) => c === "analyze_open" && a.start === 2010);
  check(open && open[1].end === 1000 && open[1].session === sid, "the viewer opens on the output so far");
  globalThis.__extendTo = 25;
  await wait(900); // one poll
  check(/25 lines/.test(v.querySelector(".an-count").textContent), `the viewer grows while the command runs: got ${v.querySelector(".an-count").textContent}`);
  check(globalThis.__calls.some(([c, a]) => c === "analyze_extend" && a.end === 1000), "each poll extends to the current length of the run file");
  globalThis.__extendTo = 30;
  await globalThis.__events["pty-block"]({ payload: { session: sid, id: 40, cmd_start: 2000, start: 2010, end: 1040, lines: 30, exit: 3, ms: 900 } });
  await wait(120);
  check(globalThis.__calls.some(([c, a]) => c === "analyze_extend" && a.end === 1040), "when the command ends the view is set to its exact final end");
  check(/finished · exit 3/.test(v.querySelector(".an-matches").textContent) && !v.querySelector(".an-mode").disabled && v.querySelector(".an-follow-wrap").hidden, "the viewer says it finished and folding comes back");
  const calls = globalThis.__calls.filter(([c]) => c === "analyze_extend").length;
  await wait(900);
  check(globalThis.__calls.filter(([c]) => c === "analyze_extend").length === calls, "polling stops after the command finished");
  v.querySelector(".an-close").click();
  globalThis.__sessionLen = undefined;
  globalThis.__extendTo = undefined;
}

// edit mode for small text files: off by default, saved only on request, .log files read-only
{
  const drop = async (file) => { await globalThis.__events["tauri://drag-drop"]({ payload: { paths: [file] } }); await wait(30); };
  const viewerEl = () => document.getElementById("analyze");
  await drop("/tmp/dt-notes.txt");
  let v = viewerEl();
  const box = v?.querySelector(".an-edit");
  check(v && !v.querySelector(".an-edit-wrap").hidden && !box.disabled, "a text file offers an Edit checkbox");
  check(v?.querySelector(".an-editor").hidden && v.querySelector(".an-save").hidden, "editing is off until the box is ticked");
  box.checked = true;
  box.dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(30);
  const ed = v.querySelector(".an-editor");
  check(!ed.hidden && ed.value === "hello\nworld", `ticking Edit shows the text in an editor: got ${JSON.stringify(ed.value)}`);
  ed.value = "hello\nWORLD";
  ed.dispatchEvent(new w.Event("input", { bubbles: true }));
  box.checked = false;
  box.dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(20);
  check(box.checked && !ed.hidden, "unticking with unsaved changes is refused");
  check(!globalThis.__calls.some(([c]) => c === "write_text_file"), "nothing is written before Save");
  v.querySelector(".an-save").click();
  await wait(30);
  const wr = globalThis.__calls.find(([c]) => c === "write_text_file");
  check(wr && wr[1].text === "hello\r\nWORLD" && wr[1].stamp === "1-1" && wr[1].path === "/tmp/dt-notes.txt", `Save writes the text with its original line endings and stamp: got ${JSON.stringify(wr?.[1])}`);
  const opens = globalThis.__calls.filter(([c]) => c === "analyze_open_file").length;
  box.checked = false;
  box.dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(40);
  check(globalThis.__calls.filter(([c]) => c === "analyze_open_file").length === opens + 1, "leaving edit mode after saving reopens the viewer on the new text");
  viewerEl()?.querySelector(".an-close").click();
  await drop("/tmp/server.log");
  v = viewerEl();
  check(v?.querySelector(".an-edit").disabled, "a .log file cannot be edited");
  v?.querySelector(".an-close").click();
}

// Hide: selected lines become black blocks in the rows and in copies, and can be shown again
{
  let copiedText = null;
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (t) => { copiedText = t; } }, configurable: true });
  globalThis.__lines = ["secret one", "public two"];
  await globalThis.__events["tauri://drag-drop"]({ payload: { paths: ["/tmp/hide-me.txt"] } });
  await wait(40);
  const v = document.getElementById("analyze");
  const rowText = (n) => v.querySelector(`.row[data-line="${n}"]`)?.textContent ?? "";
  const rightClick = async (el) => {
    el.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    await wait(20);
    return [...document.querySelectorAll(".ctx-menu button")];
  };
  const pick = async (items, re) => { items.find((b) => re.test(b.textContent))?.click(); await wait(30); };
  check(rowText(0).includes("secret one"), "the line is visible before hiding");
  v.querySelector('.row[data-line="0"] .tx').click(); // selects the line
  await wait(20);
  let items = await rightClick(v.querySelector('.row[data-line="0"]'));
  check(items.some((b) => /^Hide selection/.test(b.textContent)), "right-click on a selection offers Hide");
  await pick(items, /^Hide selection/);
  check(!rowText(0).includes("secret") && rowText(0).includes("██████████") && rowText(1).includes("public two"), `the hidden line is drawn as blocks, others stay: got ${JSON.stringify(rowText(0))}`);
  check(v.querySelector('.row[data-line="0"] .hid'), "hidden text is marked for black styling");
  check(!v.querySelector(".an-unhide-all").hidden, "a Show hidden button appears");
  v.querySelector(".an-copy-all").click();
  await wait(30);
  check(copiedText?.startsWith("██████████\npublic two") && !copiedText.includes("secret"), `copy gives blocks, never the hidden text: got ${JSON.stringify(copiedText?.slice(0, 40))}`);
  items = await rightClick(v.querySelector('.row[data-line="0"]'));
  check(items.some((b) => /Show hidden text on this line/.test(b.textContent)) && items.some((b) => /Show all hidden text \(1\)/.test(b.textContent)), "right-click on a hidden line offers to show it");
  await pick(items, /Show hidden text on this line/);
  check(rowText(0).includes("secret one") && v.querySelector(".an-unhide-all").hidden, "showing it again restores the text");
  v.querySelector(".an-close").click();
  globalThis.__lines = null;
}

// folder of the command that printed a line: the newest marker at or above the line wins
{
  const { cwdForLine } = await import(pathToFileURL(path.join(root, "src/folders.js")).href);
  const mk = (line, cwd, isDisposed = false) => ({ marker: { line, isDisposed }, cwd });
  const marks = [mk(10, "/a"), mk(20, "/b"), mk(30, null), mk(40, "/gone", true)];
  check(cwdForLine(marks, 5, "/now") === "/now", "output above every marker uses the current folder");
  check(cwdForLine(marks, 10, "/now") === "/a" && cwdForLine(marks, 19, "/now") === "/a", "output of the first command uses its folder");
  check(cwdForLine(marks, 25, "/now") === "/b", "output of a later command uses that command's folder");
  check(cwdForLine(marks, 35, "/now") === "/now", "a command whose folder is unknown falls back to the current folder");
  check(cwdForLine(marks, 99, "/now") === "/now", "markers scrolled out of the buffer are ignored");
  check(typeof globalThis.__osc?.[133] === "function", "each terminal listens for the command-start marker");
  const fake = globalThis.__osc[133];
  check(fake("A") === false && fake("C") === false, "the marker handler never swallows the sequence");
}

// a command that has started shows as "running" until its finished block arrives
{
  const sid = globalThis.__calls.filter(([c]) => c === "pty_spawn").length;
  const items = () => [...document.querySelectorAll(".block-list li")];
  const before = items().length;
  await globalThis.__events["pty-block-start"]({ payload: { session: sid, id: 50, cmd_start: 1000, start: 1010 } });
  const running = items().find((li) => li.classList.contains("running"));
  check(running && /running/.test(running.textContent) && items().length === before + 1, "a started command appears in the list as running");
  check(running?.hidden, "a running row stays hidden for the first moments so quick commands do not flicker");
  await wait(450);
  check(!running?.hidden, "a command that takes a moment is shown as running");
  await globalThis.__events["pty-block-start"]({ payload: { session: sid, id: 50, cmd_start: 1000, start: 1010 } });
  check(items().length === before + 1, "a repeated start note does not add a second row");
  await globalThis.__events["pty-block"]({ payload: { session: sid, id: 50, cmd_start: 1000, start: 1010, end: 1040, lines: 3, exit: 0, ms: 1500 } });
  check(!items().some((li) => li.classList.contains("running")) && items().length === before + 1, "the running row becomes the finished command");
  await globalThis.__events["pty-block-start"]({ payload: { session: sid, id: 50, cmd_start: 1000, start: 1010 } });
  check(!items().some((li) => li.classList.contains("running")), "a late start note for a finished command is ignored");
}

// ticking several commands and analyzing them together
{
  const sid = globalThis.__calls.filter(([c]) => c === "pty_spawn").length; // the newest terminal is the active one
  const block = (id, cmd_start, start, end) => ({ session: sid, id, cmd_start, start, end, lines: 2, exit: 0, ms: 5 });
  await globalThis.__events["pty-block"]({ payload: block(1, 0, 10, 40) });
  await globalThis.__events["pty-block"]({ payload: block(2, 50, 60, 90) });
  await globalThis.__events["pty-block"]({ payload: block(3, 100, 110, 140) });
  const boxes = [...document.querySelectorAll(".block-list .pick")];
  check(boxes.length >= 3, "each command has a tick box");
  const bar = document.getElementById("multi-bar");
  check(bar.hidden, "selection bar is hidden until something is ticked");
  const tick = (box, shiftKey) => { box.dispatchEvent(new w.MouseEvent("click", { bubbles: true, shiftKey })); };
  const last3 = boxes.slice(-3);
  tick(last3[0], false);
  tick(last3[2], true); // shift: ticks the range 1..3
  check(!bar.hidden && /Analyze 3 selected/.test(document.getElementById("analyze-selected").textContent), "shift+click ticks a range");
  globalThis.__calls.length = 0;
  document.getElementById("analyze-selected").click();
  await wait(30);
  const call = globalThis.__calls.find(([c]) => c === "analyze_open_ranges");
  check(call && call[1].ranges.length === 3 && call[1].ranges[0][0] === 0 && call[1].ranges[2][1] === 140, "analyze selected opens the three commands with their typed commands");
  // copying from the viewer with "Mask on copy" ticked must put masked text on the clipboard
  let copied = null;
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (t) => { copied = t; } }, configurable: true });
  globalThis.__lines = ["ssh bob@example.com from 10.1.2.3, password=hunter2, home /home/alice/x"];
  const viewer = document.getElementById("analyze");
  check(viewer, "the viewer is open");
  if (viewer) {
    viewer.querySelector(".an-mask-on").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    viewer.querySelector(".an-copy-all").click();
    await wait(30);
    check(copied?.startsWith("ssh <email-1> from <ip-1>, password=<secret>, home /home/<user>/x\n"), `viewer copy is masked: got ${JSON.stringify(copied)}`);
  }
  check(document.querySelector(".toast.show")?.textContent === "Copied (masked)", "a note appears after copying");
  if (viewer) {
    // compact view: squeezing spaces changes what is shown and copied, and turning it off restores it
    viewer.querySelector(".cp-off").click();
    await wait(30);
    globalThis.__lines = ["a      b    c"];
    const box = viewer.querySelector(".cp-spaces");
    box.checked = true;
    box.dispatchEvent(new w.Event("change"));
    await wait(30);
    check(/compact/.test(viewer.querySelector(".an-copy-all").textContent), "copy button says compact while compact view is on");
    check(viewer.querySelector(".an-rows").textContent.includes("a b c"), "compact view squeezes spaces in the rows");
    viewer.querySelector(".an-copy-all").click();
    await wait(30);
    check(copied?.startsWith("a b c\n"), `compact copy gives the compact text: got ${JSON.stringify(copied)}`);
    viewer.querySelector(".cp-off").click();
    await wait(30);
    check(viewer.querySelector(".an-rows").textContent.includes("a      b    c"), "turning compact off restores the text");
  }
  if (viewer) {
    // folded view: "Copy all" gives the folded text, not every line
    globalThis.__lines = null;
    globalThis.__groups = [{ first: 0, count: 10, summary: "⟲ 2-line block × 5: x …" }];
    const mode = viewer.querySelector(".an-mode");
    mode.value = "blocks";
    mode.dispatchEvent(new w.Event("change"));
    await wait(30);
    check(/collapsed/.test(viewer.querySelector(".an-copy-all").textContent), "copy button says collapsed while folded");
    viewer.querySelector(".an-copy-all").click();
    await wait(30);
    check(copied === "⟲ 2-line block × 5: x …  ×10", `folded copy all gives the folded text: got ${JSON.stringify(copied)}`);
    globalThis.__groups = null;
  }
  globalThis.__lines = null;
  document.querySelector("#analyze .an-close")?.click();
  document.getElementById("clear-selected").click();
  check(bar.hidden, "clear hides the selection bar");
}

// masking of sensitive details (pure text functions)
{
  const { maskText } = await import(pathToFileURL(path.join(root, "src/mask.js")).href);
  const eq = (input, want, msg) => { const got = maskText(input); check(got === want, `mask: ${msg}: got ${JSON.stringify(got)}`); };
  eq("connect from 10.1.2.3 to 10.1.2.3 and 192.168.0.9", "connect from <ip-1> to <ip-1> and <ip-2>", "same ip, same label");
  eq("listening on 127.0.0.1:80 and 0.0.0.0", "listening on 127.0.0.1:80 and 0.0.0.0", "loopback stays");
  eq("version 1.2.3 build 300", "version 1.2.3 build 300", "not an ip");
  eq("mail bob@example.com, Bob@Example.com and amy@x.org", "mail <email-1>, <email-1> and <email-2>", "emails");
  eq("/home/alice/src and C:\\Users\\Bob\\docs", "/home/<user>/src and C:\\Users\\<user>\\docs", "user paths");
  eq("password=hunter2 token: abc123 api_key=\"x y\"", "password=<secret> token: <secret> api_key=<secret>", "key=value secrets");
  eq("Authorization: Bearer abcdefghijkl12345", "Authorization: Bearer <secret>", "authorization header");
  eq("git clone https://bob:pw123@github.com/x/y", "git clone https://<user>:<secret>@github.com/x/y", "url credentials");
  eq("key AKIAIOSFODNN7EXAMPLE and ghp_0123456789abcdefghijABCDEFGHIJ", "key <secret> and <secret>", "known token formats");
  eq("mac aa:bb:cc:dd:ee:ff", "mac <mac-1>", "mac address");
  eq("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----", "<private key>", "private key block");
  eq("nothing secret here: 42 lines", "nothing secret here: 42 lines", "plain text untouched");
  check(maskText("10.1.2.3 bob@x.org", { on: true, ips: false, emails: true }) === "10.1.2.3 <email-1>", "mask: categories can be switched off");
}

// files with control characters are not printed with plain cat, which would corrupt the terminal
{
  const termEl = document.querySelector(".pane .pane-term");
  const labels = async (name) => {
    globalThis.__selection = name;
    termEl.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await wait(40);
    const l = [...document.querySelectorAll(".ctx-menu button")].map((b) => b.textContent);
    document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
    return l;
  };
  const plain = await labels("notes.txt");
  check(plain.some((t) => t === "Show in terminal (cat)") && !plain.some((t) => /cat -v/.test(t)), "a plain text file is shown with cat");
  const odd = await labels("unsafe.log");
  check(odd.some((t) => /cat -v/.test(t)) && !odd.some((t) => t === "Show in terminal (cat)"), "a file with control characters is offered with cat -v instead of cat");
  check(odd.includes("Reset terminal display"), "the terminal menu can reset a broken display");
  globalThis.__selection = "";
}

// Hide in the terminal: black overlay cells over the selection; copying from the terminal never gives hidden text
{
  let copiedText = null;
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (t) => { copiedText = t; } }, configurable: true });
  const termEl = document.querySelector(".pane .pane-term");
  for (const k of Object.keys(w.localStorage)) if (/mask/i.test(k)) w.localStorage.removeItem(k); // earlier tests turned masking on
  const menuItems = async () => {
    termEl.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await wait(40);
    return [...document.querySelectorAll(".ctx-menu button")];
  };
  const choose = async (re) => { (await menuItems()).find((b) => re.test(b.textContent))?.click(); await wait(20); };
  globalThis.__rows = { 1: "password=hunter2 user=alice" };
  globalThis.__cursorLine = 2;
  globalThis.__decos = [];
  globalThis.__selection = "hunter2";
  globalThis.__selPos = { start: { x: 9, y: 1 }, end: { x: 16, y: 1 } };
  await choose(/^Hide selection/);
  const d = globalThis.__decos[0]?.o;
  check(d && d.x === 9 && d.width === 7 && d.marker.line === 1 && d.backgroundColor === "#000000" && d.foregroundColor === "#000000", `Hide covers exactly the selected cells with a black overlay: got ${JSON.stringify(d && { x: d.x, width: d.width, line: d.marker.line })}`);
  globalThis.__selection = "password=hunter2 user=alice";
  globalThis.__selPos = { start: { x: 0, y: 1 }, end: { x: 27, y: 1 } };
  await choose(/^Copy$/);
  check(copiedText === "password=███████ user=alice", `terminal copy replaces hidden cells: got ${JSON.stringify(copiedText)}`);
  const labels = (await menuItems()).map((b) => b.textContent);
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  check(labels.some((t) => /Show all hidden text \(1\)/.test(t)), "the menu offers to show hidden text again");
  await choose(/Show all hidden text/);
  check(globalThis.__decos[0].disposed, "showing removes the black overlay");
  await choose(/^Copy$/);
  check(copiedText === "password=hunter2 user=alice", `after showing, copy gives the real text: got ${JSON.stringify(copiedText)}`);
  globalThis.__selection = "";
  globalThis.__selPos = undefined;
  globalThis.__rows = undefined;
}

// right-click menu on a selected folder name: its entries must be clickable and reach the backend
{
  globalThis.__selection = "docs";
  const termEl = document.querySelector(".pane .pane-term");
  const menuIsOpen = () => document.querySelector(".ctx-menu");
  termEl.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await wait(50);
  check(menuIsOpen(), "right-click on a selected folder name opens the context menu");
  const items = [...document.querySelectorAll(".ctx-menu button")];
  const cd = items.find((b) => /cd/.test(b.textContent));
  check(cd, "context menu offers cd for a folder");
  if (cd) {
    await wait(10); // listeners that close the menu are armed after a tick
    // pressing the menu makes the terminal lose focus: a blur reaches window in the capture phase
    termEl.dispatchEvent(new w.FocusEvent("blur"));
    check(menuIsOpen(), "context menu stays open when the terminal loses focus");
    // a real click is mousedown, mouseup, click; the menu must survive the mousedown
    cd.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    check(menuIsOpen(), "context menu stays open while the mouse is pressed on it");
    cd.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    cd.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
    await wait(20);
    check(!menuIsOpen(), "context menu closes after a choice");
    check(globalThis.__calls.some(([c, a]) => c === "pty_write" && a.data.includes("cd -- '/home/user/docs'")), "choosing cd types the cd command into the shell");
  }
  globalThis.__selection = "";
}

// copy style and always on top
{
  const key = (code, o = {}) => ({ type: "keydown", code, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, ...o });
  const h = globalThis.__keyHandler;
  globalThis.__selection = "hello";
  check(h(key("KeyC")) === true, "terminal style: Ctrl+C is left for the shell (interrupt)");
  const prefsBox = JSON.parse(w.localStorage.getItem("digterm.prefs") || "{}");
  check(prefsBox.copyStyle === undefined || prefsBox.copyStyle === "terminal", "copy style defaults to terminal");
  const mod = [...w.document.querySelectorAll("select")];
  check(typeof h === "function", "terminal registers a key handler");
  w.localStorage.setItem("digterm.prefs", JSON.stringify({ ...prefsBox, copyStyle: "windows" }));
}

// command dictionary
{
  const { searchCommands } = await import("../../src/cmddict.js");
  check(searchCommands("delete").length > 0, "dictionary finds 'delete'");
  check(searchCommands("tasklist").some((r) => r[1] === "ps aux"), "dictionary finds a Windows command and shows the Linux one");
  check(searchCommands("zzzz").length === 0, "dictionary returns nothing for nonsense");
}

{
  const { suggest } = await import("../../src/suggest.js");
  check(suggest("gti push")?.fixed === "git push", "typo gti -> git");
  check(suggest("cls")?.fixed === "clear", "cls -> clear on Linux");
  check(suggest("ls", true)?.fixed === "dir", "ls -> dir on Windows");
  check(suggest("foobar x") === null, "unknown commands are left alone");
  check(suggest("dir")?.safe === true && suggest("del f")?.safe === false, "destructive fixes are never safe to auto-run");
  check(suggest("./gti") === null, "paths are left alone");
}

if (problems.length) {
  console.error(`UI smoke test FAILED (${problems.length}):\n` + problems.join("\n---\n"));
  process.exit(1);
}
console.log("UI smoke test passed");
process.exit(0);
