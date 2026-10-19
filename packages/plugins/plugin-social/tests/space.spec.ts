import { describe, expect, it } from "vitest";
import { spaceOf } from "../src/space.js";

describe("spaceOf", () => {
  it("defaults to the company and accepts me", () => {
    expect(spaceOf({})).toBe("company");
    expect(spaceOf({ space: "company" })).toBe("company");
    expect(spaceOf({ space: "me" })).toBe("me");
  });
  it("refuses anything else instead of falling back to the company", () => {
    expect(() => spaceOf({ space: "team" })).toThrow(/space must be/);
  });
});
