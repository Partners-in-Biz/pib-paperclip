import { defineConfig } from "vitest/config";

/** Cross-plugin contract tests (read every PiB plugin's sources). */
export default defineConfig({
  test: {
    include: ["contract/**/*.spec.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
