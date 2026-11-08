import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the CI runner
    maxWorkers: process.env.RUNNER_ENVIRONMENT === "github-hosted" ? undefined : process.env.CI ? 8 : 4, // GitHub-hosted runners keep the default (cores - 1)
    include: ["src/**/*.test.ts", "bridge-template/src/**/*.test.ts"],
    environment: "node",
  },
});
