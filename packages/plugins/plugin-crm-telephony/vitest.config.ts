import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the CI runner
    maxWorkers: process.env.CI ? 8 : 4,
    include: ["tests/**/*.spec.ts"],
    environment: "node",
    // loaded self-hosted runner: 5s default is too tight for media-steps body-cap tests
    testTimeout: 30000,
  },
});
