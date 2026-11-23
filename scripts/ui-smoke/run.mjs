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
  // Markdown files are shown rendered in Formatted and as they are in Raw
  await drop("/tmp/readme.md");
  v = viewerEl();
  const md = v?.querySelector(".an-md");
  check(md && !md.hidden && v.querySelector(".an-body").hidden, "a .md file opens rendered");
  check(md?.querySelector("h1")?.textContent === "Title" && md.querySelector("strong")?.textContent === "bold" && md.querySelector("li ul li")?.textContent === "nested", "headings, bold and nested lists are rendered");
  check(md?.querySelector("table td")?.textContent === "1" && md.querySelector("pre code")?.textContent === "<b>code</b>" && !md.querySelector("b"), "tables and code render, and markup inside code stays text");
  check(!md?.querySelector("img") && /\[image: pic\]/.test(md?.textContent ?? ""), "images are not loaded: only their text shows");
  const lk = md?.querySelector("a.md-link");
  check(lk && !lk.hasAttribute("href"), "links carry no href");
  lk?.click();
  await wait(10);
  check(globalThis.__calls.some(([c, a]) => c === "open_url" && a.url === "https://example.com"), "clicking a link opens it in the browser");
  v.querySelector(".seg-raw").click();
  await wait(20);
  check(md.hidden && !v.querySelector(".an-body").hidden, "Raw shows the file as it is");
  v.querySelector(".seg-fmt").click();
  await wait(20);
  check(!md.hidden, "Formatted shows the rendering again");
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
  const lab = [...document.querySelectorAll(".block-info .ok")].find((x) => /3 lines/.test(x.textContent));
  check(lab && /^\d{1,2}[:.]\d{2}[:.]\d{2}/.test(lab.textContent.trim()) && /^Started /.test(lab.title), "a finished command shows when it started");
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
    // timestamps and the Raw / Formatted switch
    const { shortenTime, logDates } = await import("../../src/compact.js");
    const { groupByMinute } = await import("../../src/compact.js");
    check(groupByMinute(["2026-11-17T19:16:05Z a", "cont", "2026-11-17T19:17:00Z b"], null, {}, [], { dropDate: true }).join("|") === "19:16 │ :05 a|      │ cont|19:17 │ :00 b", "tree view prints each minute once");
    check(groupByMinute(["2026-11-17T19:16:06Z a"], "2026-11-17T19:16:00Z p", {}, [], { dropDate: true })[0].startsWith("      │"), "the minute of the line before decides whether to print it");
    check(shortenTime("2026-11-17T19:16:05.0638102Z [DEBUG]: x", true) === "19:16:05.06 [DEBUG]: x", "timestamp loses date, zone letter and extra digits");
    check(shortenTime("2026-11-17 19:16:05 x", false) === "2026-11-17 19:16:05 x" && shortenTime("[2026-11-17T19:16:05+02:00] y", true) === "[19:16:05+02:00] y" && shortenTime("no time here", true) === "no time here", "timestamp rules: date kept on request, bracket and offset kept, other lines untouched");
    check(logDates(["2026-11-17T01:00:00Z a", "x", "2026-11-18T01:00:00Z b", "2026-11-17T02:00:00Z c"]).join() === "2026-11-17,2026-11-18", "log dates are listed once, in order");
    globalThis.__lines = ["2026-11-17T19:16:05.0638102Z [DEBUG]: one", "2026-11-17T19:16:06.1111111Z [DEBUG]: two"];
    const tbox = viewer.querySelector(".cp-times");
    tbox.checked = true;
    tbox.dispatchEvent(new w.Event("change"));
    await wait(40);
    check(viewer.querySelector(".an-rows").textContent.includes("19:16:05.06 [DEBUG]: one") && !viewer.querySelector(".an-rows").textContent.includes("2026-11-17T"), "Shorten timestamps changes the rows");
    check(/2026-11-17/.test(viewer.querySelector(".cp-info").textContent), "the left-out date is shown once in a note");
    const gbox = viewer.querySelector(".cp-group");
    check(!gbox.disabled, "Group lines by minute is available once timestamps are shortened");
    gbox.checked = true;
    gbox.dispatchEvent(new w.Event("change"));
    await wait(40);
    const gtext = viewer.querySelector(".an-rows").textContent;
    check(/19:16\s*│ :05\.06 \[DEBUG\]: one/.test(gtext) && /\s{5}│ :06\.11/.test(gtext), "grouped view shows the minute once, then only seconds");
    gbox.checked = false;
    gbox.dispatchEvent(new w.Event("change"));
    await wait(30);
    viewer.querySelector(".seg-raw").click();
    await wait(30);
    check(viewer.querySelector(".an-rows").textContent.includes("2026-11-17T19:16:05.0638102Z") && viewer.classList.contains("is-raw"), "Raw shows the original text");
    check(/raw/.test(viewer.querySelector(".an-copy-all").textContent), "the copy button says it copies raw");
    viewer.querySelector(".an-copy-all").click();
    await wait(30);
    check(copied?.startsWith("2026-11-17T19:16:05.0638102Z [DEBUG]: one\n"), `raw copy gives the original text: got ${JSON.stringify(copied)}`);
    viewer.querySelector(".seg-fmt").click();
    await wait(30);
    check(viewer.querySelector(".an-rows").textContent.includes("19:16:05.06 [DEBUG]: one"), "Formatted brings the compact view back");
    viewer.querySelector(".cp-off").click();
    await wait(30);
    globalThis.__lines = null;
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
    // a folded group can be opened and folded again
    check(!!mode.querySelector('option[value="minutes"]'), "folding by minute is offered");
    const rep = () => viewer.querySelector(".an-rows .rep");
    rep()?.click();
    await wait(30);
    check(!!viewer.querySelector(".an-rows .rep.un"), "an opened group shows a fold-again mark");
    viewer.querySelector(".an-rows .rep.un")?.click();
    await wait(30);
    check(/×10/.test(viewer.querySelector(".an-rows").textContent), "clicking the mark folds the group again");
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
  check(suggest("sud apt update")?.fixed === "sudo apt update" && suggest("sud apt update").confidence >= 0.7, "a cut-off word that is the start of one command is fixed");
  check(suggest("dir ;touch PWNED")?.safe === false && suggest("dir ;touch PWNED").risky === true, "a fix with shell chaining is never safe to run by itself");
  check(suggest("gti status; curl x|sh")?.risky === true && suggest("gti status")?.risky === false, "risky is only set for chained or redirected lines");
  check(suggest("gti \x03 touch PWNED") === null, "command text with control characters gets no suggestion");
  check(suggest("./gti") === null, "paths are left alone");
}

