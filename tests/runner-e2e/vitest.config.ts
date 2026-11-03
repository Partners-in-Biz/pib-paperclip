import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the CI runner
    maxWorkers: process.env.CI ? 8 : 4,
    name: "runner-e2e-support",
    include: ["**/*.test.ts"],
    testTimeout: 30_000,
  },
});
