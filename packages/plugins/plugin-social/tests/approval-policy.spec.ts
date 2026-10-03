/**
 * 0.8.0 (Q1a-2): who approves a post. The policy is checked, stored per scope, read by agents and changed only by a person.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultPolicy, getPolicy, missingStages, normalizePolicy, policyOut, policySummary, requiredStages, savePolicy, scopeKeyOf, stageList } from "../src/approval-policy.js";
import { setApprovalPolicyRecord, getApprovalPolicyRecord } from "../src/service.js";
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
    expect(policyOut(await getPolicy(set.ctx, "co", CLIENT))).toMatchObject({ scope: "company:c1", summary: "the client approves, after the Reviewer passes it" });
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
