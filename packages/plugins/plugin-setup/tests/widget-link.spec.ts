import { describe, expect, it } from "vitest";
import { prefixFromPath, withCompanyPrefix } from "../src/ui/index.js";

describe("dashboard widget links", () => {
  it("reads the company prefix from the host path", () => {
    expect(prefixFromPath("/PAR/dashboard")).toBe("PAR");
    expect(prefixFromPath("/dashboard")).toBeNull();
    expect(prefixFromPath(null)).toBeNull();
  });
  it("prefixes /setup once and leaves other links alone", () => {
    expect(withCompanyPrefix("/setup", "PAR")).toBe("/PAR/setup");
    expect(withCompanyPrefix("/par/setup", "PAR")).toBe("/par/setup");
    expect(withCompanyPrefix("/setup", null)).toBe("/setup");
    expect(withCompanyPrefix("https://example.com/a", "PAR")).toBe("https://example.com/a");
  });
});
