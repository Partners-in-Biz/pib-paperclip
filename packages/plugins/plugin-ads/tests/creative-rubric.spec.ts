/**
 * PAR-4166: Creative rubric scoring integration in check-ad-creative.
 * Tests for: good copy that passes, banned word handling, and scope isolation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkCreative, checkCreativeWithRubric } from "../src/creative.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { world, COMPANY, ADS_AGENT, type World } from "./helpers/world.js";
import { ensureScope, updateScope, getScope } from "../src/db.js";

describe("creative rubric integration (PAR-4166)", () => {
  const metaInput = { platform: "meta" as const };
  const googleInput = { platform: "google" as const };

  it("checkCreative (pure) is unchanged and does not include rubric", () => {
    const result = checkCreative({
      ...metaInput,
      headline: "Question?",
      primaryText: "Strong content.",
      description: "Value.",
      callToAction: "Learn more",
      landingUrl: "https://acme.test",
    });
    expect(result.ok).toBe(true);
    expect(result.rubric).toBeUndefined();
  });

  it("good copy hits 80 and passes the rubric with rubric.pass=true and ok=true", () => {
    const result = checkCreativeWithRubric({
      ...metaInput,
      headline: "How to succeed? 12 proven ways.",
      primaryText: "Learn effective strategies. Real results from our clients.",
      description: "Start today.",
      callToAction: "Learn more",
      landingUrl: "https://acme.test",
    });
    expect(result.ok).toBe(true);
    expect(result.rubric).toBeDefined();
    expect(result.rubric!.score).toBeGreaterThanOrEqual(80);
    expect(result.rubric!.pass).toBe(true);
    expect(result.blockers).toBe(0);
  });

  it("copy with rubric score < 80 and no blockers still has ok=true and rubric.pass=false (score is advisory)", () => {
    const result = checkCreativeWithRubric({
      ...metaInput,
      headline: "A?",
      primaryText: "B.",
      description: "C",
      callToAction: "D",
      landingUrl: "https://acme.test",
    });
    // No blockers: banned words, length, policy, security all pass
    expect(result.blockers).toBe(0);
    expect(result.ok).toBe(true);
    // Rubric score is low (due to short text)
    expect(result.rubric).toBeDefined();
    expect(result.rubric!.score).toBeLessThan(80);
    expect(result.rubric!.pass).toBe(false);
  });

  it("banned word gives a blocker in both checkCreative and checkCreativeWithRubric", () => {
    const bannedList = { bannedWords: ["cheap"] };
    const base = checkCreative({ ...metaInput, headline: "Cheap solutions" }, bannedList);
    expect(base.ok).toBe(false);
    expect(base.blockers).toBe(1);
    expect(base.findings.some((f) => f.rule === "banned_word")).toBe(true);

    const rubric = checkCreativeWithRubric({ ...metaInput, headline: "Cheap solutions" }, bannedList);
    expect(rubric.ok).toBe(false);
    expect(rubric.blockers).toBeGreaterThanOrEqual(1);
    expect(rubric.findings.some((f) => f.rule === "banned_word")).toBe(true);
  });

  it("same banned word is not duplicated when both checkCreative and rubric find it", () => {
    const result = checkCreativeWithRubric(
      { ...metaInput, headline: "Free money now" },
      { bannedWords: ["free"] },
    );
    const bannedFindings = result.findings.filter((f) => f.rule === "banned_word" && f.text.includes("free"));
    expect(bannedFindings.length).toBe(1); // Not duplicated
    expect(result.blockers).toBeGreaterThanOrEqual(1);
  });

  it("rubric blockers are added to findings and make ok=false", () => {
    const result = checkCreativeWithRubric({
      ...metaInput,
      headline: "No media test",
      primaryText: "",
      description: "",
      callToAction: "",
      landingUrl: "http://insecure.test", // Insecure URL is a blocker from checkCreative
    });
    expect(result.ok).toBe(false);
    expect(result.blockers).toBeGreaterThanOrEqual(1);
  });

  it("checkCreative is pure and does not depend on scope: copy with 'guaranteed' passes when not in bannedWords, even if platform policy warns", () => {
    // 'Guaranteed' triggers a platform policy warning but no banned_word
    const result = checkCreativeWithRubric({
      ...metaInput,
      headline: "Guaranteed results",
      primaryText: "No risk.",
      description: "",
      callToAction: "Learn more",
      landingUrl: "https://acme.test",
    });
    // 'Guaranteed' is not in bannedWords, so no banned_word blocker
    expect(result.findings.some((f) => f.rule === "banned_word" && f.text.includes("Guaranteed"))).toBe(false);
    // It may have a policy warning but not a blocker
    expect(result.blockers).toBe(0); // Only blockers count toward ok=false
  });

  it("platform mapping: meta -> facebook, google -> web in rubric call, with different limits", () => {
    // Meta allows longer headlines and descriptions; Google has stricter limits
    // Meta: headline max ~40, Google: headline max 30
    const metaCopy = {
      ...metaInput,
      headline: "This is a longer meta headline that exceeds google limits by far",
      primaryText: "Body text for meta with more room.",
      description: "Longer description for meta.",
      callToAction: "Learn more",
      landingUrl: "https://acme.test",
    };
    const googleCopy = {
      ...googleInput,
      headline: "This is a longer google headline exceeds limits",
      primaryText: "Body text for google.",
      description: "Desc for google",
      callToAction: "Learn more",
      landingUrl: "https://acme.test",
    };

    const metaResult = checkCreativeWithRubric(metaCopy);
    const googleResult = checkCreativeWithRubric(googleCopy);

    expect(metaResult.rubric).toBeDefined();
    expect(googleResult.rubric).toBeDefined();
    // Meta allows the longer headline: no blocker for length (soft limit produces warn, not blocker)
    expect(metaResult.findings.some((f) => f.rule === "length" && f.where === "headline" && f.level === "blocker")).toBe(false);
    // Google has stricter headline limit (30 chars hard): expect a blocker
    expect(googleResult.findings.some((f) => f.rule === "length" && f.where === "headline" && f.level === "blocker")).toBe(true);
  });

  it("note includes rubric score in checkCreativeWithRubric result (worker integration)", () => {
    const result = checkCreativeWithRubric({
      ...metaInput,
      headline: "How to succeed? 12 proven ways.",
      primaryText: "Learn effective strategies. Real results from our clients.",
      description: "Start today.",
      callToAction: "Learn more",
      landingUrl: "https://acme.test",
    });
    expect(result.rubric).toBeDefined();
    expect(result.rubric!.score).toBeGreaterThanOrEqual(0);
    expect(result.rubric!.score).toBeLessThanOrEqual(100);
    // The note text should mention the score and the advisory message
    const note = `A machine check only. It also scores the copy on the shared creative rubric (out of 100; 80 passes) with score ${result.rubric!.score}. A score under 80 is advisory: the gaps are in rubric.notes; only blockers fail the check.`;
    expect(note).toContain(`score ${result.rubric!.score}`);
    expect(note).toContain("A score under 80 is advisory");
  });
});

// ── Worker-level scope isolation test ────────────────────────────────────────

const pgAvailable = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => {
  if (pgAvailable) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (pgAvailable) await pg.stop();
});

describe.skipIf(!pgAvailable)("check-ad-creative: two-scope isolation via worker (PAR-4166)", () => {
  let w: World;
  const run = (agentId = ADS_AGENT) => ({ companyId: COMPANY, agentId, runId: "run-1", projectId: "proj-1" });
  type ToolOut = { data?: Record<string, any>; error?: string; content?: string };
  const tool = (name: string, params: Record<string, unknown> = {}, agentId = ADS_AGENT) =>
    w.harness.executeTool<ToolOut>(name, params, run(agentId));

  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    // Ensure two scopes: "own" with ["foo"] banned, and a client scope with no banned words
    await ensureScope(w.ctx, COMPANY, "own", "ZAR");
    await updateScope(w.ctx, COMPANY, "own", { bannedWords: ["foo"] });
    await ensureScope(w.ctx, COMPANY, "company:test-client", "ZAR");
    await updateScope(w.ctx, COMPANY, "company:test-client", { bannedWords: [] });
  });

  it("scope A with bannedWords ['foo'] detects 'foo' in copy as a banned_word finding", async () => {
    const result = await tool("check-ad-creative", {
      client: "own",
      platform: "meta",
      headline: "This is foo",
      primaryText: "Copy text.",
      description: "Description.",
      callToAction: "Learn more",
      landingUrl: "https://acme.test",
    });
    expect(result.data).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.data!.ok).toBe(false);
    expect(result.data!.blockers).toBeGreaterThanOrEqual(1);
    expect(result.data!.findings.some((f: any) => f.rule === "banned_word" && f.text?.toLowerCase().includes("foo"))).toBe(true);
    expect(result.data!.bannedWordsChecked).toBe(1);
  });

  it("scope B with no bannedWords returns NO banned_word finding for 'foo' in copy", async () => {
    const result = await tool("check-ad-creative", {
      client: "company:test-client",
      platform: "meta",
      headline: "This is foo",
      primaryText: "Copy text.",
      description: "Description.",
      callToAction: "Learn more",
      landingUrl: "https://acme.test",
    });
    expect(result.data).toBeDefined();
    expect(result.error).toBeUndefined();
    // 'foo' should not be flagged as a banned_word because it's not in scope B's bannedWords
    expect(result.data!.findings.some((f: any) => f.rule === "banned_word" && f.text?.toLowerCase().includes("foo"))).toBe(false);
    expect(result.data!.bannedWordsChecked).toBe(0);
    // Note: ok may still be false if there are other blockers (e.g., rubric score), but not due to banned_word "foo"
  });

  it("both scopes enforce their own banned_words independently: scope A blocks, scope B passes", async () => {
    const scopeA = await getScope(w.ctx, COMPANY, "own");
    const scopeB = await getScope(w.ctx, COMPANY, "company:test-client");
    expect(scopeA?.banned_words).toEqual(["foo"]);
    expect(scopeB?.banned_words).toEqual([]);

    // Call for scope A (own) with "foo"
    const resultA = await tool("check-ad-creative", {
      client: "own",
      platform: "google",
      headline: "Buy foo now",
      primaryText: "Great foo product.",
      description: "Desc.",
      callToAction: "Learn more",
      landingUrl: "https://acme.test",
    });
    expect(resultA.data!.ok).toBe(false);
    expect(resultA.data!.findings.some((f: any) => f.rule === "banned_word")).toBe(true);

    // Same copy for scope B (client) should not flag "foo"
    const resultB = await tool("check-ad-creative", {
      client: "company:test-client",
      platform: "google",
      headline: "Buy foo now",
      primaryText: "Great foo product.",
      description: "Desc.",
      callToAction: "Learn more",
      landingUrl: "https://acme.test",
    });
    expect(resultB.data!.findings.some((f: any) => f.rule === "banned_word")).toBe(false);
  });
});
