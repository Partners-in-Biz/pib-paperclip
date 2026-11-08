import { configDefaults, defineConfig } from "vitest/config";
import { retryReporterEnabled } from "./scripts/ci/vitest-retry.mjs";

export default defineConfig({
  test: {
    // PAR-7244: hard cap for local/agent runs on the shared VPS; larger only on the self-hosted CI runner.
    // GitHub-hosted runners have 4 vCPUs, so they keep vitest's default (cores - 1) instead of running 8.
    maxWorkers: process.env.RUNNER_ENVIRONMENT === "github-hosted" ? undefined : process.env.CI ? 8 : 4,
    reporters: [...configDefaults.reporters,
      ...(process.env.GITHUB_ACTIONS === "true"
        ? ["./scripts/ci/test-timing-reporter.mjs", "./scripts/ci/oversized-test-files.mjs"] : []),
      ...(process.env.PAPERCLIP_CI_PROFILE === "true" ? ["./scripts/ci-profile/vitest-reporter.mjs"] : []),
      // PR lanes pass --retry from scripts/run-vitest-stable.mjs; see scripts/ci/vitest-retry.mjs.
      ...(retryReporterEnabled() ? ["./scripts/ci/retry-reporter.mjs"] : [])],
    projects: [
      "packages/shared",
      "packages/skills-catalog",
      "packages/db",
      "packages/adapter-utils",
      "packages/adapters/claude-local",
      "packages/adapters/codex-local",
      "packages/adapters/cursor-cloud",
      "packages/adapters/cursor-local",
      "packages/adapters/gemini-local",
      "packages/adapters/grok-local",
      "packages/adapters/hermes",
      "packages/adapters/kimi-local",
      "packages/adapters/openclaw-gateway",
      "packages/adapters/opencode-local",
      "packages/adapters/pi-local",
      "packages/plugins/sdk",
      "packages/plugins/create-paperclip-plugin",
      "packages/plugins/sandbox-providers/daytona",
      "server",
      "ui",
      "cli",
    ],
  },
});
