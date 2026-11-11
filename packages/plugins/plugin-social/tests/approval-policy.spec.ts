/**
 * 0.8.0 (Q1a-2): who approves a post. The policy is checked, stored per scope, read by agents and changed only by a person.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultPolicy, getPolicy, getPolicyStrict, missingStages, normalizePolicy, policyOut, policySummary, requiredStages, savePolicy, scopeKeyOf, stageList } from "../src/approval-policy.js";
import { setApprovalDelegateRecord, setApprovalPolicyRecord, getApprovalPolicyRecord, approvalStatusRecord, loadSnapshot, transitionPost } from "../src/service.js";
import { SOCIAL_TOOLS } from "../src/tools.js";
import manifest from "../src/manifest.js";
import { approvalWorld, PERSON, SOCIAL_AGENT, T } from "./world.js";
import { fakeCtx } from "./helpers.js";

const CLIENT = { kind: "company" as const, id: "c1" };

describe("normalizePolicy", () => {
  it("defaults to a team member approving, with a 14 day client link", () => {
    expect(defaultPolicy(null)).toMatchObject({ scopeKey: "own", requireOwner: true, requireClient: false, requireReviewer: false, linkExpiryDays: 14, custom: false });
    expect(defaultPolicy(CLIENT).scopeKey).toBe("company:c1");
    expect(scopeKeyOf({ kind: "contact", id: "x9" })).toBe("contact:x9");
  });

  it("somebody has to approve: the Reviewer's pass alone is a check, not an approval", () => {
    expect(() => normalizePolicy(CLIENT, { requireOwner: false, requireClient: false, requireReviewer: true })).toThrow(/Someone has to approve/);
    expect(normalizePolicy(CLIENT, { requireOwner: false, requireClient: true })).toMatchObject({ requireOwner: false, requireClient: true, custom: true });
    expect(normalizePolicy(CLIENT, { requireOwner: true, requireClient: true, requireReviewer: true })).toMatchObject({ requireOwner: true, requireClient: true, requireReviewer: true });
  });

  it("own work has no client to approve it", () => {
    expect(() => normalizePolicy(null, { requireClient: true })).toThrow(/no client/);
    expect(normalizePolicy(null, { requireReviewer: true })).toMatchObject({ requireOwner: true, requireClient: false, requireReviewer: true });
  });

  it("the link stays open between 1 and 60 days, and flags must be booleans", () => {
    expect(normalizePolicy(CLIENT, { requireClient: true, linkExpiryDays: 30 }).linkExpiryDays).toBe(30);
    expect(() => normalizePolicy(CLIENT, { requireClient: true, linkExpiryDays: 0 })).toThrow(/between 1 and 60/);
    expect(() => normalizePolicy(CLIENT, { requireClient: true, linkExpiryDays: 61 })).toThrow(/between 1 and 60/);
    expect(() => normalizePolicy(CLIENT, { requireClient: true, linkExpiryDays: 2.5 })).toThrow(/between 1 and 60/);
    expect(() => normalizePolicy(CLIENT, { requireClient: "yes" })).toThrow(/true or false/);
  });

  it("keeps what is not asked about", () => {
    const current = normalizePolicy(CLIENT, { requireClient: true, requireReviewer: true, linkExpiryDays: 7 });
    expect(normalizePolicy(CLIENT, { requireOwner: false }, current)).toMatchObject({ requireOwner: false, requireClient: true, requireReviewer: true, linkExpiryDays: 7 });
  });
});

describe("sign-offs a policy needs", () => {
  const both = { requireReviewer: true, requireOwner: true, requireClient: true };

  it("lists the required stages in order and what is still missing", () => {
    expect(requiredStages(both)).toEqual(["reviewer", "owner", "client"]);
    expect(requiredStages({ requireReviewer: false, requireOwner: false, requireClient: true })).toEqual(["client"]);
    expect(missingStages(both, { reviewer: "approved", owner: "none", client: "stale" })).toEqual(["owner", "client"]);
    expect(missingStages(both, { reviewer: "approved", owner: "approved", client: "approved" })).toEqual([]);
    // A request for changes is not an approval.
    expect(missingStages({ requireReviewer: false, requireOwner: true, requireClient: false }, { reviewer: "none", owner: "changes", client: "none" })).toEqual(["owner"]);
  });

  it("says who approves in plain words", () => {
    expect(policySummary(defaultPolicy(null))).toBe("a team member approves (the default)");
    expect(policySummary({ ...defaultPolicy(CLIENT), requireOwner: false, requireClient: true, requireReviewer: true, custom: true })).toBe("the client approves, after the Reviewer passes it");
    expect(policySummary({ ...defaultPolicy(CLIENT), requireClient: true, custom: true })).toBe("a team member and the client both approve");
    expect(stageList(["reviewer", "client"])).toBe("the Reviewer's pass and the client's approval");
    expect(stageList(["owner"])).toBe("a team member's approval");
    expect(stageList(["reviewer", "owner", "client"])).toBe("the Reviewer's pass, a team member's approval and the client's approval");
  });
});

describe("stored policy", () => {
  it("no row is the default; a row is read back; an unreadable table keeps the owner approving", async () => {
    const empty = approvalWorld();
    expect(await getPolicy(empty.ctx, "co", CLIENT)).toMatchObject({ custom: false, requireOwner: true });
    const set = approvalWorld({ policy: { require_owner: false, require_client: true, require_reviewer: true, link_expiry_days: 7 } });
    expect(await getPolicy(set.ctx, "co", CLIENT)).toMatchObject({ custom: true, requireOwner: false, requireClient: true, requireReviewer: true, linkExpiryDays: 7, scopeKey: "company:c1" });
    expect(policyOut(await getPolicy(set.ctx, "co", CLIENT), null)).toMatchObject({ scope: "company:c1", summary: "the client approves, after the Reviewer passes it" });
    const broken = fakeCtx({}, { queryResult: () => { throw new Error("db down"); } });
    expect(await getPolicy(broken, "co", CLIENT)).toMatchObject({ custom: false, requireOwner: true });
  });

  it("saves one row per scope, scoped to the company, with who set it", async () => {
    const w = approvalWorld();
    await savePolicy(w.ctx, "co", { scope: CLIENT, clientName: "Acme" }, { requireClient: true, requireOwner: false, linkExpiryDays: 10 }, "owner-1");
    const insert = w.ctx.fakeDb.executes.find((e) => e.sql.startsWith(`INSERT INTO ${T("approval_policies")}`))!;
    expect(insert.params).toEqual(["co", "company:c1", "company", "c1", "Acme", false, false, true, 10, "owner-1"]);
    expect(insert.sql).toContain("ON CONFLICT (company_id, scope_key)");
    const own = approvalWorld();
    await savePolicy(own.ctx, "co", { scope: null, clientName: null }, { requireReviewer: true }, "owner-1");
    expect(own.ctx.fakeDb.executes[0]!.params.slice(0, 5)).toEqual(["co", "own", null, null, null]);
  });
});

describe("changing the policy is a person's act", () => {
  it("an agent can read it and cannot change it", async () => {
    const w = approvalWorld({ policy: { require_client: true } });
    expect(await getApprovalPolicyRecord(w.ctx, SOCIAL_AGENT, { client: "company:c1" })).toMatchObject({ requireClient: true, custom: true });
    await expect(setApprovalPolicyRecord(w.ctx, SOCIAL_AGENT, { client: "company:c1", requireClient: false })).rejects.toThrow("A person must set who approves posts");
    expect(w.ctx.fakeDb.executes.some((e) => e.sql.includes("approval_policies"))).toBe(false);
  });

  it("a person sets it; requiring the Reviewer needs a running Reviewer", async () => {
    const without = approvalWorld();
    await expect(setApprovalPolicyRecord(without.ctx, PERSON, { client: "company:c1", requireReviewer: true })).rejects.toThrow(/no running Reviewer/);
    const w = approvalWorld({ reviewer: "rev-1" });
    const saved = await setApprovalPolicyRecord(w.ctx, PERSON, { client: "company:c1", requireReviewer: true, requireClient: true });
    expect(saved).toMatchObject({ requireReviewer: true, requireClient: true, requireOwner: true, updatedBy: "owner-1", approved: 0 });
    expect(w.policy()).toMatchObject({ require_reviewer: true, require_client: true });
  });

  it("an unknown client is refused (a policy cannot be set for a CRM record that does not exist)", async () => {
    const w = approvalWorld({ client: null });
    await expect(setApprovalPolicyRecord(w.ctx, PERSON, { client: "company:nobody", requireClient: true })).rejects.toThrow(/Unknown client/);
  });
});

describe("the policy card is honest about a client-only policy", () => {
  // The UI is not rendered in these tests (no DOM library in this package), so this reads the component's source.
  const card = readFileSync(new URL("../src/ui/approvals.tsx", import.meta.url), "utf8");

  it("says the link is the approval wherever the client alone approves: in the saved summary and while choosing it", () => {
    expect(card).toContain("Only the client approves here, so their link is the approval.");
    expect(card).toContain("not a determined attempt");
    expect(card).toContain("{policy.requireClient && !policy.requireOwner ? ` ${CLIENT_ONLY_NOTE}` : \"\"}");
    expect(card).toContain("{!owner && client && isClient ? <Muted style={{ color: tokens.fg }}>{CLIENT_ONLY_NOTE}</Muted> : null}");
  });

  it("no longer claims that agents never approve without saying what 'approve' means here", () => {
    expect(card).not.toContain("they never approve.");
    expect(card).toContain("they never click Approve.");
  });
});

// ── the delegated approver (PAR-9561, T3b): set by a person only, locks the policy, shown on every read surface ──

const BRAND_ID = "0b5c3a52-9a0f-4c8e-8a1e-1d2f3a4b5c6d";
const BRAND = `company:${BRAND_ID}`;
const BRAND_SCOPE = { kind: "company" as const, id: BRAND_ID };
const RHEA = { id: "ag-rhea", companyId: "co", name: "Rhea", status: "idle" };

/** approvalWorld plus a real delegate store, company agents, the allowlist and a Reviewer that can go away. */
function delegateWorld(opts: { policy?: Record<string, unknown>; allowlist?: string[]; stateThrows?: boolean } = {}) {
  const w = approvalWorld({ client: { kind: "company", id: BRAND_ID, name: "PiB Brand" }, reviewer: "rev-1", policy: opts.policy, config: { delegatableScopes: opts.allowlist ?? [BRAND] } });
  const store = new Map<string, unknown>();
  const io = { reviewerRunning: true, stateThrows: opts.stateThrows ?? false };
  const baseGet = w.ctx.state.get;
  const ctx = w.ctx as unknown as { state: Record<string, unknown>; agents: Record<string, unknown> };
  ctx.state.get = async (key: { namespace?: string; stateKey: string }) => {
    if (key.namespace === "social-approval") {
      if (io.stateThrows) throw new Error("state down");
      return store.get(key.stateKey) ?? null;
    }
    const value = await baseGet(key as never);
    if (key.namespace === "pib-cockpit" && key.stateKey === "roles" && !io.reviewerRunning) return { ...(value as object), reviewerStatus: "paused" };
    return value;
  };
  ctx.state.set = async (key: { namespace?: string; stateKey: string }, value: unknown) => {
    if (key.namespace === "social-approval") store.set(key.stateKey, value);
  };
  const agents = [RHEA, { id: "rev-1", companyId: "co", name: "Vera", status: "idle" }, { id: "ag-old", companyId: "co", name: "Old", status: "terminated" }, { id: "ag-x", companyId: "other", name: "X", status: "idle" }];
  ctx.agents = {
    ...ctx.agents,
    get: async (id: string) => agents.find((a) => a.id === id) ?? null,
    list: async () => agents,
  };
  return { ...w, store, io };
}

