import { defineConfig } from "vitest/config";

/** Cross-plugin contract tests (read every PiB plugin's sources). */
export default defineConfig({
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the CI runner
    maxWorkers: process.env.CI ? 8 : 4,
    include: ["contract/**/*.spec.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