// compress old saved output: preferences and the backend call
{
  document.getElementById("menu-btn").click();
  [...menu.querySelectorAll("button")].find((b) => /^Preferences/.test(b.textContent))?.click();
  await wait(30);
  const dlg = document.getElementById("dialog-host");
  const labelOf = (re) => [...dlg.querySelectorAll("label, .opt, div")].find((d) => re.test(d.textContent) && d.querySelector("input[type=number]"));
  const ageRow = labelOf(/^Compress output older than/);
  check(ageRow, "Preferences has a Compress output older than setting");
  const num = ageRow?.querySelector("input[type=number]");
  num.value = "3";
  num.dispatchEvent(new w.Event("change"));
  const unitSel = ageRow.querySelector("select");
  unitSel.value = "day";
  unitSel.dispatchEvent(new w.Event("change"));
  check(JSON.parse(w.localStorage.getItem("digterm.prefs")).compressAge === 3, "the compress rule is saved");
  const before = globalThis.__calls.filter(([c]) => c === "autocompress").length;
  [...dlg.querySelectorAll("button")].find((b) => b.textContent === "Clean up now")?.click();
  await wait(40);
  const call = globalThis.__calls.filter(([c]) => c === "autocompress");
  check(call.length === before + 1 && call.at(-1)[1].olderSecs === 3 * 86400 && call.at(-1)[1].maxBytes === 0, "Clean up now asks the backend to compress by the rule");
  num.value = "0";
  num.dispatchEvent(new w.Event("change"));
  [...dlg.querySelectorAll("button")].find((b) => /^(Close|✕|X)$/.test(b.textContent))?.click();
}

