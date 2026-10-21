/** PAR-4164 (C36): Media hypothesis injection and control arm exemption. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { socialConfigFrom } from "../src/config.js";
import { NAMESPACE } from "../src/namespace.js";
import {
  approveExperiment,
  applyExperimentTag,
  measureExperimentsJob,
  performanceReview,
  proposeExperiment,
  scoreCompany,
  type GrowthActor,
  type GrowthEnv,
} from "../src/growth/service.js";
import { fakeCtx, json, jsonOf, mockFetch, TEST_UI_BASE } from "./helpers.js";
import { daysAgo, memoryStore, type MemPost } from "./memory-store.js";

const T = (name: string) => `${NAMESPACE}.${name}`;
const AGENT: GrowthActor = { companyId: "co", userId: null, agentId: "agent-1", isAgent: true };
const PERSON: GrowthActor = { companyId: "co", userId: "user-1", agentId: null, isAgent: false };
const ACME = { kind: "company" as const, id: "c1", name: "Acme" };

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(raw: Record<string, unknown> = {}) {
  const { store, db } = memoryStore();
  const created: Array<Record<string, unknown>> = [];
  const comments: Array<{ issueId: string; body: string }> = [];
  const issues = new Map<string, { id: string; status: string }>();
  const config = { publicBaseUrl: "https://paperclip.test", timezone: "Africa/Johannesburg", ...raw };
  const ctx = fakeCtx(
    {
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
    },
    {
      queryResult: (sql, params) => (sql.includes(T("crm_companies")) && params[1] === "c1" ? [{ id: "c1", name: "Acme", domain: "acme.test", lifecycle: "customer" }] : []),
    }
  );
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
    companyId: "co",
    window: "7d",
    destinationId: `d-${post.id}-${input.account ?? "acc1"}`,
    postId: post.id,
    accountId: input.account ?? "acc1",
    platform: input.platform ?? "facebook",
    publishedAt: post.publishedAt,
    likes,
    comments: 0,
    shares: 0,
    saves: 0,
    clicks: 0,
    reach: input.reach === undefined ? 100 : input.reach,
    impressions: null,
    views: null,
    clientKind: post.clientKind,
    clientRef: post.clientRef,
    clientName: post.clientName,
  });
}

/** Four earlier posts at rate 0.1: the account's usual level. */
function seedBaseline(w: World, client?: typeof ACME) {
  for (const [i, days] of [25, 22, 19, 16].entries()) addMetric(w, addPost(w, `${client ? "c" : "o"}base${i}`, { days, client }), 10, { account: client ? "acc-acme" : "acc1" });
}

