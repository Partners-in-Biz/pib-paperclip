import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Per-person access browser suites (PAR-12608 AC-G10; PAR-12930 C4g-2a, reused by
// C4g-2b). A restricted person is a second signed-in user, so this server runs in
// `authenticated` mode with its own throwaway home. The member-restriction kill
// switch is left unset here, on this test server only, so a company can be set to
// `enforce`; no shipped instance changes.
const PORT = Number(process.env.PAPERCLIP_E2E_MR_PORT ?? 3197);
const BASE_URL = `http://127.0.0.1:${PORT}`;
// Workers reload this config: keep the main process's home, or they would point at a new empty one.
const PAPERCLIP_HOME = process.env.PAPERCLIP_E2E_MR_HOME
  ?? fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-e2e-mr-home-"));
const PAPERCLIP_INSTANCE_ID = "playwright-e2e-member-restriction";
const PAPERCLIP_CONFIG = path.join(PAPERCLIP_HOME, "instances", PAPERCLIP_INSTANCE_ID, "config.json");
const AUTH_SECRET = "playwright-e2e-member-restriction-secret";

process.env.PAPERCLIP_E2E_MR_BASE_URL = BASE_URL;
process.env.PAPERCLIP_E2E_MR_HOME = PAPERCLIP_HOME;
process.env.PAPERCLIP_E2E_MR_CONFIG = PAPERCLIP_CONFIG;

const { PAPERCLIP_MEMBER_RESTRICTION: _killSwitch, ...inheritedEnv } = process.env;

export default defineConfig({
  testDir: ".",
  testMatch: "member-restriction-*.spec.ts",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...(process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL ? { channel: process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL } : {}),
    // A host whose installed Chromium differs from this Playwright's build can point at it.
    ...(process.env.PAPERCLIP_E2E_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PAPERCLIP_E2E_CHROMIUM_PATH } } : {}),
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    cwd: path.resolve(import.meta.dirname, "../.."),
    // Same shipped-UI build as `playwright.config.ts`; set PAPERCLIP_E2E_SKIP_UI_BUILD=1
    // to reuse a `server/ui-dist` that is already built from this checkout.
    command: `${process.env.PAPERCLIP_E2E_SKIP_UI_BUILD === "1" ? "" : "pnpm --filter @paperclipai/ui build --outDir ../server/ui-dist --emptyOutDir && "}node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts onboard --yes --run`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...inheritedEnv,
      NODE_ENV: "test",
      PAPERCLIP_UI_DEV_MIDDLEWARE: "false",
      PORT: String(PORT),
      PAPERCLIP_OPEN_ON_LISTEN: "false",
      PAPERCLIP_API_URL: BASE_URL,
      PAPERCLIP_PUBLIC_URL: BASE_URL,
      PAPERCLIP_HOME,
      PAPERCLIP_INSTANCE_ID,
      PAPERCLIP_CONFIG,
      BETTER_AUTH_SECRET: AUTH_SECRET,
      PAPERCLIP_AGENT_JWT_SECRET: AUTH_SECRET,
      PAPERCLIP_BIND: "loopback",
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    },
  },
  outputDir: "./test-results/member-restriction",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report/member-restriction" }]],
});
