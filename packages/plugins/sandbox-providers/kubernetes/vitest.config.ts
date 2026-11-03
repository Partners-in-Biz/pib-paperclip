import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the CI runner
    maxWorkers: process.env.CI ? 8 : 4,
    include: [
      "test/unit/**/*.test.ts",
      ...(process.env.RUN_K8S_INTEGRATION_TESTS === "1" ? ["test/integration/**/*.test.ts"] : []),
    ],
    testTimeout: process.env.RUN_K8S_INTEGRATION_TESTS === "1" ? 120_000 : 5_000,
    environment: "node",
  },
});
