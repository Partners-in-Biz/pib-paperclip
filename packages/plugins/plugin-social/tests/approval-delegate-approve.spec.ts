/**
 * PAR-9561 T5: `approve-post-as-delegate`. The agent a person named for a scope approves a post in review after the
 * Reviewer's scored pass of THIS version. Every check refuses on its own sentence; every unreadable input refuses; the
 * ledger row is required; a lost status race is not an approval. Nothing else lets an agent approve.
 */
import { describe, expect, it } from "vitest";
import { requireUser, approvePostAsDelegateRecord, recordReviewVerdictRecord, transitionPost } from "../src/service.js";
import { approvePostByDelegate } from "../src/approval-flow.js";
import { contentHashOf } from "../src/content-hash.js";
import { SOCIAL_TOOLS } from "../src/tools.js";
import manifest from "../src/manifest.js";
import { approvalWorld, PERSON, postRow, REVIEWER_AGENT, SOCIAL_AGENT, T } from "./world.js";

const BRAND_ID = "0b5c3a52-9a0f-4c8e-8a1e-1d2f3a4b5c6d";
const BRAND = `company:${BRAND_ID}`;
const RHEA = { companyId: "co", userId: "owner-1", agentId: "ag-rhea", runId: "run-3", isAgent: true } as const;
const OTHER = { companyId: "co", userId: null, agentId: "ag-other", runId: "run-4", isAgent: true } as const;
const HOUR = 3_600_000;

interface Opts {
  policy?: Record<string, unknown>;
  allowlist?: string[];
  delegate?: string | null;
  setAt?: string;
}

/** A brand scope with Rhea as its delegate (named an hour before the post was created), and Vera (rev-1) as the Reviewer. */
function delegateWorld(opts: Opts = {}) {
  const w = approvalWorld({ client: { kind: "company", id: BRAND_ID, name: "PiB Brand" }, reviewer: "rev-1", reviewIssue: "iss-9", policy: { require_reviewer: true, ...opts.policy }, config: { delegatableScopes: opts.allowlist ?? [BRAND] } });
  const delegate = opts.delegate === undefined ? "ag-rhea" : opts.delegate;
  const store = new Map<string, unknown>();
  if (delegate) store.set("delegates", { [BRAND]: { agentId: delegate, setBy: "owner-1", setAt: opts.setAt ?? new Date(Date.now() - HOUR).toISOString() } });
  const io = { stateThrows: false, policyThrows: false, outcomeInsert: "ok" as "ok" | "throws" | "lost", raceOnInsert: false };
  const ctx = w.ctx as unknown as { state: Record<string, unknown>; agents: Record<string, unknown>; db: Record<string, unknown> };
  const baseGet = ctx.state.get as (key: unknown) => Promise<unknown>;
  ctx.state.get = async (key: { namespace?: string; stateKey: string }) => {
    if (key.namespace === "social-approval") {
      if (io.stateThrows) throw new Error("state down");
      return store.get(key.stateKey) ?? null;
    }
    return baseGet(key);
  };
  const agents = ["ag-rhea", "rev-1", "ag-social", "ag-other"].map((id) => ({ id, companyId: "co", name: id, status: "idle" }));
  ctx.agents = { ...ctx.agents, get: async (id: string) => agents.find((a) => a.id === id) ?? null, list: async () => agents };
  const baseQuery = ctx.db.query as (sql: string, params: unknown[]) => Promise<unknown[]>;
  const baseExecute = ctx.db.execute as (sql: string, params: unknown[]) => Promise<{ rowCount: number }>;
  ctx.db.query = async (sql: string, params: unknown[]) => {
    if (io.policyThrows && sql.includes(T("approval_policies"))) throw new Error("db down");
    return baseQuery(sql, params);
  };
  ctx.db.execute = async (sql: string, params: unknown[]) => {
    if (sql.startsWith(`INSERT INTO ${T("review_outcomes")}`) && params[3] === "owner") {
      if (io.outcomeInsert === "throws") throw new Error("disk full");
      if (io.outcomeInsert === "lost") return { rowCount: 0 };
      if (io.raceOnInsert) w.post.status = "draft";
    }
    return baseExecute(sql, params);
  };
  const hash = () => contentHashOf(postRow(w), w.destinations.map((d) => d.account_id));
  /** A Reviewer row written straight into the ledger (round 1 unless given). */
  const pass = (extra: Record<string, unknown> = {}) =>
    void w.outcomes.push({ id: `o${w.outcomes.length}`, post_id: "p1", stage: "reviewer", outcome: "approved", round: w.outcomes.length + 1, content_hash: hash(), via: "tool", actor_agent_id: "rev-1", created_at: new Date().toISOString(), ...extra });
  const ownerRows = () => w.outcomes.filter((o) => o.stage === "owner");
  return { ...w, store, io, pass, hash, ownerRows };
}

