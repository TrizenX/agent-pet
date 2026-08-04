import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@agent-pet/protocol": new URL("./packages/protocol/src/index.ts", import.meta.url).pathname,
      "@agent-pet/adapter-claude-code/mapping": new URL(
        "./packages/adapter-claude-code/src/mapping.ts",
        import.meta.url,
      ).pathname,
      "@agent-pet/adapter-git/mapping": new URL(
        "./packages/adapter-git/src/mapping.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    // `tests/` is for tests that legitimately span packages. A test that drives
    // recorded Claude Code payloads through pet-core's machine knows both sides,
    // and neither package may: I5 forbids agent names inside pet-core, and an
    // adapter must not depend on the shell. So it lives outside both.
    include: ["packages/**/*.test.ts", "packages/**/*.test.tsx", "tests/**/*.test.ts"],
    environment: "node",
  },
});
