import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the CI runner
    maxWorkers: process.env.CI ? undefined : 4, // CI keeps pre-PR behaviour (shared Postgres); local/agent runs capped (PAR-7244)
    include: ["tests/**/*.spec.ts"],
    environment: "node",
  },
});
