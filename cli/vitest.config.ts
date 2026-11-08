import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the self-hosted CI runner.
    // GitHub-hosted runners have 4 vCPUs, so they keep vitest's default (cores - 1) instead of running 8.
    maxWorkers: process.env.RUNNER_ENVIRONMENT === "github-hosted" ? undefined : process.env.CI ? 8 : 4,
    environment: "node",
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
  },
});
