import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@paperclipai/paperclip-runner/react", replacement: resolve(packageRoot, "src/react/index.ts") },
      { find: "@paperclip-runner-local/capability", replacement: resolve(packageRoot, "src/scenarios/index.ts") },
    ],
  },
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the self-hosted CI runner.
    // GitHub-hosted runners have 4 vCPUs, so they keep vitest's default (cores - 1) instead of running 8.
    maxWorkers: process.env.RUNNER_ENVIRONMENT === "github-hosted" ? undefined : process.env.CI ? 8 : 4,
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "devtools/browser/src/**/*.test.ts",
      "devtools/issue-thread/src/**/*.test.ts",
      "devtools/issue-thread/src/**/*.test.tsx",
      "examples/scenario-explorer/src/**/*.test.ts",
      "examples/scenario-explorer/src/**/*.test.tsx",
      "scripts/local-runner-browser-server.test.mjs",
      "scripts/live-console-browser-server.test.mjs",
    ],
  },
});
