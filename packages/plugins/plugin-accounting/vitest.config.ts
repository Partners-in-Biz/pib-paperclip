import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the CI runner
    maxWorkers: 4, // shared Postgres in CI: do not raise (PAR-7244)
    environment: "node",
    // real-Postgres integration suite: 5s default is too tight on the loaded self-hosted runner
    testTimeout: 30000,
    include: ["tests/**/*.spec.ts"],
  },
});
