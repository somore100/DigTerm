export function showContextMenu(x, y, items) {
  document.querySelectorAll(".ctx-menu").forEach((n) => n.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const [label, fn] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { menu.remove(); fn(); };
    menu.append(b);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  const gone = () => { if (document.hidden) off({ type: "hide" }); };
  const off = (e) => {
    if (e.type === "keydown" && e.key !== "Escape") return;
    if (e.type === "mousedown" && menu.contains(e.target)) return; // let the click reach the button
    // capturing on window also sees every element's blur (the terminal loses focus when you press the menu)
    if (e.type === "blur" && e.target !== window) return;
    menu.remove();
    for (const t of ["mousedown", "keydown", "blur"]) window.removeEventListener(t, off, true);
    document.removeEventListener("visibilitychange", gone);
  };
  setTimeout(() => { for (const t of ["mousedown", "keydown", "blur"]) window.addEventListener(t, off, true); }, 0);
  document.addEventListener("visibilitychange", gone); // minimizing may not blur the window
}