// history: sessions from the same moment with the same size share one row
{
  const t = Math.floor(Date.now() / 1000) - 100;
  globalThis.__runs = [1, 2, 3].map((i) => ({ name: `run-${i}-1.raw`, size: 1000 + i * 37, modified: t + i, open: true })).concat([{ name: "run-9-1.raw", size: 4000, modified: t - 5000, open: false }]);
  document.getElementById("menu-btn").click();
  [...menu.querySelectorAll("button")].find((b) => /History of earlier/.test(b.textContent))?.click();
  await wait(30);
  const host = document.getElementById("dialog-host");
  const rows = () => [...host.querySelectorAll(".hist-run")];
  check(rows().length === 2 && /×3 similar/.test(rows()[0].textContent + rows()[1].textContent), "three identical sessions show as one row");
  const pickBox = rows().find((r) => /×3/.test(r.textContent)).querySelector("input[type=checkbox]");
  pickBox.checked = true;
  pickBox.dispatchEvent(new w.Event("change"));
  check(/3 selected/.test(host.querySelector(".hist-count").textContent), "ticking a group selects every session in it");
  check(/2 rows · 4 sessions/.test(host.querySelector(".hist-count").textContent), "the counter shows rows and sessions");
  globalThis.__emptyRuns = ["run-9-1.raw"];
  const ebox = [...host.querySelectorAll(".hist-bar input[type=checkbox]")][2];
  ebox.checked = true;
  ebox.dispatchEvent(new w.Event("change"));
  await wait(60);
  check(rows().length === 1 && /3 sessions/.test(host.querySelector(".hist-count").textContent), "Hide empty removes sessions with no commands");
  ebox.checked = false;
  ebox.dispatchEvent(new w.Event("change"));
  globalThis.__emptyRuns = null;
  const cbox = [...host.querySelectorAll(".hist-bar input[type=checkbox]")][1];
  cbox.checked = false;
  cbox.dispatchEvent(new w.Event("change"));
  check(rows().length === 4, "unticking Compact lists every session");
  cbox.checked = true;
  cbox.dispatchEvent(new w.Event("change"));
  globalThis.__runs = null;
  [...host.querySelectorAll("button")].find((b) => /^(Close|✕|X)$/.test(b.textContent))?.click();
}

// history: date range, sort, selection, copy, delete
{
  document.getElementById("menu-btn").click();
  [...menu.querySelectorAll("button")].find((b) => /History of earlier/.test(b.textContent))?.click();
  await wait(30);
  const host = document.getElementById("dialog-host");
  const rows = () => [...host.querySelectorAll(".hist-run")];
  const [sortSel, rangeSel] = host.querySelectorAll(".hist-bar select");
  check(rows().length === 3, "history lists all three sessions");
  rangeSel.value = "3"; // past 7 days
  rangeSel.dispatchEvent(new w.Event("change"));
  check(rows().length === 2, "the date range hides the old session");
  rangeSel.value = "0";
  sortSel.value = "big";
  sortSel.dispatchEvent(new w.Event("change"));
  check(/8\.6 MB/.test(rows()[0].textContent), "sorting by size puts the largest first");
  const all = host.querySelector(".hist-bar input[type=checkbox]");
  all.checked = true;
  all.dispatchEvent(new w.Event("change"));
  check(/3 selected/.test(host.querySelector(".hist-count").textContent), "select all selects what is shown");
  const btn = (t) => [...host.querySelectorAll(".hist-bar button")].find((b) => b.textContent.startsWith(t));
  let clip = "";
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (t) => { clip = t; }, readText: async () => "" }, configurable: true });
  btn("Copy commands").click();
  await wait(30);
  check(/ls -la {2}\(3 lines, exit 0\)/.test(clip) && clip.split("# ").length === 4, "Copy commands copies every selected session's command list");
  btn("Delete selected").click();
  check(!globalThis.__calls.some(([c]) => c === "delete_runs"), "Delete asks for a second click");
  btn("Click again").click();
  await wait(30);
  check(globalThis.__calls.some(([c, a]) => c === "delete_runs" && a.names.length === 3), "second click deletes the selected sessions");
  press({ key: "Escape", code: "Escape" });
}

