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
  /**
   * Never pre-bundle our own workspace packages.
   *
   * Vite caches pre-bundled dependencies in `node_modules/.vite`, and a linked
   * workspace package looks like a dependency. So an edit to the adapter did
   * not reach the built app: three separate rebuilds shipped a stale mapping,
   * the bug looked unfixed, and the only way to tell was to post an event at
   * the running binary and watch it behave like the old code.
   *
   * These are source files in this repo, not third-party packages. There is
   * nothing to pre-bundle and nothing to cache.
   */
  optimizeDeps: { exclude: ["@agent-pet/protocol", "@agent-pet/adapter-claude-code"] },
});
