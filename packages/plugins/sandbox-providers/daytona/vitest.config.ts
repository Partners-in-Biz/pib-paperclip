import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "../../../..");

export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
      "@paperclipai/plugin-sdk": path.resolve(dirname, "../../sdk/src/index.ts"),
    },
  },
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the CI runner
    maxWorkers: process.env.CI ? 8 : 4,
    include: [path.join(dirname, "src/**/*.test.ts")],
    environment: "node",
  },
});