// run commands one by one
{
  const { parseLines, startDelayMs } = await import("../../src/batch.js");
  check(parseLines("a\n\n# c\n  b  \r\n").join("|") === "a|b", "queue lines: blanks and comments skipped");
  check(parseLines("echo hi\x03 touch PWNED").join("|") === "echo hi touch PWNED", "control characters are dropped from queue lines");
  const noon = new Date(2026, 0, 1, 12, 0, 0);
  check(startDelayMs("at", "12:30", noon) === 30 * 60000, "start at a time later today");
  check(startDelayMs("at", "11:00", noon) === 23 * 3600000, "start at a time already past means tomorrow");
  check(startDelayMs("in", "5", noon) === 300000 && startDelayMs("now", "") === 0, "start in N minutes / now");
  check(startDelayMs("at", "25:00", noon) === null && startDelayMs("in", "abc", noon) === null, "invalid start times are refused");

  document.getElementById("menu-btn").click();
  [...menu.querySelectorAll("button")].find((b) => /Run commands one by one/.test(b.textContent))?.click();
  await wait(20);
  const host = document.getElementById("dialog-host");
  const area = host.querySelector(".batch-area");
  area.value = "echo one\n# skip\necho two";
  [...host.querySelectorAll("button")].find((b) => b.textContent === "Start").click();
  await wait(20);
  const sid = globalThis.__calls.find(([c, a]) => c === "pty_write" && /echo one/.test(a.data))?.[1].id; // the terminal the queue runs in
  const writes = () => globalThis.__calls.filter(([c, a]) => c === "pty_write" && /echo (one|two)/.test(a.data)).map(([, a]) => a.data);
  check(writes().length === 1 && /echo one\r$/.test(writes()[0]), "the queue sends the first command at once");
  check(document.querySelector(".queue-bar"), "a queue bar shows while it runs");
  await globalThis.__events["pty-block"]({ payload: { session: sid, id: 300, cmd_start: 1, start: 2, end: 3, lines: 1, exit: 0, ms: 5 } });
  check(writes().length === 2 && /echo two\r$/.test(writes()[1]), "the next command is sent when the first has finished");
  await globalThis.__events["pty-block"]({ payload: { session: sid, id: 301, cmd_start: 4, start: 5, end: 6, lines: 1, exit: 0, ms: 5 } });
  check(!document.querySelector(".queue-bar"), "the queue bar goes away when all have run");
}

