import { describe, expect, it } from "vitest";
import { AD_POLICY_CLAIMS, CLAIM_TERMS } from "../src/claims.js";

const adRules = (text: string) => AD_POLICY_CLAIMS.filter((c) => c.pattern.test(text)).map((c) => c.rule);
const termWhys = (text: string) => CLAIM_TERMS.filter((c) => c.re.test(text)).map((c) => c.why);

describe("AD_POLICY_CLAIMS", () => {
  it("has unique rules and a hint on each", () => {
    expect(new Set(AD_POLICY_CLAIMS.map((c) => c.rule)).size).toBe(AD_POLICY_CLAIMS.length);
    for (const c of AD_POLICY_CLAIMS) expect(c.hint.length).toBeGreaterThan(0);
  });
  it.each([
    ["Guaranteed results", "guarantee"],
    ["Risk-free trial", "risk_free"],
    ["The best in town", "superlative"],
    ["100% safe", "absolute_pct"],
    ["Instant relief", "miracle"],
    ["See before and after", "before_after"],
    ["Are you diabetic?", "personal_attribute"],
    ["LIMITED OFFER ENDS TODAY", "urgency_caps"],
  ])("flags %s as %s", (text, rule) => {
    expect(adRules(text)).toContain(rule);
  });
  it("leaves plain copy alone", () => {
    expect(adRules("Fresh bread baked every morning")).toEqual([]);
  });
});

describe("CLAIM_TERMS", () => {
  it.each([
    ["A reserve price applies", "a reserve price"],
    ["We offer a warranty", "a warranty"],
    ["Free delivery on all orders", "free delivery"],
    ["Fully accredited by SAQA", "accreditation or certification"],
    ["Licences are required to bid", "licensing rules"],
  ])("flags %s", (text, why) => {
    expect(termWhys(text)).toContain(why);
  });
  it("does not flag a licence page mention", () => {
    expect(termWhys("See our licence page")).not.toContain("licensing rules");
  });
});