describe("the delegated approver is a person's choice", () => {
  it("a person sets it (the Reviewer's pass turns on) and clears it (the policy stays)", async () => {
    const w = delegateWorld();
    const set = await setApprovalDelegateRecord(w.ctx, PERSON, { client: BRAND, agentId: "ag-rhea" });
    expect(set).toMatchObject({ requireReviewer: true, requireOwner: true, delegate: { agentId: "ag-rhea", name: "Rhea", active: true, inactiveReason: null } });
    expect(set.summary).toBe("the delegated approver (Rhea) approves, after the Reviewer passes it; a team member can still approve");
    expect(w.policy()).toMatchObject({ require_reviewer: true });
    expect(w.store.get("delegates")).toMatchObject({ [BRAND]: { agentId: "ag-rhea", setBy: "owner-1" } });
    const cleared = await setApprovalDelegateRecord(w.ctx, PERSON, { client: BRAND, agentId: null });
    expect(cleared).toMatchObject({ requireReviewer: true, delegate: null });
    expect(w.store.get("delegates")).toEqual({});
  });

  it("an agent is refused, also with a responsible user on its run; nothing is written", async () => {
    const w = delegateWorld();
    expect(SOCIAL_AGENT.userId).toBe("owner-1");
    await expect(setApprovalDelegateRecord(w.ctx, SOCIAL_AGENT, { client: BRAND, agentId: "ag-social" })).rejects.toThrow("A person must name a delegated approver");
    await expect(setApprovalDelegateRecord(w.ctx, SOCIAL_AGENT, { client: BRAND, agentId: null })).rejects.toThrow("A person must");
    expect(w.store.size).toBe(0);
    expect(w.ctx.fakeDb.executes.some((e) => e.sql.includes("approval_policies"))).toBe(false);
  });

  it("is a page action only: no agent tool and no manifest tool", () => {
    expect(SOCIAL_TOOLS.map((t) => t.name).filter((n) => n.includes("delegate"))).toEqual([]);
    expect((manifest.tools ?? []).map((t) => t.name).filter((n) => n.includes("delegate"))).toEqual([]);
  });

  it("refuses a blocked agent or scope, and with no running Reviewer, before writing anything", async () => {
    const w = delegateWorld();
    await expect(setApprovalDelegateRecord(w.ctx, PERSON, { client: BRAND, agentId: "rev-1" })).rejects.toThrow(/Reviewer checks the post/);
    await expect(setApprovalDelegateRecord(w.ctx, PERSON, { client: BRAND, agentId: "ag-old" })).rejects.toThrow(/terminated/);
    await expect(setApprovalDelegateRecord(w.ctx, PERSON, { client: BRAND, agentId: "ag-x" })).rejects.toThrow(/another company/);
    await expect(setApprovalDelegateRecord(w.ctx, PERSON, { client: BRAND, space: "me", agentId: "ag-rhea" })).rejects.toThrow(/personal post/);
    const off = delegateWorld({ allowlist: [] });
    await expect(setApprovalDelegateRecord(off.ctx, PERSON, { client: BRAND, agentId: "ag-rhea" })).rejects.toThrow(/not on the delegatable scopes list/);
    const asksClient = delegateWorld({ policy: { require_client: true } });
    await expect(setApprovalDelegateRecord(asksClient.ctx, PERSON, { client: BRAND, agentId: "ag-rhea" })).rejects.toThrow(/client to approve/);
    w.io.reviewerRunning = false;
    await expect(setApprovalDelegateRecord(w.ctx, PERSON, { client: BRAND, agentId: "ag-rhea" })).rejects.toThrow(/no running Reviewer/);
    for (const world of [w, off, asksClient]) {
      expect(world.store.size).toBe(0);
      expect(world.ctx.fakeDb.executes.some((e) => e.sql.startsWith(`INSERT INTO ${T("approval_policies")}`))).toBe(false);
    }
  });
});

