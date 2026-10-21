import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_RULE, CREATIVE_PASS_SCORE, REVIEWER_TONE_CAP, scoreCreative, type CreativeRubricInput } from "../src/index.js";

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

  describe("media rule", () => {
    const bare = { ...good, media: [] };
    const block = { ...DEFAULT_MEDIA_RULE, enforce: "block" as const };
    const running = { id: "e1", status: "running", hypothesisType: "media", minPerArm: 3, noMediaPosts: 1 };

    it("does nothing without a rule", () => {
      expect(scoreCreative(bare).blockers).toEqual([]);
    });
    it("warns, never blocks, under enforce: advise", () => {
      const r = scoreCreative({ ...bare, mediaRule: DEFAULT_MEDIA_RULE });
      expect(r.blockers).toEqual([]);
      expect(r.notes.join(" ")).toContain("need one image or a video");
      expect(r.pass).toBe(true);
    });
    it("blocks media_required under enforce: block", () => {
      const r = scoreCreative({ ...bare, mediaRule: block });
      expect(r.blockers.map((b) => b.rule)).toEqual(["media_required"]);
      expect(r.pass).toBe(false);
    });
    it("lets a text-native post and an X post go without media", () => {
      expect(scoreCreative({ ...bare, mediaRule: block, textNative: true }).blockers).toEqual([]);
      expect(scoreCreative({ ...bare, platform: "x", mediaRule: block }).blockers).toEqual([]);
    });
    it("does not count a video over 30 seconds", () => {
      const r = scoreCreative({ ...bare, mediaRule: block, media: [{ kind: "video", durationSec: 45, altText: "A clip" }] });
      expect(r.blockers.map((b) => b.rule)).toEqual(["media_required"]);
    });
    it("blocks alt_text_missing under enforce: block", () => {
      const r = scoreCreative({ ...good, mediaRule: block, media: [{ altText: " " }] });
      expect(r.blockers.map((b) => b.rule)).toEqual(["alt_text_missing"]);
    });
    it("exempts only a no_media post in a running media experiment", () => {
      const tagged = { ...bare, mediaRule: block, experimentId: "e1", arm: "no_media" };
      expect(scoreCreative({ ...tagged, experiment: running }).blockers).toEqual([]);
      expect(scoreCreative({ ...tagged, experiment: { ...running, hypothesisType: "hook" } }).blockers).toHaveLength(1);
      expect(scoreCreative({ ...tagged, experiment: null }).blockers).toHaveLength(1);
      expect(scoreCreative({ ...tagged, experiment: { ...running, noMediaPosts: 4 } }).blockers).toHaveLength(1);
    });
  });
});
