import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the CI runner
    maxWorkers: 4, // shared Postgres in CI: do not raise (PAR-7244)
    include: ["tests/**/*.spec.ts"],
    environment: "node",
  },
});
