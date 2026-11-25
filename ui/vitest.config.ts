import path from "path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the self-hosted CI runner.
    // GitHub-hosted runners have 4 vCPUs, so they keep vitest's default (cores - 1) instead of running 8.
    maxWorkers: process.env.RUNNER_ENVIRONMENT === "github-hosted" ? undefined : process.env.CI ? 8 : 4,
    // PAR-13933: ui/e2e holds Playwright specs; vitest must not collect them.
    exclude: [...configDefaults.exclude, "e2e/**"],
    environment: "node",
    css: { include: [/motion-tokens\.css/] },
    setupFiles: ["./vitest.setup.ts"],
  },
});
