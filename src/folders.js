// Which folder a line of terminal output belongs to. Every command start leaves a marker (xterm keeps its line number
// up to date as the screen scrolls) together with the shell's folder at that moment; output below a marker was printed
// by that command, so names in it are looked up there instead of in the terminal's current folder.
export function cwdForLine(marks, line, fallback) {
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i];
    if (!m.marker.isDisposed && m.marker.line <= line) return m.cwd ?? fallback;
  }
  return fallback;
}
