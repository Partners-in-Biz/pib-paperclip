import { defineConfig } from "@playwright/test";
import perf from "./playwright-planning-canvas-perf.config";

// PAR-13934: the perf config's throwaway server and browser, pointed at the op store spec.
export default defineConfig({
  ...perf,
  testMatch: "planning-canvas-ops.spec.ts",
  timeout: 120_000,
});