describe("the delegated approver approves after the Reviewer's pass", () => {
  it("post approved, one owner/delegate row with its agent id, review issue closed", async () => {
    const w = delegateWorld();
    w.pass();
    const result = (await approvePostAsDelegateRecord(w.ctx, RHEA, { postId: "p1" })) as { status: string; signoff: { completed: boolean } };
    expect(result).toMatchObject({ status: "approved", signoff: { completed: true } });
    expect(w.post.status).toBe("approved");
    expect(w.ownerRows()).toHaveLength(1);
    expect(w.ownerRows()[0]).toMatchObject({ stage: "owner", outcome: "approved", via: "delegate", actor_agent_id: "ag-rhea", actor_user_id: null, content_hash: w.hash() });
    expect(w.updates).toContainEqual({ id: "iss-9", patch: { status: "done" } });
    expect(w.reviewIssueId()).toBeNull();
  });

  it("end to end after the Reviewer's real pass, on a post created after the delegate was named", async () => {
    const w = delegateWorld({ setAt: new Date(Date.now() - 1000).toISOString() });
    await recordReviewVerdictRecord(w.ctx, REVIEWER_AGENT, { postId: "p1", verdict: "pass" });
    expect(w.post.status).toBe("review");
    await approvePostByDelegate(w.ctx, RHEA, postRow(w));
    expect(w.post.status).toBe("approved");
    expect(w.ownerRows()).toMatchObject([{ via: "delegate", actor_agent_id: "ag-rhea" }]);
  });
});

describe("refused, each on its own sentence, with the post left in review and no owner row", () => {
  async function refused(w: ReturnType<typeof delegateWorld>, caller: { companyId: string; agentId: string | null; isAgent: boolean }, message: RegExp | string) {
    await expect(approvePostByDelegate(w.ctx, caller, postRow(w))).rejects.toThrow(message);
    expect(w.post.status).toBe("review");
    expect(w.ownerRows()).toEqual([]);
  }

  it("no Reviewer pass", async () => refused(delegateWorld(), RHEA, "The Reviewer has not passed this post yet"));

  it("the Reviewer asked for changes last", async () => {
    const w = delegateWorld();
    w.pass();
    w.pass({ outcome: "changes" });
    await refused(w, RHEA, "The Reviewer asked for changes");
  });

  it("a stale pass (an older version)", async () => {
    const w = delegateWorld();
    w.pass({ content_hash: "0".repeat(64) });
    await refused(w, RHEA, "passed an older version");
  });

  it("an unscored pass (D1)", async () => {
    const w = delegateWorld();
    w.pass({ via: "unscored" });
    await refused(w, RHEA, "scored nothing");
  });

  it("the post was created before the delegate was set (D3)", async () => {
    const w = delegateWorld({ setAt: new Date(Date.now() + HOUR).toISOString() });
    w.pass();
    await refused(w, RHEA, "created before you were named the delegated approver");
  });

  it("the scope asks for the client", async () => {
    const w = delegateWorld({ policy: { require_client: true } });
    w.pass();
    await refused(w, RHEA, "a delegated approver cannot stand in for the client");
  });

  it("the policy read throws", async () => {
    const w = delegateWorld();
    w.pass();
    w.io.policyThrows = true;
    await refused(w, RHEA, "The approval policy could not be read");
  });

  it("the delegate store read throws: no delegate", async () => {
    const w = delegateWorld();
    w.pass();
    w.io.stateThrows = true;
    await refused(w, RHEA, "No delegated approver is set");
  });

  it("a post it created", async () => {
    const w = delegateWorld();
    w.post.created_by_agent_id = "ag-rhea";
    w.pass();
    await refused(w, RHEA, "You created this post");
  });

  it("any other agent, the Social agent and the Reviewer", async () => {
    const w = delegateWorld();
    w.pass();
    await refused(w, OTHER, "You are not the delegated approver");
    await refused(w, SOCIAL_AGENT, "You are not the delegated approver");
    await refused(w, REVIEWER_AGENT, "You are not the delegated approver");
  });

  it("the Reviewer, when it is (still) the stored delegate", async () => {
    const w = delegateWorld({ delegate: "rev-1" });
    w.pass({ actor_agent_id: "rev-2" });
    await refused(w, REVIEWER_AGENT, "The Reviewer checks the post; it cannot also approve it");
  });

  it("the caller recorded the pass (the Reviewer role moved to it after the pass)", async () => {
    const w = delegateWorld();
    w.pass({ actor_agent_id: "ag-rhea" });
    await refused(w, RHEA, "You recorded the Reviewer's pass");
  });

  it("a personal post", async () => {
    const w = delegateWorld();
    w.post.scope = "personal";
    w.pass();
    await refused(w, RHEA, "A personal post has no delegated approver");
  });

  it("a post not in review", async () => {
    const w = delegateWorld();
    w.pass();
    w.post.status = "draft";
    await expect(approvePostByDelegate(w.ctx, RHEA, postRow(w))).rejects.toThrow("not in review");
    expect(w.ownerRows()).toEqual([]);
  });

  it("no delegate set", async () => {
    const w = delegateWorld({ delegate: null });
    w.pass();
    await refused(w, RHEA, "No delegated approver is set");
  });

  it("the scope is off the allowlist", async () => {
    const w = delegateWorld({ allowlist: [] });
    w.pass();
    await refused(w, RHEA, "not on the delegatable scopes list");
  });

  it("a person (or an agent with no id) through the tool", async () => {
    const w = delegateWorld();
    w.pass();
    await expect(approvePostAsDelegateRecord(w.ctx, PERSON, { postId: "p1" })).rejects.toThrow("Only the delegated approver agent");
    await refused(w, { companyId: "co", agentId: null, isAgent: true }, "Only the delegated approver agent");
  });
});

