import { describe, expect, it } from "vitest";
import { backoffSeconds } from "../src/pipeline.js";

describe("backoffSeconds", () => {
  it("computes exponential backoff capped at 3600", () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(120);
    expect(backoffSeconds(3)).toBe(240);
    expect(backoffSeconds(4)).toBe(480);
    expect(backoffSeconds(5)).toBe(960);
    expect(backoffSeconds(6)).toBe(1920);
    expect(backoffSeconds(7)).toBe(3600);
    expect(backoffSeconds(8)).toBe(3600);
  });
});