describe("a delegate locks the policy", () => {
  it("normalizePolicy refuses the three looser shapes while delegated, and stays pure", () => {
    const current = normalizePolicy(BRAND_SCOPE, { requireReviewer: true });
    for (const looser of [{ requireReviewer: false }, { requireClient: true }, { requireOwner: false, requireClient: true }]) {
      expect(() => normalizePolicy(BRAND_SCOPE, looser, current, true)).toThrow("Clear the delegated approver first.");
      expect(() => normalizePolicy(BRAND_SCOPE, looser, current, false)).not.toThrow();
    }
    expect(normalizePolicy(BRAND_SCOPE, { linkExpiryDays: 7 }, current, true)).toMatchObject({ requireReviewer: true, linkExpiryDays: 7 });
  });

  it("the page save refuses them too; an unreadable delegate store refuses every save", async () => {
    const w = delegateWorld();
    await setApprovalDelegateRecord(w.ctx, PERSON, { client: BRAND, agentId: "ag-rhea" });
    for (const looser of [{ requireReviewer: false }, { requireClient: true }, { requireOwner: false, requireClient: true }]) {
      await expect(setApprovalPolicyRecord(w.ctx, PERSON, { client: BRAND, ...looser })).rejects.toThrow("Clear the delegated approver first.");
    }
    expect(w.policy()).toMatchObject({ require_reviewer: true, require_owner: true, require_client: false });
    const broken = delegateWorld({ stateThrows: true });
    await expect(setApprovalPolicyRecord(broken.ctx, PERSON, { client: BRAND, requireReviewer: false })).rejects.toThrow(/could not be read/);
    expect(broken.ctx.fakeDb.executes.some((e) => e.sql.startsWith(`INSERT INTO ${T("approval_policies")}`))).toBe(false);
  });

  it("the way out of a Reviewer outage: clear the delegate, save with the Reviewer off, and a person approves", async () => {
    const w = delegateWorld();
    await setApprovalDelegateRecord(w.ctx, PERSON, { client: BRAND, agentId: "ag-rhea" });
    w.io.reviewerRunning = false;
    await expect(transitionPost(w.ctx, PERSON, "p1", "approved")).rejects.toThrow(/Reviewer has not passed/);
    await expect(setApprovalPolicyRecord(w.ctx, PERSON, { client: BRAND, requireReviewer: false })).rejects.toThrow("Clear the delegated approver first.");
    await setApprovalDelegateRecord(w.ctx, PERSON, { client: BRAND, agentId: null });
    await setApprovalPolicyRecord(w.ctx, PERSON, { client: BRAND, requireReviewer: false });
    const result = (await transitionPost(w.ctx, PERSON, "p1", "approved")) as { status: string };
    expect(result.status).toBe("approved");
  });
});

