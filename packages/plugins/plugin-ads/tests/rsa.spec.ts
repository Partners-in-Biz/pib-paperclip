/**
 * Google responsive search ad limits, checked when the proposal is written.
 */
import { describe, expect, it } from "vitest";
import { AdsError } from "../src/domain.js";
import { RSA_LIMITS, validateResponsiveSearchAd } from "../src/rsa.js";

const URL_OK = "https://example.com/shoes?utm_source=google&utm_medium=cpc&utm_campaign=shoes";
const titles = (n: number) => Array.from({ length: n }, (_, i) => `Headline ${i + 1}`);
const lines = (n: number) => Array.from({ length: n }, (_, i) => `Description ${i + 1}`);
const ok = (patch: Record<string, unknown> = {}) => ({ headlines: titles(3), descriptions: lines(2), finalUrl: URL_OK, ...patch });
const fails = (patch: Record<string, unknown>, message: RegExp) => {
  expect(() => validateResponsiveSearchAd(ok(patch))).toThrow(AdsError);
  expect(() => validateResponsiveSearchAd(ok(patch))).toThrow(message);
};

describe("responsive search ad limits", () => {
  it("accepts the smallest and the largest legal ad", () => {
    expect(validateResponsiveSearchAd(ok())).toEqual({ headlines: titles(3), descriptions: lines(2), finalUrl: URL_OK });
    const big = validateResponsiveSearchAd(ok({ headlines: Array.from({ length: 15 }, (_, i) => `${String(i).padStart(2, "0")}${"h".repeat(28)}`), descriptions: Array.from({ length: 4 }, (_, i) => `${i}${"d".repeat(89)}`), path1: "a".repeat(15), path2: "b".repeat(15) }));
    expect(big.headlines).toHaveLength(RSA_LIMITS.maxHeadlines);
    expect(big.descriptions).toHaveLength(RSA_LIMITS.maxDescriptions);
  });

  it("needs 3 to 15 headlines", () => {
    fails({ headlines: titles(2) }, /headlines must have 3 to 15/);
    fails({ headlines: titles(16) }, /headlines must have 3 to 15/);
    fails({ headlines: undefined }, /headlines must have 3 to 15/);
  });

  it("needs 2 to 4 descriptions", () => {
    fails({ descriptions: lines(1) }, /descriptions must have 2 to 4/);
    fails({ descriptions: lines(5) }, /descriptions must have 2 to 4/);
  });

  it("holds a headline to 30 characters and a description to 90", () => {
    fails({ headlines: ["a".repeat(31), "b", "c"] }, /headline 1 is too long \(31 characters, Google allows 30/);
    fails({ descriptions: ["fine", "d".repeat(91)] }, /description 2 is too long \(91 characters, Google allows 90/);
  });

  it("rejects empty and repeated lines", () => {
    fails({ headlines: ["a", "  ", "c"] }, /headline 2 must not be empty/);
    fails({ headlines: ["Same", "same", "c"] }, /repeats an earlier headline/);
    fails({ descriptions: ["Same text", "Same text"] }, /repeats an earlier description/);
  });

  it("holds the paths to 15 characters, plain characters, and path1 first", () => {
    fails({ path1: "a".repeat(16) }, /path1 is too long/);
    fails({ path1: "a/b" }, /path1 may only hold/);
    fails({ path2: "sale" }, /path2 needs path1/);
    expect(validateResponsiveSearchAd(ok({ path1: " shoes ", path2: "" }))).toMatchObject({ path1: "shoes" });
  });

  it("needs an https final URL carrying the UTM tags", () => {
    fails({ finalUrl: "" }, /finalUrl is required/);
    fails({ finalUrl: "not a url" }, /not a valid URL/);
    fails({ finalUrl: URL_OK.replace("https", "http") }, /https/);
    fails({ finalUrl: "https://example.com/shoes" }, /add utm_source, utm_medium, utm_campaign/);
    fails({ finalUrl: "https://example.com/?utm_source=a&utm_medium=&utm_campaign=c" }, /add utm_medium/);
  });
});
