export class Terminal {
  constructor(o) { this.options = { ...o }; this.rows = 24; this.cols = 80; this.buffer = { active: { length: 0, baseY: 0, get cursorY() { return globalThis.__cursorLine ?? 0; }, viewportY: 0, getLine: (y) => { const t = globalThis.__rows?.[y]; return t === undefined ? null : { isWrapped: false, getCell: (x) => (x < t.length ? { getWidth: () => 1, getChars: () => (t[x] === " " ? "" : t[x]) } : null) }; } } }; this.parser = { registerOscHandler(id, fn) { (globalThis.__osc ??= {})[id] = fn; } }; }
  registerMarker(off = 0) { return { line: (globalThis.__cursorLine ?? 0) + off, isDisposed: false }; }
  registerDecoration(o) { const d = { o, disposed: false, dispose() { d.disposed = true; } }; (globalThis.__decos ??= []).push(d); return d; }
  getSelectionPosition() { return globalThis.__selPos; }
  clearSelection() { globalThis.__selection = ""; }
  attachCustomKeyEventHandler(fn) { globalThis.__keyHandler = fn; } loadAddon() {} open() {} onData() {} onResize() {} registerLinkProvider() {} write() {} dispose() {} reset() { globalThis.__reset = (globalThis.__reset ?? 0) + 1; } focus() {} getSelection() { return globalThis.__selection ?? ""; }
}
export class FitAddon { fit() {} }
export class SearchAddon { findNext() {} findPrevious() {} }