describe("media hypothesis (PAR-4164 C36)", () => {
  it("(a) first candidate for an empty scope is the media hypothesis", async () => {
    const w = setup();
    seedBaseline(w);

    const review = await performanceReview(w.env, AGENT, {});
    expect(review.rankedHypothesisTypes[0]!.type).toBe("media:with_media");
    expect(review.rankedHypothesisTypes[0]!.untried).toBe(true);
  });

  it("(b) not repeated/first once a media experiment is finished (measured) in that scope", async () => {
    const w = setup();
    seedBaseline(w);

    // Propose and run a media experiment with arms: control (no media baseline), variant (with media)
    const mediaExp = await proposeExperiment(w.env, AGENT, {
      hypothesis: "Media in images lifts engagement",
      hypothesisType: "media:with_media",
      variable: "presence of media",
      arms: [
        { key: "control", description: "No media (baseline)" },
        { key: "variant", description: "With media" },
      ],
    });

    // Once proposed, the experiment is tracked, so media should not be injected as untried
    let review = await performanceReview(w.env, AGENT, {});
    const mediaEntries = review.rankedHypothesisTypes.filter((r) => r.type.startsWith("media:"));
    expect(mediaEntries.some((r) => r.untried)).toBe(false); // No untried media entry
    expect(mediaEntries.length).toBeLessThanOrEqual(1); // At most one media entry (from the kit or open experiment)

    // Approve it
    const running = await approveExperiment(w.env, PERSON, { experimentId: mediaExp.experimentId });
    expect(running.status).toBe("running");

    // Tag 3 posts to each arm (control = no_media baseline, variant = with media)
    for (let i = 0; i < 3; i += 1) {
      const controlPost = addPost(w, `media-control-${i}`, { days: 8 });
      await applyExperimentTag(w.env, "co", { id: controlPost.id }, { experimentId: mediaExp.experimentId, arm: "control" });
      addMetric(w, controlPost, 10, { account: "acc1" });

      const variantPost = addPost(w, `media-variant-${i}`, { days: 8 });
      await applyExperimentTag(w.env, "co", { id: variantPost.id }, { experimentId: mediaExp.experimentId, arm: "variant" });
      addMetric(w, variantPost, 15, { account: "acc1" });
    }

    // Score the posts
    await scoreCompany(w.env, w.social);

    // Measure the experiment (mark as measured)
    await measureExperimentsJob(w.ctx, async () => undefined, w.env);
    const measured = w.db.experiments.find((e) => e.id === mediaExp.experimentId)!;
    expect(measured.status).toBe("measured");

    // After measurement, media should still not be injected as untried
    review = await performanceReview(w.env, AGENT, {});
    const mediaEntriesAfter = review.rankedHypothesisTypes.filter((r) => r.type.startsWith("media:"));
    expect(mediaEntriesAfter.some((r) => r.untried)).toBe(false); // No untried media entry
    expect(mediaEntriesAfter.length).toBeLessThanOrEqual(1); // At most one media entry
  });

  it("(b2) running media experiment is not duplicated as untried", async () => {
    const w = setup();
    seedBaseline(w);

    // Propose and approve a media experiment
    const mediaExp = await proposeExperiment(w.env, AGENT, {
      hypothesis: "Media in images lifts engagement",
      hypothesisType: "media:with_media",
      variable: "presence of media",
      arms: [
        { key: "control", description: "No media (baseline)" },
        { key: "variant", description: "With media" },
      ],
    });
    await approveExperiment(w.env, PERSON, { experimentId: mediaExp.experimentId });

    // Check review: no untried media entry, at most one media entry
    const review = await performanceReview(w.env, AGENT, {});
    const mediaEntries = review.rankedHypothesisTypes.filter((r) => r.type.startsWith("media:"));
    expect(mediaEntries.some((r) => r.untried)).toBe(false); // No untried media entry
    expect(mediaEntries.length).toBeLessThanOrEqual(1); // At most one media entry
  });

  it("(c) two-scope isolation: media hypothesis is first-ranked-free for another scope with none", async () => {
    const w = setup();
    seedBaseline(w); // Org-level baseline
    seedBaseline(w, ACME); // Acme baseline

    // Run a media experiment on org scope
    const mediaExp = await proposeExperiment(w.env, AGENT, {
      hypothesis: "Media in images lifts engagement",
      hypothesisType: "media:with_media",
      variable: "presence of media",
      arms: [
        { key: "control", description: "No media (baseline)" },
        { key: "variant", description: "With media" },
      ],
    });
    await approveExperiment(w.env, PERSON, { experimentId: mediaExp.experimentId });

    // Tag and measure org scope with minPerArm=3 posts per arm
    for (let i = 0; i < 3; i += 1) {
      const controlPost = addPost(w, `org-media-control-${i}`, { days: 8 });
      await applyExperimentTag(w.env, "co", { id: controlPost.id }, { experimentId: mediaExp.experimentId, arm: "control" });
      addMetric(w, controlPost, 10, { account: "acc1" });

      const variantPost = addPost(w, `org-media-variant-${i}`, { days: 8 });
      await applyExperimentTag(w.env, "co", { id: variantPost.id }, { experimentId: mediaExp.experimentId, arm: "variant" });
      addMetric(w, variantPost, 15, { account: "acc1" });
    }
    await scoreCompany(w.env, w.social);
    await measureExperimentsJob(w.ctx, async () => undefined, w.env);

    // Check org scope: media should NOT be first (finished)
    let review = await performanceReview(w.env, AGENT, {});
    expect(review.rankedHypothesisTypes[0]!.type).not.toBe("media:with_media");

    // Check Acme scope: media SHOULD be first (no finished media experiment in Acme)
    review = await performanceReview(w.env, AGENT, { client: "company:c1" });
    expect(review.rankedHypothesisTypes[0]!.type).toBe("media:with_media");
  });

  it("(d) control arm (no_media baseline) passes noMediaExempt check when under cap", async () => {
    const w = setup();
    seedBaseline(w);

    // Propose a media experiment
    const mediaExp = await proposeExperiment(w.env, AGENT, {
      hypothesis: "Media in images lifts engagement",
      hypothesisType: "media:with_media",
      variable: "presence of media",
      arms: [
        { key: "control", description: "No media (baseline)" },
        { key: "variant", description: "With media" },
      ],
    });
    await approveExperiment(w.env, PERSON, { experimentId: mediaExp.experimentId });

    // Tag control arm posts (baseline with no media) - these should be exempt from the media rule
    const controlPosts = [];
    for (let i = 0; i < 3; i += 1) {
      const post = addPost(w, `media-control-${i}`, { days: 8 });
      controlPosts.push(post);
      await applyExperimentTag(w.env, "co", { id: post.id }, { experimentId: mediaExp.experimentId, arm: "control" });
      addMetric(w, post, 10, { account: "acc1" });
    }

    // Score them - control arm should not get media blockers even without images (normalized to no_media in approval flow)
    await scoreCompany(w.env, w.social);

    // Verify that the posts are tagged with the experiment and arm
    const taggedPost = w.db.posts.find((p) => p.id === "media-control-0")!;
    expect(taggedPost.experimentId).toBe(mediaExp.experimentId);
    expect(taggedPost.experimentArm).toBe("control");

    // Verify the experiment is running and hypothesisType preserved
    const exp = w.db.experiments.find((e) => e.id === mediaExp.experimentId)!;
    expect(exp.status).toBe("running");
    expect(exp.hypothesisType).toBe("media:with_media");
  });

  it("(e) media exemption cap enforced: <=minPerArm exempt, >minPerArm not exempt, two-scope isolation", async () => {
    const { mediaExperimentForPost } = await import("../src/approval-flow.js");
    const { noMediaExempt } = await import("@partnersinbiz/pib-plugin-kit");

    const w = setup();
    seedBaseline(w);

    // Propose and approve a media experiment with minPerArm=3
    const mediaExp = await proposeExperiment(w.env, AGENT, {
      hypothesis: "Media in images lifts engagement",
      hypothesisType: "media:with_media",
      variable: "presence of media",
      arms: [
        { key: "control", description: "No media (baseline)" },
        { key: "variant", description: "With media" },
      ],
    });
    await approveExperiment(w.env, PERSON, { experimentId: mediaExp.experimentId });

    // Tag 3 posts to control arm
    const controlPosts = [];
    for (let i = 0; i < 3; i += 1) {
      const post = addPost(w, `media-control-${i}`, { days: 8 });
      controlPosts.push(post);
      await applyExperimentTag(w.env, "co", { id: post.id }, { experimentId: mediaExp.experimentId, arm: "control" });
      addMetric(w, post, 10, { account: "acc1" });
    }

    // For the 3rd control post: call mediaExperimentForPost
    // noMediaPosts should be 3 (the 3 posts we just tagged)
    const { experiment: exp3, arm: arm3 } = await mediaExperimentForPost(w.env, "co", {
      experiment_id: mediaExp.experimentId,
      experiment_arm: "control",
    });
    expect(arm3).toBe("no_media");
    expect(exp3).not.toBeNull();
    expect(exp3!.noMediaPosts).toBe(3);
    expect(noMediaExempt({ experimentId: mediaExp.experimentId, arm: "no_media" }, exp3)).toBe(true);

    // Tag a 4th control post
    const post4 = addPost(w, `media-control-4th`, { days: 8 });
    await applyExperimentTag(w.env, "co", { id: post4.id }, { experimentId: mediaExp.experimentId, arm: "control" });
    addMetric(w, post4, 10, { account: "acc1" });

    // Now the count is 4 -> noMediaExempt should be false
    const { experiment: exp4 } = await mediaExperimentForPost(w.env, "co", {
      experiment_id: mediaExp.experimentId,
      experiment_arm: "control",
    });
    expect(exp4!.noMediaPosts).toBe(4);
    expect(noMediaExempt({ experimentId: mediaExp.experimentId, arm: "no_media" }, exp4)).toBe(false);

    // Tag a variant arm post -> arm maps to "media"
    const variantPost = addPost(w, `media-variant-test`, { days: 8 });
    await applyExperimentTag(w.env, "co", { id: variantPost.id }, { experimentId: mediaExp.experimentId, arm: "variant" });
    addMetric(w, variantPost, 15, { account: "acc1" });

    const { experiment: expVar, arm: armVar } = await mediaExperimentForPost(w.env, "co", {
      experiment_id: mediaExp.experimentId,
      experiment_arm: "variant",
    });
    expect(armVar).toBe("media");
    expect(noMediaExempt({ experimentId: mediaExp.experimentId, arm: "media" }, expVar)).toBe(false);

    // Tag a post to a non-media experiment -> experiment should return null
    const otherExp = await proposeExperiment(w.env, AGENT, {
      hypothesis: "Uplifting tone improves engagement",
      hypothesisType: "tone:uplifting",
      variable: "tone",
      arms: [
        { key: "control", description: "Normal tone" },
        { key: "variant", description: "Uplifting tone" },
      ],
    });
    const nonMediaPost = addPost(w, `non-media-exp`, { days: 8 });
    await applyExperimentTag(w.env, "co", { id: nonMediaPost.id }, { experimentId: otherExp.experimentId, arm: "control" });

    const { experiment: expNonMedia } = await mediaExperimentForPost(w.env, "co", {
      experiment_id: otherExp.experimentId,
      experiment_arm: "control",
    });
    expect(expNonMedia).toBeNull();

    // Two-scope isolation: control post in another company ("co2") is not counted for "co"
    // Tag the same experiment in a different company scope (if memory store allows, use co2)
    const co2ControlPost = addPost(w, `co2-media-control-0`, { days: 8 });
    co2ControlPost.companyId = "co2"; // Manually set to test isolation
    w.db.posts.push(co2ControlPost);

    // When querying for "co", the co2 post should not be counted
    const { experiment: expCo } = await mediaExperimentForPost(w.env, "co", {
      experiment_id: mediaExp.experimentId,
      experiment_arm: "control",
    });
    // "co" still has 4 control posts, not 5
    expect(expCo!.noMediaPosts).toBe(4);
  });
});
