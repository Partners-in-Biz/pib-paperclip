import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// PAR-13933: same throwaway server as the default e2e config, pointed at the Planning Canvas perf spec.
// PLANNING_CANVAS_CHROME_PATH lets a host without the Playwright browser download use a local Chromium.
const chromePath = process.env.PLANNING_CANVAS_CHROME_PATH;

export default defineConfig({
  ...base,
  testDir: path.resolve(import.meta.dirname, "../../ui/e2e"),
  testMatch: process.env.PLANNING_CANVAS_SPEC ?? "planning-canvas-perf.spec.ts",
  testIgnore: [],
  timeout: 240_000,
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium", ...(chromePath ? { launchOptions: { executablePath: chromePath, args: ["--no-sandbox"] } } : {}) },
    },
  ],
});
