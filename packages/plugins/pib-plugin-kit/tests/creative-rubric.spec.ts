import { describe, expect, it } from "vitest";
import { CREATIVE_PASS_SCORE, REVIEWER_TONE_CAP, scoreCreative, type CreativeRubricInput } from "../src/index.js";

const good: CreativeRubricInput = {
  platform: "linkedin",
  text: "Why do most invoices arrive late?\nWe fixed ours in a week.\nBook a call with us today.",
  media: [{ altText: "A chart of days to payment falling from 40 to 12" }],
  landingUrl: "https://partnersinbiz.online/book",
};

describe("scoreCreative", () => {
  it("passes at exactly 80 with tone unscored", () => {
    const r = scoreCreative(good);
    expect(r.parts).toEqual({ hook: 20, clarity: 20, brand: 10, cta: 15, format: 15 });
    expect(r.score).toBe(80);
    expect(r.pass).toBe(true);
    expect(r.notes.join(" ")).toContain("Tone is not scored");
  });

  it("fails at 79", () => {
    const r = scoreCreative({ ...good, tone: { score: 9, source: "reviewer", reason: "Reads a little stiff." } });
    expect(r.score).toBe(79);
    expect(r.pass).toBe(false);
    expect(CREATIVE_PASS_SCORE).toBe(80);
  });

  it("fails on a blocker even at 95", () => {
    const r = scoreCreative({ ...good, tone: { score: 20, source: "reviewer", reason: "On brand." }, bannedWords: ["invoices"] });
    expect(r.blockers[0]?.rule).toBe("banned_word");
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.pass).toBe(false);
  });

  it("caps a reviewer's tone at 15 and needs a reason", () => {
    const high = scoreCreative({ ...good, tone: { score: 20, source: "reviewer", reason: "Warm and plain." } });
    expect(high.parts.brand).toBe(REVIEWER_TONE_CAP);
    expect(high.score).toBe(85);
    expect(scoreCreative({ ...good, tone: { score: 20, source: "reviewer" } }).parts.brand).toBe(10);
  });

  it("does not let a self-awarded tone raise the score", () => {
    expect(scoreCreative({ ...good, tone: { score: 20, source: "self", reason: "Great." } }).parts.brand).toBe(10);
  });

  it("takes 5 off clarity for each writing finding", () => {
    const r = scoreCreative({ ...good, text: `${good.text} We might utilize it.` });
    expect(r.writing.length).toBe(2);
    expect(r.parts.clarity).toBe(10);
  });

  it("scores a long or hookless first line low", () => {
    const r = scoreCreative({ ...good, text: "Our team of experienced people is very happy to tell you about the new service we have built.\nBook a call." });
    expect(r.parts.hook).toBe(0);
  });

  it("scores the ask: none is 0, two is 5", () => {
    expect(scoreCreative({ ...good, text: "Why do invoices arrive late?" }).parts.cta).toBe(0);
    expect(scoreCreative({ ...good, text: "Why do invoices arrive late?\nBook a call with us and follow us." }).parts.cta).toBe(5);
  });

  it("checks alt text, the platform limit and an https landing page", () => {
    expect(scoreCreative({ ...good, media: [{ altText: " " }] }).parts.format).toBe(10);
    expect(scoreCreative({ ...good, platform: "x" , text: `${good.text} ${"a".repeat(300)}` }).parts.format).toBe(10);
    expect(scoreCreative({ ...good, landingUrl: "http://example.com" }).parts.format).toBe(10);
    expect(scoreCreative({ ...good, landingUrl: "not a url" }).parts.format).toBe(10);
  });

  it("blocks a claim with no approved wording, and allows an approved one", () => {
    const claimTerms = [{ re: /\bguarantee(d|s)?\b/i, why: "a guarantee" }];
    const text = "Why do invoices arrive late?\nWe guarantee payment in 7 days.\nBook a call.";
    const blocked = scoreCreative({ ...good, text, claimTerms });
    expect(blocked.blockers[0]?.rule).toBe("claim_unapproved");
    expect(blocked.pass).toBe(false);
    const ok = scoreCreative({ ...good, text, claimTerms, approvedFacts: ["We guarantee payment in 7 days, in writing."] });
    expect(ok.blockers).toEqual([]);
  });
});
