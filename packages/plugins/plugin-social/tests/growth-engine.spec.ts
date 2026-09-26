import { describe, expect, it } from "vitest";
import { recordVerdict, starterPlaybook } from "@partnersinbiz/pib-plugin-kit";
import {
  applyPlaybookChange,
  BASELINE_MIN,
  captionState,
  changeDiff,
  codeFeatures,
  featureQuestionsFor,
  featureValuesFrom,
  isoWeek,
  jevFeatureKeys,
  measureArms,
  normalizeChange,
  normalizeFeatureQuestion,
  normalizeProposal,
  playbookChangeFor,
  proposalBlocker,
  rankedHypotheses,
  readiness,
  reviewPosts,
  scoreDestinations,
  topAndBottom,
  usableFeatures,
  type FeatureQuestion,
  type MetricInput,
} from "../src/growth/engine.js";

const DAY = 24 * 3600_000;
const NOW = new Date("2026-09-26T10:00:00Z");
const at = (daysBefore: number) => new Date(NOW.getTime() - daysBefore * DAY).toISOString();

function metric(id: string, postId: string, daysBefore: number, likes: number, extra: Partial<MetricInput> = {}): MetricInput {
  return { destinationId: id, postId, accountId: "acc1", platform: "facebook", publishedAt: at(daysBefore), likes, comments: 0, shares: 0, saves: 0, clicks: 0, reach: 100, ...extra };
}

describe("score-posts baseline and lift", () => {
  it("compares with the median of the same account's earlier posts in 30 days", () => {
    const rows = [
      metric("d1", "p1", 20, 10), // rate 0.10
      metric("d2", "p2", 15, 20), // 0.20
      metric("d3", "p3", 12, 30), // 0.30
      metric("d4", "p4", 10, 40), // 0.40 → baseline median(0.1,0.2,0.3) = 0.2 → lift +100%
      metric("old", "p0", 60, 90), // outside the 30-day window of d4
    ];
    const scores = scoreDestinations(rows, { now: NOW, sinceDays: 45 });
    const d4 = scores.find((s) => s.destinationId === "d4")!;
    expect(d4.engagementRate).toBeCloseTo(0.4);
    expect(d4.baselineN).toBe(3);
    expect(d4.baselineMedian).toBeCloseTo(0.2);
    expect(d4.lift).toBeCloseTo(1);
    expect(d4.basis).toBe("reach");
    // Old snapshots are only used as baselines, never scored themselves.
    expect(scores.some((s) => s.destinationId === "old")).toBe(false);
  });

  it("excludes the post itself and other accounts or platforms from the baseline", () => {
    const rows = [
      metric("d1", "p1", 20, 10),
      metric("d2", "p2", 15, 20),
      metric("same-post-other-dest", "p4", 14, 90), // same post: excluded
      metric("other-acc", "p5", 13, 90, { accountId: "acc2" }),
      metric("other-platform", "p6", 13, 90, { platform: "instagram" }),
      metric("d4", "p4", 10, 40),
    ];
    const d4 = scoreDestinations(rows, { now: NOW }).find((s) => s.destinationId === "d4")!;
    expect(d4.baselineN).toBe(2);
    expect(BASELINE_MIN).toBe(3);
    expect(d4.baselineMedian).toBeNull();
    expect(d4.lift).toBeNull();
  });

  it("needs reach, impressions or views: others are skipped, not scored as zero", () => {
    const rows = [
      metric("a", "p1", 9, 10, { reach: null, impressions: 200 }),
      metric("b", "p2", 8, 10, { reach: null, impressions: null, views: 50 }),
      metric("c", "p3", 7, 10, { reach: null, impressions: null, views: null }),
    ];
    const scores = scoreDestinations(rows, { now: NOW });
    expect(scores.map((s) => [s.destinationId, s.basis])).toEqual([["a", "impressions"], ["b", "views"]]);
    expect(scores.find((s) => s.destinationId === "a")!.engagementRate).toBeCloseTo(0.05);
  });
});

