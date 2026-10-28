export class Terminal {
  constructor(o) { this.options = { ...o }; this.rows = 24; this.cols = 80; this.buffer = { active: { length: 0, getLine() { return null; } } }; }
  loadAddon() {} open() {} onData() {} onResize() {} registerLinkProvider() {} write() {} dispose() {} focus() {} getSelection() { return globalThis.__selection ?? ""; }
}
export class FitAddon { fit() {} }
export class SearchAddon { findNext() {} findPrevious() {} }
