import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// PAR-13949: same throwaway server as the default e2e config, pointed at the keyboard spec.
const chromePath = process.env.PLANNING_CANVAS_CHROME_PATH;

export default defineConfig({
  ...base,
  testDir: path.resolve(import.meta.dirname, "../../ui/e2e"),
  testMatch: "planning-canvas-keyboard.spec.ts",
  testIgnore: [],
  timeout: 180_000,
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium", ...(chromePath ? { launchOptions: { executablePath: chromePath, args: ["--no-sandbox"] } } : {}) },
    },
  ],
});
