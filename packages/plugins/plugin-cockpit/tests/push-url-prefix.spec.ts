import { describe, expect, it, vi } from "vitest";

vi.mock("../src/push/store.js", () => ({}));

import { withCompanyPrefix } from "../src/push/send.js";

describe("withCompanyPrefix", () => {
  it("prefixes bare relative paths with the company prefix", () => {
    expect(withCompanyPrefix("/issues/PAR-1", "PAR")).toBe("/PAR/issues/PAR-1");
    expect(withCompanyPrefix("/cockpit", "PAR")).toBe("/PAR/cockpit");
  });

  it("sends the root to the dashboard", () => {
    expect(withCompanyPrefix("/", "PAR")).toBe("/PAR/dashboard");
  });

  it("leaves already prefixed paths alone, case-insensitively", () => {
    expect(withCompanyPrefix("/PAR/issues/PAR-1", "PAR")).toBe("/PAR/issues/PAR-1");
    expect(withCompanyPrefix("/par/issues/PAR-1", "PAR")).toBe("/par/issues/PAR-1");
    expect(withCompanyPrefix("/PAR", "PAR")).toBe("/PAR");
  });

  it("leaves absolute, protocol-relative and prefix-less cases alone", () => {
    expect(withCompanyPrefix("https://example.com/x", "PAR")).toBe("https://example.com/x");
    expect(withCompanyPrefix("//example.com/x", "PAR")).toBe("//example.com/x");
    expect(withCompanyPrefix("/issues/PAR-1", null)).toBe("/issues/PAR-1");
  });

  it("does not treat a longer segment sharing the prefix as already prefixed", () => {
    expect(withCompanyPrefix("/PARTNERS/x", "PAR")).toBe("/PAR/PARTNERS/x");
  });
});