describe("reading the policy and the delegate", () => {
  it("getPolicyStrict throws when the read throws; getPolicy keeps the default", async () => {
    const broken = fakeCtx({}, { queryResult: () => { throw new Error("db down"); } });
    await expect(getPolicyStrict(broken, "co", BRAND_SCOPE)).rejects.toThrow("db down");
    expect(await getPolicy(broken, "co", BRAND_SCOPE)).toMatchObject({ custom: false, requireOwner: true });
  });

  it("get-approval-policy and get-approval-status show the delegate to an agent, and say when it is not acting", async () => {
    const w = delegateWorld();
    await setApprovalDelegateRecord(w.ctx, PERSON, { client: BRAND, agentId: "ag-rhea" });
    expect(await getApprovalPolicyRecord(w.ctx, SOCIAL_AGENT, { client: BRAND })).toMatchObject({ delegate: { agentId: "ag-rhea", name: "Rhea", active: true } });
    expect(await approvalStatusRecord(w.ctx, SOCIAL_AGENT, "p1")).toMatchObject({ policy: { delegate: { agentId: "ag-rhea", active: true } } });
    RHEA.status = "paused";
    try {
      const out = await getApprovalPolicyRecord(w.ctx, SOCIAL_AGENT, { client: BRAND });
      expect(out.delegate).toMatchObject({ active: false, inactiveReason: "That agent is paused." });
      expect(out.summary).toBe("a team member approves, after the Reviewer passes it; the delegated approver (Rhea) is not acting: That agent is paused.");
    } finally {
      RHEA.status = "idle";
    }
  });

  it("the page lists delegate candidates to a person only: running agents of this company, minus the Reviewer, on allowlisted scopes", async () => {
    const w = delegateWorld();
    const person = await loadSnapshot(w.ctx, PERSON, { client: BRAND });
    expect(person.delegateCandidates).toEqual([{ id: "ag-rhea", name: "Rhea" }]);
    expect((await loadSnapshot(w.ctx, SOCIAL_AGENT, { client: BRAND })).delegateCandidates).toEqual([]);
    const off = delegateWorld({ allowlist: [] });
    expect((await loadSnapshot(off.ctx, PERSON, { client: BRAND })).delegateCandidates).toEqual([]);
  });
});
