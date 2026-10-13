import { describe, it, expect } from "vitest";
import { normalizeE164, phoneRegion } from "../src/phone.js";

describe("normalizeE164", () => {
  it.each([
    ["082 123 4567", "ZA", "+27821234567"],
    ["0821234567", "ZA", "+27821234567"],
    ["+27 82 123 4567", "ZA", "+27821234567"],
    ["+27 (0) 82 123 4567", "ZA", "+27821234567"],
    ["0027821234567", "ZA", "+27821234567"],
    ["27821234567", "ZA", "+27821234567"],
    ["011 555 1234", "ZA", "+27115551234"],
    ["0115551234", "ZA", "+27115551234"],
    ["(415) 555-2671", "ZA", null],
    ["14155552671", "ZA", null],
    ["(415) 555-2671", "US", "+14155552671"],
    ["+1 415 555 2671", "US", "+14155552671"],
    ["14155552671", "US", "+14155552671"],
    ["+1 115 555 2671", "ZA", null],
    ["+1 415 015 2671", "ZA", null],
    ["+44 20 7946 0958", "ZA", "+442079460958"],
    ["", "ZA", null],
    ["abc", "ZA", null],
    ["+27 12", "ZA", null],
    ["+27 82 123 45678", "ZA", null],
    ["082 123 456", "ZA", null],
    ["+0123456789", "ZA", null],
    ["82 x123", "ZA", null],
  ])("norm %s/%s", (input, region, expected) => {
    expect(normalizeE164(input, region as "ZA" | "US")).toBe(expected);
  });
  it("idempotent", () => {
    const r = normalizeE164("+27 82 123 4567")!;
    expect(normalizeE164(r)).toBe(r);
  });
});

describe("phoneRegion", () => {
  it.each([["+27821234567", "ZA"], ["+14155552671", "US"], ["+442079460958", "OTHER"]])("detect %s", (e164, exp) => {
    expect(phoneRegion(e164)).toBe(exp);
  });
});
