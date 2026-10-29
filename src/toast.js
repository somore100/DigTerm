// A small gray note that appears at the bottom of the window and fades away by itself.
import { loadMask } from "./mask.js";

let el = null;
let timer = 0;

export function toast(text, ms = 1400) {
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove("show"), ms);
}

// After something was put on the clipboard.
export const copiedToast = () => toast(loadMask().on ? "Copied (masked)" : "Copied");
