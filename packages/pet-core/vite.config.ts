import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Tauri shell loads `dist/` in a release build and `devUrl` in a debug one.
// That trips people up: `cargo run` on its own shows an empty window and no
// error anywhere, because the shell is pointed at a dev server nobody started.
// Use `pnpm dev`, which starts both.
//
// The port is fixed because tauri.conf.json names it, and `strictPort` makes a
// clash fail loudly rather than quietly serving somewhere the shell is not
// looking — the same reasoning as D9.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "safari15", outDir: "dist", emptyOutDir: true },
});