// colour buttons
{
  const { normalize } = await import("../../src/launchers.js");
  check(normalize({ name: "x", commands: "ls" })?.where === "tab" && normalize({ name: "", commands: "ls" }) === null && normalize({ name: "x", commands: "# only a comment" }) === null, "a button needs a name and a real command");
  const host = document.getElementById("launchers");
  if (host.hidden) { // (the earlier "click every menu entry" loop already switched it on once)
    document.getElementById("menu-btn").click();
    [...menu.querySelectorAll("button")].find((b) => /Colour buttons/.test(b.textContent))?.click();
    await wait(20);
  }
  check(!host.hidden && host.querySelector(".launcher-add"), "the menu shows the strip with a + button");
  host.querySelector(".launcher-add").click();
  await wait(20);
  const dlg = document.getElementById("dialog-host");
  const [nameIn] = dlg.querySelectorAll("input");
  nameIn.value = "server";
  dlg.querySelector("textarea").value = "echo serve-it";
  check(dlg.querySelector("select").value === "paste", "new buttons default to typing the text");
  dlg.querySelector("select").value = "tab";
  [...dlg.querySelectorAll("button")].find((b) => b.textContent === "Save").click();
  await wait(20);
  check(host.querySelectorAll(".launcher").length === 1, "saving adds a coloured button");
  const spawns = () => globalThis.__calls.filter(([c]) => c === "pty_spawn").length;
  const before = spawns();
  host.querySelector(".launcher").click();
  await wait(150);
  check(spawns() === before + 1, "clicking the button opens a new terminal");
  check(globalThis.__calls.some(([c, a]) => c === "pty_write" && /echo serve-it\r$/.test(a.data)), "and runs its command there");
  check(JSON.parse(w.localStorage.getItem("digterm.buttons") || "[]").length === 1, "buttons are saved");
  // a "type it" button only types the text at the prompt of the active terminal (no Enter), and can be used again
  host.querySelector(".launcher-add").click();
  await wait(20);
  const dlg2 = document.getElementById("dialog-host");
  dlg2.querySelector("input").value = "snippet";
  dlg2.querySelector("textarea").value = "ls -la";
  [...dlg2.querySelectorAll("button")].find((b) => b.textContent === "Save").click();
  await wait(20);
  const sb = [...host.querySelectorAll(".launcher")].find((b) => b.title.startsWith("snippet"));
  const n0 = globalThis.__calls.length;
  sb.click();
  sb.click();
  await wait(30);
  const typed = globalThis.__calls.slice(n0).filter(([c, a]) => c === "pty_write");
  check(typed.length === 2 && typed.every(([, a]) => a.data === "\x15ls -la"), `a type-it button types the text without Enter, every time: got ${JSON.stringify(typed)}`);
}

// temporary tab: not saved, no history
{
  const tabBtns = () => [...document.querySelectorAll("#tabs .tab-btn")];
  const n0 = tabBtns().length;
  document.getElementById("menu-btn").click();
  [...menu.querySelectorAll("button")].find((b) => /New temporary tab/.test(b.textContent))?.click();
  await wait(150);
  const spawn = [...globalThis.__calls].reverse().find(([c]) => c === "pty_spawn");
  check(spawn?.[1].temp === true, "a temporary tab asks the backend for output that is not kept");
  check(tabBtns().length === n0 + 1 && /◌/.test(tabBtns().at(-1).textContent), "the temporary tab is marked");
  const saved = [...globalThis.__calls].reverse().find(([c]) => c === "save_layout");
  check(!saved || JSON.parse(saved[1].json).tabs.length <= n0, "the temporary tab is left out of the saved tabs");
  check(!!document.getElementById("pick-all"), "the Commands panel has Select all");
  tabBtns().at(-1).querySelector("button").click();
  await wait(50);
}

