import { afterEach, describe, expect, it } from "vitest";
import {
  planningCanvasChatOn,
  planningCanvasEngageOn,
  planningCanvasFlowsOn,
  planningCanvasUnfurlOn,
} from "./planning-canvas-switches.js";

const SWITCHES = [
  ["PLANNING_CANVAS_CHAT", planningCanvasChatOn],
  ["PLANNING_CANVAS_FLOWS", planningCanvasFlowsOn],
  ["PLANNING_CANVAS_ENGAGE", planningCanvasEngageOn],
  ["PLANNING_CANVAS_UNFURL", planningCanvasUnfurlOn],
] as const;

describe("planning canvas switches", () => {
  const saved = Object.fromEntries(SWITCHES.map(([name]) => [name, process.env[name]]));
  afterEach(() => {
    for (const [name] of SWITCHES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  for (const [name, isOn] of SWITCHES) {
    it(`${name}: off by default, on only for on/true/1, read on every call`, () => {
      delete process.env[name];
      expect(isOn()).toBe(false);
      for (const value of ["on", "true", "1", " TRUE "]) {
        process.env[name] = value;
        expect(isOn()).toBe(true);
      }
      for (const value of ["off", "false", "0", "", "yes"]) {
        process.env[name] = value;
        expect(isOn()).toBe(false);
      }
    });

    it(`${name}: a read that throws counts as off`, () => {
      const original = process.env;
      Object.defineProperty(process, "env", {
        configurable: true,
        value: new Proxy({}, { get: () => { throw new Error("unreadable"); } }),
      });
      try {
        expect(isOn()).toBe(false);
      } finally {
        Object.defineProperty(process, "env", { configurable: true, value: original });
      }
    });
  }
});
