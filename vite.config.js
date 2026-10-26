import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // keep the dev server from reloading on toolchain and Rust build files
    watch: { ignored: ["**/.toolchain/**", "**/src-tauri/**", "**/node_modules/**"] },
  },
});