// output triggers
{
  const T = await import("../../src/triggers.js");
  const t1 = T.normalizeTrigger({ text: "error" });
  const enc = (x) => new TextEncoder().encode(x);
  let wt = new T.Watcher(() => [t1]);
  check(wt.feed(enc("all fine\r\nBuild ERROR in x\r\n")).length === 1, "a trigger matches a line, ignoring case");
  check(wt.feed(enc("another error\n"), Date.now()).length === 0, "the same trigger waits a few seconds before firing again");
  wt = new T.Watcher(() => [t1]);
  check(wt.feed(enc("an err")).length === 0 && wt.feed(enc("or here\n")).length === 1, "a line split over two chunks still matches");
  wt = new T.Watcher(() => [t1]);
  check(wt.feed(enc("\x1b[31merr\x1b[0mor\n")).length === 1, "colour codes do not hide a match");
  wt = new T.Watcher(() => [t1]);
  check(wt.feed(enc("no newline error")).length === 0, "a line that is not finished yet is not matched");
  check(T.normalizeTrigger({ text: "(a+)+$", regex: true }) === null && T.normalizeTrigger({ text: "(", regex: true }) === null && T.normalizeTrigger({ text: "  " }) === null, "unsafe or empty patterns are refused");
  check(T.normalizeTrigger({ text: "a\x1bb" }) === null, "control characters are refused");
  wt = new T.Watcher(() => [T.normalizeTrigger({ text: "^done \\d+$", regex: true }), T.normalizeTrigger({ text: "Case", caseless: false })]);
  check(wt.feed(enc("done 42\ncase\nCase\n")).length === 2, "regex and match-case work");
  // UI
  document.getElementById("menu-btn").click();
  [...menu.querySelectorAll("button")].find((b) => /^Output triggers/.test(b.textContent))?.click();
  await wait(20);
  const dlg = document.getElementById("dialog-host");
  dlg.querySelector("input[placeholder^='Text to watch']").value = "Listening on";
  [...dlg.querySelectorAll("button")].find((b) => b.textContent === "Add").click();
  await wait(20);
  check(dlg.querySelectorAll(".trigger").length === 1 && JSON.parse(w.localStorage.getItem("digterm.triggers") || "[]").length === 1, "adding a trigger lists and saves it");
  document.querySelector("#dialog-host button.close, #dialog-host .dialog-close")?.click();
  const sid = globalThis.__calls.filter(([c]) => c === "pty_spawn").length;
  const push = (x) => globalThis.__channels[sid - 1].onmessage(Array.from(enc(x)));
  push("Listening on 3000\r\n");
  check(!document.querySelector(".toast.show")?.textContent.includes("Listening on"), "output while no command runs does not fire (typed text is not matched)");
  await globalThis.__events["pty-block-start"]({ payload: { session: sid, id: 900, cmd_start: 1, start: 2 } });
  push("Listening on 3000\r\n");
  check(/Trigger "Listening on": Listening on 3000/.test(document.querySelector(".toast")?.textContent ?? ""), "output of a running command fires the trigger with a message");
  await globalThis.__events["pty-block"]({ payload: { session: sid, id: 900, cmd_start: 1, start: 2, end: 3, lines: 1, exit: 0, ms: 5 } });
}

// Analyze pasted text: Open file…
{
  document.getElementById("menu-btn").click();
  [...menu.querySelectorAll("button")].find((b) => /^Analyze pasted text/.test(b.textContent))?.click();
  await wait(20);
  const dlg = document.getElementById("dialog-host");
  const open = [...dlg.querySelectorAll("button")].find((b) => b.textContent === "Open file…");
  check(open, "the paste dialog has an Open file button");
  const picker = dlg.querySelector("input[type=file]");
  Object.defineProperty(picker, "files", { value: [{ name: "big.log", size: 30 * 1048576, text: async () => "x" }], configurable: true });
  picker.dispatchEvent(new w.Event("change"));
  await wait(20);
  check(/too big/.test(dlg.textContent) && !document.getElementById("analyze"), "a file over 20 MB is refused with a hint");
  Object.defineProperty(picker, "files", { value: [{ name: "small.log", size: 5, text: async () => "a\nb" }], configurable: true });
  const opens = globalThis.__calls.filter(([c]) => c.startsWith("analyze_open")).length;
  picker.dispatchEvent(new w.Event("change"));
  await wait(40);
  check(document.getElementById("analyze") && globalThis.__calls.filter(([c]) => c.startsWith("analyze_open")).length === opens + 1, "a small file opens in the viewer");
  document.getElementById("analyze")?.querySelector(".an-close").click();
}

