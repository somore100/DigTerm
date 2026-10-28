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

if (problems.length) {
  console.error(`UI smoke test FAILED (${problems.length}):\n` + problems.join("\n---\n"));
  process.exit(1);
}
console.log("UI smoke test passed");
process.exit(0);
