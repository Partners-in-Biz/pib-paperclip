import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the CI runner
    maxWorkers: process.env.CI ? 8 : 4,
    include: ["tests/**/*.spec.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
