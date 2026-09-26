import { afterEach, describe, expect, it, vi } from "vitest";
import { socialConfigFrom } from "../src/config.js";
import { NAMESPACE } from "../src/namespace.js";
import {
  applyExperimentTag,
  approveExperiment,
  decidePlaybookChange,
  getPlaybookRecord,
  listExperimentsRecord,
  measureExperimentsJob,
  performanceReview,
  proposeExperiment,
  proposeFeatureQuestion,
  proposePlaybookChange,
  rejectExperiment,
  scoreCompany,
  tagCompany,
  updateProgramRecord,
  type GrowthActor,
  type GrowthEnv,
} from "../src/growth/service.js";
import { fakeCtx, json, jsonOf, mockFetch, TEST_UI_BASE } from "./helpers.js";
import { daysAgo, memoryStore, type MemPost } from "./memory-store.js";

const T = (name: string) => `${NAMESPACE}.${name}`;
const AGENT: GrowthActor = { companyId: "co", userId: null, agentId: "agent-1", isAgent: true };
const PERSON: GrowthActor = { companyId: "co", userId: "user-1", agentId: null, isAgent: false };
const ACME = { kind: "company" as const, id: "c1", name: "Acme" };
const ARMS = [{ key: "control", description: "Statement hook" }, { key: "variant", description: "Question hook" }];

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(raw: Record<string, unknown> = {}) {
  const { store, db } = memoryStore();
  const created: Array<Record<string, unknown>> = [];
  const comments: Array<{ issueId: string; body: string }> = [];
  const issues = new Map<string, { id: string; status: string }>();
  const config = { publicBaseUrl: "https://paperclip.test", timezone: "Africa/Johannesburg", ...raw };
  const ctx = fakeCtx({
    config: { get: vi.fn(async () => config) },
    issues: {
      create: vi.fn(async (input: Record<string, unknown>) => {
        created.push(input);
        const issue = { id: `iss-${created.length}`, status: String(input.status ?? "todo") };
        issues.set(issue.id, issue);
        return issue;
      }),
      get: vi.fn(async (id: string) => issues.get(id) ?? null),
      update: vi.fn(async (id: string, patch: { status?: string }) => {
        const issue = issues.get(id)!;
        if (patch.status) issue.status = patch.status;
        return issue;
      }),
      createComment: vi.fn(async (issueId: string, body: string) => {
        comments.push({ issueId, body });
      }),
      requestWakeup: vi.fn(async () => ({ queued: true })),
    },
    companies: { get: vi.fn(async () => ({ id: "co", issuePrefix: "PIB", defaultResponsibleUserId: "default-person" })) },
    projects: { managed: { get: vi.fn(async () => ({ projectId: "proj-social" })) } },
  }, {
    queryResult: (sql, params) => (sql.includes(T("crm_companies")) && params[1] === "c1" ? [{ id: "c1", name: "Acme", domain: "acme.test", lifecycle: "customer" }] : []),
  });
  const env: GrowthEnv = { ctx, store, now: () => new Date() };
  const social = socialConfigFrom(ctx, "co", config, TEST_UI_BASE);
  return { env, db, ctx, created, comments, issues, social };
}

type World = ReturnType<typeof setup>;

function addPost(w: World, id: string, input: { body?: string; days: number; client?: typeof ACME; media?: Array<{ kind: string }>; hour?: number }): MemPost {
  const post: MemPost = {
    id,
    companyId: "co",
    body: input.body ?? `Post ${id}: a caption about our work`,
    media: input.media ?? [],
    status: "published",
    clientKind: input.client?.kind ?? null,
    clientRef: input.client?.id ?? null,
    clientName: input.client?.name ?? null,
    publishedAt: daysAgo(input.days, input.hour ?? 6),
    experimentId: null,
    experimentArm: null,
    createdAt: daysAgo(input.days + 1),
  };
  w.db.posts.push(post);
  return post;
}

/** A 7-day snapshot: engagement rate = likes / reach. */
function addMetric(w: World, post: MemPost, likes: number, input: { account?: string; reach?: number | null; platform?: string } = {}) {
  w.db.metrics.push({
    companyId: "co", window: "7d", destinationId: `d-${post.id}-${input.account ?? "acc1"}`, postId: post.id, accountId: input.account ?? "acc1", platform: input.platform ?? "facebook",
    publishedAt: post.publishedAt, likes, comments: 0, shares: 0, saves: 0, clicks: 0, reach: input.reach === undefined ? 100 : input.reach, impressions: null, views: null,
    clientKind: post.clientKind, clientRef: post.clientRef, clientName: post.clientName,
  });
}

