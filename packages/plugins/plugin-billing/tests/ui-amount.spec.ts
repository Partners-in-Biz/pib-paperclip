import { describe, expect, it } from "vitest";
import { toMinor, tryMinor } from "../src/ui/amount.js";

describe("amount parsing in the UI", () => {
  it("reads South African and plain formats into minor units", () => {
    expect(toMinor("1 234,50")).toBe(123450);
    expect(toMinor("1234.5")).toBe(123450);
    expect(toMinor("R 99")).toBe(9900);
  });

  it("tryMinor never throws, so a form can check an empty box while rendering", () => {
    expect(tryMinor("")).toBeNull();
    expect(tryMinor("abc")).toBeNull();
    expect(tryMinor("12.00")).toBe(1200);
  });

  it("toMinor still throws for an empty amount on submit", () => {
    expect(() => toMinor("")).toThrow("Enter a valid amount");
  });
});