describe("features", () => {
  it("computes format, length and posting daypart in code (company timezone)", () => {
    const post = { body: "Short caption", media: [{ kind: "image" }, { kind: "image" }], publishedAt: "2026-09-20T05:30:00Z" };
    expect(codeFeatures(post, "Africa/Johannesburg")).toEqual([
      { key: "format", value: "carousel", confidence: 1, source: "code" },
      { key: "length", value: "short", confidence: 1, source: "code" },
      { key: "daypart", value: "morning", confidence: 1, source: "code" },
    ]);
    expect(codeFeatures({ body: "x".repeat(400), media: [{ kind: "video" }], publishedAt: "2026-09-20T17:00:00Z" }, "Africa/Johannesburg").map((f) => f.value)).toEqual(["video", "long", "evening"]);
    expect(codeFeatures({ body: "x".repeat(150), media: [], publishedAt: null }, "UTC").map((f) => f.value)).toEqual(["text", "medium"]);
  });

  it("sends only the caption, clipped to 1000 characters", () => {
    expect(captionState("  Hello  ")).toBe("Hello");
    expect(Array.from(captionState("é".repeat(1500)))).toHaveLength(1000);
  });

  it("asks topic only when the program lists topics, plus its own questions", () => {
    const own: FeatureQuestion = { key: "emoji_use", type: "noul", question: "Does the caption use emojis?", status: "active" };
    const retired: FeatureQuestion = { key: "old_q", type: "noul", question: "Old question here?", status: "retired" };
    expect(jevFeatureKeys({ topics: [], featureQuestions: [] })).toEqual(["hook", "cta", "tone"]);
    expect(jevFeatureKeys({ topics: ["pricing"], featureQuestions: [own, retired] })).toEqual(["hook", "cta", "topic", "tone", "emoji_use"]);
    const q = featureQuestionsFor({ topics: ["pricing", "team"], featureQuestions: [own] }, ["hook", "cta", "topic", "tone", "emoji_use"]);
    expect(Object.keys(q)).toEqual(["hook", "cta", "topic", "tone", "emoji_use"]);
    expect(q.hook).toMatchObject({ type: "choice" });
    expect(Object.keys((q.hook as { criteria: Record<string, unknown> }).criteria)).toEqual(["question", "bold_claim", "story", "stat", "how_to", "offer"]);
    expect(Object.keys((q.topic as { criteria: Record<string, unknown> }).criteria)).toEqual(["pricing", "team", "other"]);
    expect(q.tone).toMatchObject({ type: "score" });
    expect(Object.keys(featureQuestionsFor({ topics: [], featureQuestions: [] }, ["topic", "cta"]))).toEqual(["cta"]);
  });

  it("maps Jev answers to stored values", () => {
    const values = featureValuesFrom(
      { topics: [], featureQuestions: [{ key: "urgency", type: "score", question: "How urgent is the post?", levels: ["calm", "urgent"], status: "active" }] },
      {
        hook: { type: "choice", choice: "question", probabilities: { question: 0.9 }, confidence: 0.85 },
        cta: { type: "noul", noul: 0.9 },
        tone: { type: "score", score: 3.6, probabilities: {}, confidence: 0.7 },
        urgency: { type: "score", score: 0.2, probabilities: {}, confidence: 0.6 },
      },
      { hook: "dec-1" },
    );
    expect(values).toEqual([
      { key: "hook", value: "question", confidence: 0.85, source: "jev", decisionId: "dec-1" },
      { key: "cta", value: "yes", confidence: 0.8, source: "jev", decisionId: null },
      { key: "tone", value: "playful", confidence: 0.7, source: "jev", decisionId: null },
      { key: "urgency", value: "calm", confidence: 0.6, source: "jev", decisionId: null },
    ]);
    expect(usableFeatures([...values, { key: "weak", value: "x", confidence: 0.2 }])).toEqual({ hook: "question", cta: "yes", tone: "playful", urgency: "calm" });
  });

  it("validates feature questions (discovery)", () => {
    const by = "agent:a1";
    expect(normalizeFeatureQuestion({ key: "emoji_use", type: "noul", question: "Does the caption use emojis?" }, [], by)).toMatchObject({ key: "emoji_use", status: "active", proposedBy: by });
    expect(normalizeFeatureQuestion({ key: "offer_kind", type: "choice", question: "What kind of offer is it?", options: ["discount", "free", "none"] }, [], by).options).toEqual(["discount", "free", "none"]);
    expect(() => normalizeFeatureQuestion({ key: "hook", type: "noul", question: "Is there a hook here?" }, [], by)).toThrow(/built-in/);
    expect(() => normalizeFeatureQuestion({ key: "Bad Key", type: "noul", question: "Some question here?" }, [], by)).toThrow(/key/);
    expect(() => normalizeFeatureQuestion({ key: "x_choice", type: "choice", question: "Pick one of these please", options: ["only"] }, [], by)).toThrow(/options/);
    const full = Array.from({ length: 12 }, (_, i) => ({ key: `q${i}x`, type: "noul" as const, question: "A question?", status: "active" as const }));
    expect(() => normalizeFeatureQuestion({ key: "one_more", type: "noul", question: "One more question?" }, full, by)).toThrow(/12/);
    expect(() => normalizeFeatureQuestion({ key: "q1x", type: "noul", question: "Reusing a key here?" }, [{ ...full[1]!, status: "retired" }], by)).toThrow(/used before/);
  });
});

