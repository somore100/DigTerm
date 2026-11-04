export function getCurrentWindow() {
  return { setFullscreen: async () => {}, isFullscreen: async () => false, setBackgroundColor: async () => {}, setAlwaysOnTop: async (v) => { globalThis.__onTop = v; } };
}
