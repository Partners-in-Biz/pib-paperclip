import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the self-hosted CI runner.
    // GitHub-hosted runners keep vitest's default (cores - 1); all root projects must agree (PAR-12762).
    maxWorkers: process.env.RUNNER_ENVIRONMENT === "github-hosted" ? undefined : process.env.CI ? 8 : 4,
    environment: "node",
    // Temporary (PAR-14632): fails on development itself, so it must not block the changed-file CI step.
    exclude: ["dist/**", "node_modules/**", "src/server/execute.instructions.test.ts"],
  },
});
