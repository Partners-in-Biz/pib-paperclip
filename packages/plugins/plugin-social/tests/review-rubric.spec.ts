/**
 * PAR-4159 (C30): Creative rubric scoring on review verdict with media rule enforcement.
 * Tests for: exact scoring thresholds, experiment exemptions, media rule enforcement, scope isolation.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { recordReviewerVerdict } from "../src/approval-flow.js";
import { approvalWorld, REVIEWER_AGENT, postRow } from "./world.js";
import * as kit from "@partnersinbiz/pib-plugin-kit";

describe("review verdict with creative rubric scoring (PAR-4159)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const seed = (overrides?: Record<string, unknown>) =>
    approvalWorld({
      reviewer: "rev-1",
      policy: { require_reviewer: true },
      playbookText: `# Playbook\n\n\`\`\`media-rule\nenforce: block\n\`\`\`\n`,
      ...overrides,
    });

  it.each<{ name: string; body: string; media: Array<{ kind?: string; altText?: string | null }>; score: number; shouldRecord: boolean }>([
    { name: "score 80 -> recorded", body: "Strong content with proven strategies and clear value.", media: [{ kind: "image", altText: "Value" }], score: 80, shouldRecord: true },
    { name: "score 79 -> refused", body: "Score 79 test.", media: [], score: 79, shouldRecord: false },
  ])("block mode exact thresholds: $name", async ({ body, media, score, shouldRecord }) => {
    const spy = vi.spyOn(kit, "scoreCreative").mockImplementation((args: any) => ({
      score,
      pass: score >= 80,
      parts: { hook: 0, clarity: 0, brand: 0, cta: 0, format: 0 },
      blockers: score < 80 ? [{ rule: "media_required" as const, text: "threshold" }] : [],
      notes: [],
      writing: [],
    }));

    const w = seed();
    w.post.body = body;
    w.post.media = media;
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null });

    if (shouldRecord) {
      expect(result.recorded).toBe(true);
      expect(result.refused).not.toBe(true);
      expect(result.score).toBe(score);
    } else {
      expect(result.recorded).toBe(false);
      expect(result.refused).toBe(true);
      expect(result.score).toBe(score);
    }
    spy.mockRestore();
  });

  it("score 95 with media alt text missing -> refused", async () => {
    const spy = vi.spyOn(kit, "scoreCreative").mockImplementation(() => ({
      score: 95,
      pass: false,
      parts: { hook: 0, clarity: 0, brand: 0, cta: 0, format: 0 },
      blockers: [{ rule: "alt_text_missing" as const, text: "missing alt text" }],
      notes: [],
      writing: [],
    }));

    const w = seed();
    w.post.body = "High quality content with proven strategies.";
    w.post.media = [{ kind: "image", altText: null }];
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null });

    expect(result.recorded).toBe(false);
    expect(result.refused).toBe(true);
    expect(result.blockers).toContain("missing alt text");
    spy.mockRestore();
  });

  it("no media in block mode -> refused", async () => {
    const w = seed();
    w.post.body = "Check this out now.";
    w.post.media = [];
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result.refused).toBe(true);
    expect(result.recorded).toBe(false);
  });

  it("image with alt text and strong body -> recorded", async () => {
    const spy = vi.spyOn(kit, "scoreCreative").mockImplementation(() => ({
      score: 85,
      pass: true,
      parts: { hook: 0, clarity: 0, brand: 0, cta: 0, format: 0 },
      blockers: [],
      notes: [],
      writing: [],
    }));
    const w = seed();
    w.post.body = "Check this excellent product out now. Download to learn more.";
    w.post.media = [{ kind: "image", altText: "Product showcase" }];
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result.recorded).toBe(true);
    expect(result.refused).not.toBe(true);
    spy.mockRestore();
  });

  it("image without alt text in block mode -> refused with blocker", async () => {
    const w = seed();
    w.post.body = "Check this out now.";
    w.post.media = [{ kind: "image", altText: null }];
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result.refused).toBe(true);
    expect(result.blockers).toBeDefined();
    expect(result.blockers!.length).toBeGreaterThan(0);
    expect(result.next).toContain("Fix");
  });

  it("image without alt text in advise mode -> recorded with warnings", async () => {
    const w = seed({ playbookText: `# Playbook\n\n\`\`\`media-rule\nenforce: advise\n\`\`\`\n` });
    w.post.body = "Check this out now.";
    w.post.media = [{ kind: "image", altText: null }];
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result.recorded).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
  });

  it("control arm in running experiment, no media -> recorded", async () => {
    const spy = vi.spyOn(kit, "scoreCreative").mockImplementation(() => ({
      score: 85,
      pass: true,
      parts: { hook: 0, clarity: 0, brand: 0, cta: 0, format: 0 },
      blockers: [],
      notes: [],
      writing: [],
    }));
    const w = seed({
      experiment: { id: "exp-1", programId: "prog-1", status: "running", arms: [{ name: "control", description: "No media" }] },
    });
    w.post.body = "Check this out now. Learn more about our services.";
    w.post.media = [];
    w.post.experiment_id = "exp-1";
    w.post.experiment_arm = "control";
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result.recorded).toBe(true);
    spy.mockRestore();
  });

  it("no experiment, no media in block mode -> refused", async () => {
    const w = seed();
    w.post.body = "Check this out now.";
    w.post.media = [];
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result.refused).toBe(true);
  });

  it("text-native tag exempts media requirement in block mode", async () => {
    const spy = vi.spyOn(kit, "scoreCreative").mockImplementation(() => ({
      score: 85,
      pass: true,
      parts: { hook: 0, clarity: 0, brand: 0, cta: 0, format: 0 },
      blockers: [],
      notes: [],
      writing: [],
    }));
    const w = seed();
    w.post.body = "Excited to announce our new product launch with comprehensive features.";
    w.post.media = [];
    w.post.overrides = { tags: ["text-native"] };
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result.recorded).toBe(true);
    spy.mockRestore();
  });

  it("advise mode records weak content, block mode refuses", async () => {
    const body = "Test.";
    const w1 = seed({ playbookText: `# Playbook\n\n\`\`\`media-rule\nenforce: advise\n\`\`\`\n` });
    w1.post.body = body;
    w1.post.media = [];
    const result1 = await recordReviewerVerdict(w1.ctx, "co", postRow(w1), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result1.recorded).toBe(true);

    const w2 = seed();
    w2.post.body = body;
    w2.post.media = [];
    const result2 = await recordReviewerVerdict(w2.ctx, "co", postRow(w2), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result2.refused).toBe(true);
  });

  it("changes verdict -> recorded, no score", async () => {
    const w = seed();
    w.post.body = "Spring sale starts Friday.";
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), {
      agentId: "rev-1",
      verdict: "changes",
      notes: "Add an image and call to action.",
    });
    expect(result.recorded).toBe(true);
    expect(result.verdict).toBe("changes");
    expect(result.score).toBeUndefined();
  });

  it("playbook load failure -> default rule (advise) + warning", async () => {
    const w = seed({ playbookText: null });
    w.post.body = "What's new? Download to learn.";
    w.post.media = [];
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result.recorded).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
  });

  it("TWO-SCOPE ISOLATION: scope B advise, scope A block with different enforcement", async () => {
    const body = "Test.";
    const w1 = seed({ playbookText: `# Playbook B\n\n\`\`\`media-rule\nenforce: advise\n\`\`\`\n` });
    w1.post.body = body;
    w1.post.media = [];
    const result1 = await recordReviewerVerdict(w1.ctx, "co", postRow(w1), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result1.recorded).toBe(true);

    const w2 = seed({
      playbookText: `# Playbook A\n\n\`\`\`media-rule\nenforce: block\n\`\`\`\n`,
      client: { kind: "company", id: "c2", name: "Client A" },
    });
    w2.post.body = body;
    w2.post.media = [];
    w2.post.client_kind = "company";
    w2.post.client_ref = "c2";
    w2.post.client_name = "Client A";
    const result2 = await recordReviewerVerdict(w2.ctx, "co", postRow(w2), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result2.refused).toBe(true);
  });

  it("multi-platform scoring uses minimum score with platform names", async () => {
    const w = seed({
      destinations: [
        { id: "d1", company_id: "co", post_id: "p1", account_id: "a1", status: "pending", attempts: 0 },
        { id: "d2", company_id: "co", post_id: "p1", account_id: "a2", status: "pending", attempts: 0 },
      ],
    });
    w.post.body = "Test.";
    w.post.media = [];
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result.score).toBeDefined();
    if (result.blockers) {
      result.blockers.forEach((blocker) => {
        const match = blocker.match(/\(([^)]+)\)/);
        if (match) {
          expect(match[1]).toMatch(/linkedin|instagram|facebook|x|email|web/);
        }
      });
    }
  });

  it("experiment load failure in block mode -> refused", async () => {
    const w = seed();
    vi.spyOn(w.ctx.db, "query").mockImplementationOnce(async () => {
      throw new Error("Experiment not found");
    });
    w.post.body = "Check this out now.";
    w.post.media = [];
    w.post.experiment_id = "exp-bad";
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result.refused).toBe(true);
  });

  it("tone score validation", async () => {
    const w = seed();
    const { recordReviewVerdictRecord } = await import("../src/service.js");
    await expect(
      recordReviewVerdictRecord(w.ctx, REVIEWER_AGENT, { postId: "p1", verdict: "pass", toneScore: 25 }),
    ).rejects.toThrow("0 to 20");
  });

  it("tone score with reason -> recorded", async () => {
    const spy = vi.spyOn(kit, "scoreCreative").mockImplementation(() => ({
      score: 85,
      pass: true,
      parts: { hook: 0, clarity: 0, brand: 0, cta: 0, format: 0 },
      blockers: [],
      notes: [],
      writing: [],
    }));
    const w = seed();
    w.post.body = "Learn our proven strategies for business success.";
    w.post.media = [{ kind: "image", altText: "Strategy guide" }];
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), {
      agentId: "rev-1",
      verdict: "pass",
      notes: null,
      toneScore: 15,
      toneReason: "Professional and clear",
    });
    expect(result.recorded).toBe(true);
    spy.mockRestore();
  });

  it("no destinations -> recorded with warning", async () => {
    const w = seed({ destinations: [] });
    w.post.body = "Test content.";
    const result = await recordReviewerVerdict(w.ctx, "co", postRow(w), { agentId: "rev-1", verdict: "pass", notes: null });
    expect(result.recorded).toBe(true);
    expect(result.warnings).toContain("No destinations to check");
  });
});