/** Four earlier posts at rate 0.1: the account's usual level. */
function seedBaseline(w: World, client?: typeof ACME) {
  for (const [i, days] of [25, 22, 19, 16].entries()) addMetric(w, addPost(w, `${client ? "c" : "o"}base${i}`, { days, client }), 10, { account: client ? "acc-acme" : "acc1" });
}

async function tagged(w: World, experimentId: string, prefix: string, likes: { control: number; variant: number }, client?: typeof ACME) {
  for (const arm of ["control", "variant"] as const) {
    for (let i = 0; i < 3; i += 1) {
      const post = addPost(w, `${prefix}-${arm}-${i}`, { days: 8, client });
      await applyExperimentTag(w.env, "co", { id: post.id, client_kind: post.clientKind, client_ref: post.clientRef, client_name: post.clientName }, { experimentId, arm });
      addMetric(w, post, likes[arm], { account: client ? "acc-acme" : "acc1" });
    }
  }
}

const proposal = (extra: Record<string, unknown> = {}) => ({ hypothesis: "Question hooks get more engagement", hypothesisType: "hook:question", variable: "opening line", arms: ARMS, ...extra });

describe("experiment lifecycle (safe autopilot)", () => {
  it("propose → approve → tag posts → score → measure → verdict → playbook diff → keep → new version", async () => {
    const w = setup();
    seedBaseline(w);

    const proposed = await proposeExperiment(w.env, AGENT, proposal());
    expect(proposed).toMatchObject({ status: "proposed", hypothesisType: "hook:question", minPerArm: 3, approvalIssueId: "iss-1" });
    // One approval issue per program per week: a second proposal is a comment on it.
    const second = await proposeExperiment(w.env, AGENT, proposal({ hypothesis: "Videos beat single images for reach", hypothesisType: "format:video", variable: "format" }));
    expect(second.approvalIssueId).toBe("iss-1");
    expect(w.created).toHaveLength(1);
    expect(w.created[0]).toMatchObject({ title: expect.stringContaining("Approve social experiments"), assigneeUserId: "default-person", originKind: "plugin:partnersinbiz.social" });
    expect(String(w.created[0]!.description)).toContain("/PIB/social?tab=growth");
    expect(w.comments.at(-1)).toMatchObject({ issueId: "iss-1", body: expect.stringContaining("Videos beat single images") });
    await expect(proposeExperiment(w.env, AGENT, proposal())).rejects.toThrow(/already proposed or running/);

    // People approve on safe autopilot.
    await expect(approveExperiment(w.env, AGENT, { experimentId: proposed.experimentId })).rejects.toThrow(/Only a person approves/);
    const running = await approveExperiment(w.env, PERSON, { experimentId: proposed.experimentId, note: "Go" });
    expect(running).toMatchObject({ status: "running" });
    expect(running.measureBy).toBeTruthy();

    await tagged(w, proposed.experimentId, "e1", { control: 10, variant: 20 });
    const own = w.db.posts.find((p) => p.id === "e1-variant-0")!;
    expect(own).toMatchObject({ experimentId: proposed.experimentId, experimentArm: "variant" });
    expect(w.db.items.filter((i) => i.experimentId === proposed.experimentId)).toHaveLength(6);

    const scored = await scoreCompany(w.env, w.social);
    expect(scored.written).toBe(10);
    const lift = (postId: string) => w.db.scores.find((s) => s.postId === postId)!.lift;
    expect(lift("e1-variant-0")).toBeCloseTo(1); // 0.2 vs the usual 0.1
    expect(lift("e1-control-0")).toBeCloseTo(0);
    expect(lift("obase0")).toBeNull(); // no earlier posts: no baseline

    const listed = await listExperimentsRecord(w.env, AGENT, { status: "running" });
    expect(listed.experiments[0]!.counts).toEqual({ control: { posts: 3, published: 3, scored: 3 }, variant: { posts: 3, published: 3, scored: 3 } });

    const measured = await measureExperimentsJob(w.ctx, async () => undefined, w.env);
    expect(measured).toMatchObject({ experiments: 1, measured: 1 });
    const experiment = w.db.experiments.find((e) => e.id === proposed.experimentId)!;
    expect(experiment).toMatchObject({ status: "measured", verdict: "win", playbookDecision: "pending" });
    expect(experiment.playbookDiff).toContain("+ Rules we follow");
    expect(w.db.items.find((i) => i.postId === "e1-variant-0")!.value).toBeCloseTo(1);
    const program = w.db.programs[0]!;
    expect(program.scoreboard["hook:question"]).toEqual({ wins: 1, losses: 0, noChange: 0, inconclusive: 0 });

    const change = w.db.changes.find((c) => c.experimentId === proposed.experimentId)!;
    expect(change).toMatchObject({ status: "pending", section: "rules", approvalIssueId: "iss-1" });
    await expect(decidePlaybookChange(w.env, AGENT, { changeId: change.id, decision: "keep" })).rejects.toThrow(/Only a person/);
    const kept = await decidePlaybookChange(w.env, PERSON, { changeId: change.id, decision: "keep" });
    expect(kept).toEqual({ changeId: change.id, status: "kept", playbookVersion: 2 });
    const playbook = await getPlaybookRecord(w.env, AGENT, {});
    expect(playbook.playbookVersion).toBe(2);
    expect(playbook.playbook).toMatch(/## Rules we follow \(kept from experiments\)\n- Question hook \(beat "Statement hook" by \+100% median lift/);
    expect(playbook.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(w.db.experiments.find((e) => e.id === proposed.experimentId)!.playbookDecision).toBe("kept");

    // The issue closes once the last item on it is decided.
    expect(w.issues.get("iss-1")!.status).toBe("todo");
    await rejectExperiment(w.env, PERSON, { experimentId: second.experimentId, reason: "Not this month" });
    expect(w.issues.get("iss-1")!.status).toBe("done");
  });

  it("waits until each arm is scored, and discards are logged without a new version", async () => {
    const w = setup();
    seedBaseline(w);
    const e = await proposeExperiment(w.env, AGENT, proposal());
    await approveExperiment(w.env, PERSON, { experimentId: e.experimentId });
    const post = addPost(w, "lonely", { days: 8 });
    await applyExperimentTag(w.env, "co", { id: post.id }, { experimentId: e.experimentId, arm: "variant" });
    addMetric(w, post, 20);
    await scoreCompany(w.env, w.social);
    expect(await measureExperimentsJob(w.ctx, async () => undefined, w.env)).toMatchObject({ waiting: 1, measured: 0 });

    const change = await proposePlaybookChange(w.env, AGENT, { op: "add", section: "avoid", text: "Stock photos", reason: "Bottom 5 all used stock photos" });
    expect(change).toMatchObject({ status: "pending", diff: "+ Things that did not work: - Stock photos" });
    await decidePlaybookChange(w.env, PERSON, { changeId: change.changeId, decision: "discard", note: "Too early" });
    expect(w.db.changes.find((c) => c.id === change.changeId)).toMatchObject({ status: "discarded", decisionNote: "Too early", decidedBy: "user:user-1" });
    expect(w.db.programs[0]!.playbookVersion).toBe(1);
    await expect(proposePlaybookChange(w.env, AGENT, { op: "remove", text: "Not a line", reason: "Cleanup" })).rejects.toThrow(/no line/);
  });
});

describe("autopilot modes", () => {
  it("full: proposals start at once, wins are kept automatically, the agent may decide", async () => {
    const w = setup();
    seedBaseline(w);
    await updateProgramRecord(w.env, PERSON, { autopilot: "full" });
    const e = await proposeExperiment(w.env, AGENT, proposal());
    expect(e.status).toBe("running");
    expect(w.created).toHaveLength(0);
    await tagged(w, e.experimentId, "f", { control: 10, variant: 25 });
    await scoreCompany(w.env, w.social);
    await measureExperimentsJob(w.ctx, async () => undefined, w.env);
    expect(w.db.experiments[0]).toMatchObject({ verdict: "win", playbookDecision: "kept" });
    expect(w.db.programs[0]!.playbookVersion).toBe(2);
    expect(w.db.changes[0]).toMatchObject({ status: "kept", decidedBy: "autopilot", resultVersion: 2 });
    expect(w.created).toHaveLength(0);

    const change = await proposePlaybookChange(w.env, AGENT, { op: "add", section: "rules", text: "Reply to every comment within a day", reason: "Replies lift comments" });
    expect(await decidePlaybookChange(w.env, AGENT, { changeId: change.changeId, decision: "keep" })).toMatchObject({ status: "kept", playbookVersion: 3 });
  });

  it("off: agents only read", async () => {
    const w = setup();
    await updateProgramRecord(w.env, PERSON, { autopilot: "off" });
    await expect(proposeExperiment(w.env, AGENT, proposal())).rejects.toThrow(/autopilot is off/);
    await expect(proposePlaybookChange(w.env, AGENT, { text: "A rule here", reason: "Because" })).rejects.toThrow(/autopilot is off/);
    await expect(proposeFeatureQuestion(w.env, AGENT, { key: "emoji_use", type: "noul", question: "Does it use emojis?" })).rejects.toThrow(/autopilot is off/);
    expect((await performanceReview(w.env, AGENT, {})).program.autopilot).toBe("off");
    await expect(updateProgramRecord(w.env, AGENT, { autopilot: "full" })).rejects.toThrow(/A person must/);
  });
});

describe("client scope isolation", () => {
  it("keeps programs, reviews and experiment tags per scope", async () => {
    const w = setup();
    seedBaseline(w);
    seedBaseline(w, ACME);
    const ownProgram = await getPlaybookRecord(w.env, AGENT, {});
    const acmeProgram = await getPlaybookRecord(w.env, AGENT, { client: "company:c1" });
    expect(ownProgram.programId).not.toBe(acmeProgram.programId);
    expect(acmeProgram).toMatchObject({ client: "company:c1", clientName: "Acme" });
    expect(acmeProgram.playbook).toContain("# Acme social playbook");
    await expect(getPlaybookRecord(w.env, AGENT, { client: "company:nope" })).rejects.toThrow(/Unknown client/);

    const acmeExperiment = await proposeExperiment(w.env, AGENT, { ...proposal(), client: "company:c1" });
    const ownPost = addPost(w, "own-post", { days: 3 });
    await expect(applyExperimentTag(w.env, "co", { id: ownPost.id }, { experimentId: acmeExperiment.experimentId, arm: "variant" })).rejects.toThrow(/belongs to Acme/);
    await tagged(w, acmeExperiment.experimentId, "acme", { control: 10, variant: 30 }, ACME);

    await scoreCompany(w.env, w.social);
    const own = await performanceReview(w.env, AGENT, {});
    const acme = await performanceReview(w.env, AGENT, { clientKind: "company", clientRef: "c1" });
    expect(own.summary.postsScored).toBe(4);
    expect(acme.summary.postsScored).toBe(10);
    expect([...own.top, ...own.bottom].every((p) => p.postId.startsWith("obase"))).toBe(true);
    expect(acme.top[0]!.postId).toMatch(/^acme-variant/);
    expect(acme.proposedExperiments.map((e) => e.experimentId)).toEqual([acmeExperiment.experimentId]);
    expect(own.proposedExperiments).toEqual([]);
    // Scores carry the program of their scope.
    expect(new Set(w.db.scores.filter((s) => s.clientRef === "c1").map((s) => s.programId))).toEqual(new Set([acmeProgram.programId]));
  });
});

describe("performance review", () => {
  it("ranks hypothesis types with UCB and shows feature lifts, top and bottom posts", async () => {
    const w = setup();
    seedBaseline(w);
    const e = await proposeExperiment(w.env, AGENT, proposal());
    await approveExperiment(w.env, PERSON, { experimentId: e.experimentId });
    await tagged(w, e.experimentId, "r", { control: 10, variant: 20 });
    await scoreCompany(w.env, w.social);
    await measureExperimentsJob(w.ctx, async () => undefined, w.env);
    for (const post of w.db.posts) {
      await w.env.store.upsertFeatures("co", null, post.id, [{ key: "hook", value: post.id.includes("variant") ? "question" : "bold_claim", confidence: 0.9, source: "jev" }], "jev-1.13.0");
    }
    await proposeExperiment(w.env, AGENT, proposal({ hypothesis: "Evening posts do better here", hypothesisType: "daypart:evening", variable: "time" }));
    const review = await performanceReview(w.env, AGENT, { periodDays: 28 });
    // 6 tagged posts plus the 4th baseline post (the first with 3 earlier ones).
    expect(review.summary).toMatchObject({ postsScored: 10, postsWithLift: 7 });
    expect(review.top[0]).toMatchObject({ lift: 1, features: { hook: "question" } });
    expect(review.bottom.at(-1)!.lift).toBeCloseTo(0);
    expect(review.featureLifts).toEqual([
      { key: "hook=question", count: 3, medianLift: 1 },
      { key: "hook=bold_claim", count: 4, medianLift: 0 }, // 3 control posts + the 4th baseline post
    ]);
    const ranked = review.rankedHypothesisTypes;
    const firstTried = ranked.findIndex((r) => !r.untried);
    expect(ranked.slice(0, Math.max(firstTried, 1)).every((r) => r.untried)).toBe(true);
    expect(ranked.find((r) => r.type === "daypart:evening")).toMatchObject({ running: true, untried: true });
    expect(ranked.find((r) => r.type === "hook:question") ?? { tries: 1 }).toMatchObject({ tries: 1 });
    expect(review.proposedExperiments).toHaveLength(1);
    expect(review.pendingChanges).toHaveLength(1);
  });

  it("refuses an out-of-range period", async () => {
    const w = setup();
    await expect(performanceReview(w.env, AGENT, { periodDays: 400 })).rejects.toThrow(/periodDays/);
  });
});

describe("feature tagging", () => {
  it("sends one Jev call per post with the caption only; code features need no Jev", async () => {
    const w = setup({ jev: { apiKey: "tsk-test" } });
    const long = "Why do most small businesses post at 9am? ".repeat(40);
    addPost(w, "p1", { days: 3, body: long, media: [{ kind: "video" }], hour: 16 });
    addPost(w, "p2", { days: 4, body: "Book your spot today" });
    await updateProgramRecord(w.env, PERSON, { topics: "pricing, team" });
    const fetchMock = mockFetch([["POST https://api.typesafe.ai/v1/systemone", () => json({
      model: "jev-1.13.0",
      answers: {
        hook: { type: "choice", choice: "question", probabilities: {}, confidence: 0.9 },
        cta: { type: "noul", noul: 0.9 },
        topic: { type: "choice", choice: "pricing", probabilities: {}, confidence: 0.8 },
        tone: { type: "score", score: 2, probabilities: {}, confidence: 0.7 },
      },
    })]]);
    const result = await tagCompany(w.env, w.social);
    expect(result).toMatchObject({ posts: 2, codeTagged: 2, jevTagged: 2, jev: true });
    expect(fetchMock.calls).toHaveLength(2);
    for (const call of fetchMock.calls) {
      const body = jsonOf(call);
      expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
      expect(typeof body.state).toBe("string");
      expect(Object.keys(body.questions as object)).toEqual(["hook", "cta", "topic", "tone"]);
    }
    const states = fetchMock.calls.map((c) => jsonOf(c).state as string);
    expect(states).toContain("Book your spot today");
    expect(Array.from(states.find((s) => s.startsWith("Why"))!)).toHaveLength(1000);
    const p1 = Object.fromEntries(w.db.features.filter((f) => f.postId === "p1").map((f) => [f.key, f.value]));
    expect(p1).toEqual({ format: "video", length: "long", daypart: "evening", hook: "question", cta: "yes", topic: "pricing", tone: "conversational" });

    // Nothing left to ask: no more calls.
    await tagCompany(w.env, w.social);
    expect(fetchMock.calls).toHaveLength(2);
    // A new question backfills: one call per post with only that question.
    await proposeFeatureQuestion(w.env, AGENT, { key: "emoji_use", type: "noul", question: "Does the caption use emojis?" });
    const backfill = mockFetch([["POST https://api.typesafe.ai/v1/systemone", () => json({ model: "jev-1.13.0", answers: { emoji_use: { type: "noul", noul: 0.1 } } })]]);
    await tagCompany(w.env, w.social);
    expect(backfill.calls).toHaveLength(2);
    for (const call of backfill.calls) expect(Object.keys(jsonOf(call).questions as object)).toEqual(["emoji_use"]);
    expect(w.db.features.find((f) => f.postId === "p2" && f.key === "emoji_use")).toMatchObject({ value: "no", source: "jev" });
  });

  it("without Jev tags code features only", async () => {
    const w = setup();
    addPost(w, "p1", { days: 3 });
    const fetchMock = mockFetch([]);
    expect(await tagCompany(w.env, w.social)).toMatchObject({ codeTagged: 1, jevTagged: 0, jev: false });
    expect(fetchMock.calls).toHaveLength(0);
    expect(w.db.features.map((f) => f.key)).toEqual(["format", "length", "daypart"]);
  });
});
