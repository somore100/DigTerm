import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const xtermVersion = JSON.parse(readFileSync("node_modules/@xterm/xterm/package.json", "utf8")).version;

export default defineConfig({
  clearScreen: false,
  define: { __XTERM_VERSION__: JSON.stringify(xtermVersion) },
  build: { target: "esnext" }, // the webview is modern; top-level await is used in main.js
  server: {
    port: 1420,
    strictPort: true,
    // keep the dev server from reloading on toolchain and Rust build files
    watch: { ignored: ["**/.toolchain/**", "**/src-tauri/**", "**/node_modules/**"] },
  },
});