describe("the write must land, and a lost race is not an approval", () => {
  it("a failed insert leaves the post in review", async () => {
    const w = delegateWorld();
    w.pass();
    w.io.outcomeInsert = "throws";
    await expect(approvePostByDelegate(w.ctx, RHEA, postRow(w))).rejects.toThrow("could not be recorded");
    expect(w.post.status).toBe("review");
    expect(w.ownerRows()).toEqual([]);
  });

  it("a lost round race (recorded: false) leaves the post in review", async () => {
    const w = delegateWorld();
    w.pass();
    w.io.outcomeInsert = "lost";
    await expect(approvePostByDelegate(w.ctx, RHEA, postRow(w))).rejects.toThrow("could not be recorded");
    expect(w.post.status).toBe("review");
    expect(w.ownerRows()).toEqual([]);
  });

  it("the post leaves review between the checks and the approval: reported as not approved", async () => {
    const w = delegateWorld();
    w.pass();
    w.io.raceOnInsert = true;
    await expect(approvePostByDelegate(w.ctx, RHEA, postRow(w))).rejects.toThrow("The post was not approved");
    expect(w.post.status).toBe("draft");
  });
});

describe("nothing else lets the delegate approve, and a person still can", () => {
  it("set-post-status approved and social.approve's guard refuse the delegate", async () => {
    const w = delegateWorld();
    w.pass();
    await expect(transitionPost(w.ctx, RHEA, "p1", "approved")).rejects.toThrow();
    expect(() => requireUser(RHEA, "approve a post")).toThrow("A person must approve a post");
    expect(w.post.status).toBe("review");
  });

  it("a person approves in a delegated scope", async () => {
    const w = delegateWorld();
    w.pass();
    await transitionPost(w.ctx, PERSON, "p1", "approved");
    expect(w.post.status).toBe("approved");
    expect(w.ownerRows()).toMatchObject([{ via: "ui", actor_user_id: "owner-1" }]);
  });

  it("is an agent tool in SOCIAL_TOOLS and the manifest; the setting stays a page action", () => {
    expect(SOCIAL_TOOLS.map((t) => t.name)).toContain("approve-post-as-delegate");
    expect((manifest.tools ?? []).map((t) => t.name)).toContain("approve-post-as-delegate");
    expect((manifest.tools ?? []).map((t) => t.name)).not.toContain("set-approval-delegate");
    const tool = SOCIAL_TOOLS.find((t) => t.name === "approve-post-as-delegate")!;
    expect(tool.description).toContain("Delegated approver only");
    expect(tool.description).toContain("return-post-as-delegate");
  });
});
