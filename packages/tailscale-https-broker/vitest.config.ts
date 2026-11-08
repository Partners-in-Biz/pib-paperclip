import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the CI runner
    maxWorkers: process.env.CI ? 8 : 4,
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
