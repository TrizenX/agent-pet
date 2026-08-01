import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-pet/protocol": new URL("./packages/protocol/src/index.ts", import.meta.url).pathname,
      "@agent-pet/adapter-claude-code/mapping": new URL(
        "./packages/adapter-claude-code/src/mapping.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ["packages/**/*.test.ts"],
    environment: "node",
  },
});