// presets
{
  {
    const { runCommand, runnableSelection } = await import("../../src/runfile.js");
    const q = (p) => `'${p}'`;
    check(runCommand("/a/b.py", false, false, q) === "python3 '/a/b.py'" && runCommand("C:\\a\\b.py", false, true, q) === "python 'C:\\a\\b.py'", "python files run with python3 (python on Windows)");
    check(runCommand("/a/tool", true, false, q) === "'/a/tool'" && runCommand("/a/notes.txt", false, false, q) === null && runCommand("/a/tool", true, true, q) === null, "an executable file runs as itself; plain text does not run");
    check(runnableSelection("ls -la\n") === "ls -la" && runnableSelection("a\nb") === null && runnableSelection("   ") === null, "only one clean line of selected text can be run");
  }
  {
    // easy install: package names in install commands, typed (never run) with the right Ctrl key
    const { installCandidates, ARCHIVE } = await import("../../src/install.js");
    const one = installCandidates("Command 'htop' not found, but can be installed with: sudo dnf install htop");
    check(one.length === 1 && one[0].cmd === "sudo dnf install htop" && one[0].name === "htop", "install hint gives the package and its command");
    const two = installCandidates("$ sudo apt-get install -y git curl && echo done");
    check(two.map((c) => c.cmd).join("|") === "sudo apt-get install git|sudo apt-get install curl", "several packages, flags dropped, stops at &&");
    check(installCandidates("sudo pacman -Syu ripgrep")[0]?.cmd === "sudo pacman -S ripgrep", "pacman -S...");
    check(installCandidates("sudo dnf install $(rm -rf x)").length === 0 && installCandidates("dnf remove htop").length === 0 && installCandidates("we install things").length === 0, "unsafe names and other commands give no link");
    check(installCandidates('$ echo "sudo dnf install htop"').map((c) => c.cmd).join() === "sudo dnf install htop", "quotes around the command do not hide the package");
    const col = installCandidates("sudo dnf install htop")[0];
    check(col.x1 === 18 && col.x2 === 21, "the link covers just the package name");
    check(ARCHIVE.test("a.tar.gz") && ARCHIVE.test("x.ZIP") && !ARCHIVE.test("notes.txt"), "archive names are recognised");
  }
  const { PRESETS, presetCommands, presetAsButton, platformOf } = await import("../../src/presets.js");
  const { normalize } = await import("../../src/launchers.js");
  check(platformOf("Mozilla (Windows NT 10)") === "win" && platformOf("(Macintosh)") === "mac" && platformOf("(X11; Linux)") === "linux", "platform comes from the user agent");
  const bad = /(^|[\s;|&])(rm|mv|cp|dd|sudo|kill|chmod|chown|mkfs|shutdown|reboot|systemctl\s+(start|stop|restart|enable|disable)|Remove-|Stop-|Set-|New-|Restart-)\b|>/;
  let allOk = true;
  for (const p of PRESETS) for (const pl of ["linux", "mac", "win"]) {
    const c = presetCommands(p, pl);
    if (!c || bad.test(c.replace(/2>\/dev\/null/g, "")) || !normalize(presetAsButton(p, pl))) { allOk = false; console.log("  bad preset", p.id, pl); }
  }
  check(allOk, "every preset exists for every platform, is a valid button and holds no changing command");
  document.getElementById("menu-btn").click();
  [...menu.querySelectorAll("button")].find((b) => /^Presets/.test(b.textContent))?.click();
  await wait(20);
  const dlg = document.getElementById("dialog-host");
  check(dlg.querySelectorAll(".preset").length === PRESETS.length, "the Presets dialog lists every check");
  const nBtn = JSON.parse(w.localStorage.getItem("digterm.buttons") || "[]").length;
  [...dlg.querySelectorAll(".preset button")].find((b) => b.textContent === "+ Button").click();
  await wait(20);
  check(JSON.parse(w.localStorage.getItem("digterm.buttons") || "[]").length === nBtn + 1, "+ Button saves it as a colour button");
  const spawns0 = globalThis.__calls.filter(([c]) => c === "pty_spawn").length;
  [...dlg.querySelectorAll(".preset button")].find((b) => b.textContent === "Run").click();
  await wait(150);
  check(globalThis.__calls.filter(([c]) => c === "pty_spawn").length === spawns0 + 1, "Run opens a new terminal");
  check(globalThis.__calls.some(([c, a]) => c === "pty_write" && /df -h/.test(a.data)), "and runs the check");
}