describe("experiments", () => {
  const arms = [{ key: "control", description: "Statement hook" }, { key: "variant", description: "Question hook" }];

  it("normalises proposals and refuses bad ones", () => {
    expect(normalizeProposal({ hypothesis: "Question hooks get more comments", hypothesisType: "Hook:Question", variable: "hook", arms })).toEqual({
      hypothesis: "Question hooks get more comments",
      hypothesisType: "hook:question",
      variable: "hook",
      arms: [{ key: "control", description: "Statement hook" }, { key: "variant", description: "Question hook" }],
      minPerArm: 3,
      windowDays: 7,
    });
    expect(normalizeProposal({ hypothesis: "Question hooks get more comments", hypothesisType: "hook:question", variable: "hook", arms: { control: "Statement hook", variant: "Question hook" } }).arms).toHaveLength(2);
    expect(() => normalizeProposal({ hypothesis: "Question hooks get more comments", hypothesisType: "question", variable: "hook", arms })).toThrow(/feature:value/);
    expect(() => normalizeProposal({ hypothesis: "Question hooks get more comments", hypothesisType: "hook:question", variable: "hook", arms: [arms[0]] })).toThrow(/exactly two/);
    expect(() => normalizeProposal({ hypothesis: "Question hooks get more comments", hypothesisType: "hook:question", variable: "hook", arms, windowDays: 14 })).toThrow(/7/);
  });

  it("caps running and proposed experiments and respects autopilot off", () => {
    const base = { autopilot: "safe" as const, running: 0, proposed: 0, openTypes: [], hypothesisType: "hook:question" };
    expect(proposalBlocker(base)).toBeNull();
    expect(proposalBlocker({ ...base, autopilot: "off" })).toMatch(/off/);
    expect(proposalBlocker({ ...base, running: 3 })).toMatch(/3 experiments/);
    expect(proposalBlocker({ ...base, proposed: 3 })).toMatch(/waiting/);
    expect(proposalBlocker({ ...base, openTypes: ["hook:question"] })).toMatch(/already/);
  });

  it("is ready when every tagged post has its score and each arm has enough, or after 21 days", () => {
    const exp = { minPerArm: 2, startedAt: at(10) };
    const items = [
      { postId: "a", arm: "control", published: true, value: 0.1 },
      { postId: "b", arm: "control", published: true, value: 0 },
      { postId: "c", arm: "variant", published: true, value: 0.5 },
      { postId: "d", arm: "variant", published: false, value: null },
    ];
    expect(readiness(exp, items, NOW).ready).toBe(false);
    expect(readiness(exp, [...items.slice(0, 3), { ...items[3]!, published: true, value: 0.6 }], NOW).ready).toBe(true);
    expect(readiness({ minPerArm: 2, startedAt: at(22) }, items, NOW)).toMatchObject({ ready: true });
  });

  it("measures on lifts and drafts a playbook rule for a win or a loss", () => {
    const e = { minPerArm: 3, hypothesisType: "hook:question", arms: arms as Array<{ key: "control" | "variant"; description: string }> };
    const win = measureArms(e, [
      ...[0, 0.05, -0.05].map((v, i) => ({ postId: `c${i}`, arm: "control", published: true, value: v })),
      ...[0.4, 0.5, 0.6].map((v, i) => ({ postId: `v${i}`, arm: "variant", published: true, value: v })),
    ], "done");
    expect(win.verdict).toBe("win");
    const rule = playbookChangeFor(e, win, "2026-09-26")!;
    expect(rule).toMatchObject({ op: "add", section: "rules" });
    expect(rule.body).toContain("Question hook");
    const loss = measureArms(e, [
      ...[0.4, 0.5, 0.6].map((v, i) => ({ postId: `c${i}`, arm: "control", published: true, value: v })),
      ...[0.0, 0.05, -0.1].map((v, i) => ({ postId: `v${i}`, arm: "variant", published: true, value: v })),
    ], "done");
    expect(loss.verdict).toBe("loss");
    expect(playbookChangeFor(e, loss, "2026-09-26")).toMatchObject({ section: "avoid" });
    const thin = measureArms(e, [{ postId: "c", arm: "control", published: true, value: 0.1 }], "cutoff");
    expect(thin.verdict).toBe("inconclusive");
    expect(playbookChangeFor(e, thin, "2026-09-26")).toBeNull();
  });

  it("ranks hypothesis types with UCB: untried first, and shows what posts already say", () => {
    let board = recordVerdict({}, "hook:question", "win");
    board = recordVerdict(board, "hook:question", "win");
    board = recordVerdict(board, "format:video", "loss");
    const ranked = rankedHypotheses({ topics: [], featureQuestions: [], scoreboard: board }, { running: ["hook:story"], lifts: [{ key: "hook=story", count: 4, medianLift: 0.3 }] }, 40);
    const untried = ranked.filter((r) => r.untried);
    const tried = ranked.filter((r) => !r.untried);
    expect(ranked.indexOf(untried[0]!)).toBeLessThan(ranked.indexOf(tried[0]!));
    expect(tried.map((r) => r.type)).toEqual(["hook:question", "format:video"]);
    expect(tried[0]!.score!).toBeGreaterThan(tried[1]!.score!);
    expect(ranked.find((r) => r.type === "hook:story")).toMatchObject({ running: true, observedLift: 0.3, observedPosts: 4 });
  });
});

