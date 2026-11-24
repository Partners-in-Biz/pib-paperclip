import { defineConfig } from "@playwright/test";
import perf from "./playwright-planning-canvas-perf.config";

// PAR-13942: the perf config's throwaway server and browser, pointed at the realtime UI spec.
export default defineConfig({
  ...perf,
  testMatch: "planning-canvas-realtime.spec.ts",
  timeout: 120_000,
});