// move a terminal / combine tabs
{
  document.getElementById("new-tab").click();
  await wait(150);
  const bar = () => [...document.querySelectorAll("#tabs .tab-btn")];
  const n0 = bar().length;
  check(n0 >= 2, "two tabs exist for the move test");
  const first = bar()[0];
  first.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  await wait(20);
  const entries = [...document.querySelectorAll(".ctx-menu button")];
  const combine = entries.find((b) => /^Combine into: /.test(b.textContent));
  check(combine, "right-clicking a tab offers Combine into another tab");
  const panesBefore = document.querySelectorAll(".pane").length;
  combine?.click();
  await wait(60);
  check(bar().length === n0 - 1, "the combined tab is gone from the tab bar");
  check(document.querySelectorAll(".pane").length === panesBefore, "no terminal was closed by combining");
  check(!globalThis.__calls.slice(-5).some(([c]) => c === "pty_close"), "the shells keep running");
}

// compare two outputs
{
  const { normalizeLine, diffLines } = await import("../../src/compare.js");
  const key = (x) => normalizeLine(x, { times: true });
  check(normalizeLine("2026-11-09 12:30:01 started id 1234") === "‹time› started id 1234", "times are ignored");
  check(normalizeLine("pid 1234 took 56ms", { numbers: true }) === "pid # took #ms", "numbers can be ignored");
  const d = diffLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
  check(d.rows.map((r) => r.k).join() === "same,chg,same,same,add", "diff finds a changed line and an added line");
  check(diffLines(["12:00:01 up", "z"], ["13:45:09 up", "z"], key).rows.every((r) => r.k === "same"), "lines differing only in time count as equal");
  check(diffLines(["a", "b"], ["a"]).rows.map((r) => r.k).join() === "same,del", "a removed line shows as del");
  check(diffLines([], []).rows.length === 0, "empty inputs compare fine");
  const { wordDiff } = await import("../../src/compare.js");
  const wd = wordDiff("took 12:00:01 to copy file a", "took 13:30:00 to copy file b");
  check(wd.l.filter(([, c]) => c).map(([t]) => t).join("") === "a" && wd.r.filter(([, c]) => c).map(([t]) => t).join("") === "b", "word view marks only the words that differ (times ignored)");
  check(wordDiff("x".repeat(600).split("").join(" "), "y".repeat(600).split("").join(" ")) === null, "word view is skipped for huge lines");
  // UI: tick two commands; Compare appears and opens the side-by-side view
  const visiblePicks = () => [...document.querySelectorAll("#block-lists input.pick")].filter((x) => !x.closest("[hidden]"));
  const spawnId = globalThis.__calls.filter(([c]) => c === "pty_spawn").length;
  const before = visiblePicks().length;
  for (const [id, start] of [[400, 7777], [401, 8888]]) {
    for (let s2 = spawnId; s2 >= 1; s2--) { // the block goes to whichever session belongs to the focused pane
      const n0 = visiblePicks().length;
      await globalThis.__events["pty-block"]({ payload: { session: s2, id, cmd_start: start - 5, start, end: start + 9, lines: 3, exit: 0, ms: 1 } });
      if (visiblePicks().length > n0) break;
    }
  }
  const picks = visiblePicks().slice(-2);
  check(picks.length === 2 && visiblePicks().length === before + 2, "two commands were added to the list");
  const cmpBtn = document.getElementById("compare-selected");
  for (const pk of picks) pk.click();
  await wait(20);
  check(!cmpBtn.hidden, "Compare shows when exactly two commands are ticked");
  cmpBtn.click();
  await wait(40);
  const dlg = document.querySelector("#dialog-host .cmp");
  check(dlg, "the compare view opens");
  check(dlg?.querySelectorAll(".cmp-cell.diff").length === 4, "only real differences are marked (times ignored)");
  press({ key: "Escape", code: "Escape" });
}

if (problems.length) {
  console.error(`UI smoke test FAILED (${problems.length}):\n` + problems.join("\n---\n"));
  process.exit(1);
}
console.log("UI smoke test passed");
process.exit(0);