describe("playbook edits", () => {
  const playbook = starterPlaybook("PiB social");

  it("adds a rule under its section and drops the placeholder", () => {
    const next = applyPlaybookChange(playbook, { op: "add", section: "rules", body: "Open with a question" });
    expect(next).toContain("## Rules we follow (kept from experiments)\n- Open with a question\n\n## Things that did not work");
    const twice = applyPlaybookChange(next, { op: "add", section: "rules", body: "Post at 07:00" });
    expect(twice).toContain("- Open with a question\n- Post at 07:00\n");
    expect(applyPlaybookChange(twice, { op: "add", section: "rules", body: "Open with a question" })).toBe(twice);
    expect(applyPlaybookChange(playbook, { op: "add", section: "avoid", body: "Stock photos" })).toContain("## Things that did not work (discarded)\n- Stock photos\n");
  });

  it("removes an exact line and keeps the section readable", () => {
    const next = applyPlaybookChange(playbook, { op: "add", section: "rules", body: "Open with a question" });
    const removed = applyPlaybookChange(next, { op: "remove", section: null, body: "Open with a question" });
    expect(removed).toContain("## Rules we follow (kept from experiments)\n- (none yet)");
    expect(() => applyPlaybookChange(next, { op: "remove", section: null, body: "Not there" })).toThrow(/no line/);
  });

  it("replaces the whole playbook, appends a missing section and describes the diff", () => {
    expect(applyPlaybookChange(playbook, { op: "replace", section: null, body: "# New\n\n- one" })).toBe("# New\n\n- one\n");
    expect(applyPlaybookChange("# Bare", { op: "add", section: "rules", body: "Rule" })).toBe("# Bare\n\n## Rules we follow\n- Rule\n");
    expect(changeDiff({ op: "add", section: "avoid", body: "Stock photos" })).toBe("+ Things that did not work: - Stock photos");
    expect(normalizeChange({ text: "Open with a question" })).toEqual({ op: "add", section: "rules", body: "Open with a question" });
    expect(() => normalizeChange({ op: "add", section: "nowhere", text: "x y z" })).toThrow(/section/);
  });
});

describe("review", () => {
  it("rolls destinations up per post and splits top from bottom", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      postId: `p${i}`, body: `Post ${i}`, platform: "facebook", accountId: "a", publishedAt: at(i + 1), engagementRate: 0.1, lift: i / 10 - 0.3, experimentId: null, experimentArm: null,
    }));
    rows.push({ ...rows[0]!, platform: "instagram", lift: 0.4 }); // p0 → median(-0.3, 0.4) = 0.05
    const posts = reviewPosts(rows, new Map([["p7", { hook: "question" }]]));
    expect(posts[0]).toMatchObject({ postId: "p7", features: { hook: "question" } });
    expect(posts.find((p) => p.postId === "p0")).toMatchObject({ platforms: ["facebook", "instagram"], destinations: 2 });
    const { top, bottom } = topAndBottom(posts, 5);
    expect(top).toHaveLength(5);
    expect(top.map((p) => p.postId)).toEqual(["p7", "p6", "p5", "p4", "p0"]);
    expect(bottom.map((p) => p.postId)).toEqual(["p1", "p2", "p3"]);
  });

  it("labels ISO weeks in the company timezone", () => {
    expect(isoWeek(new Date("2026-09-26T10:00:00Z"), "Africa/Johannesburg")).toBe("2026-W39");
    expect(isoWeek(new Date("2026-09-27T22:30:00Z"), "Africa/Johannesburg")).toBe("2026-W40");
    expect(isoWeek(new Date("2027-01-01T10:00:00Z"), "UTC")).toBe("2026-W53");
  });
});
