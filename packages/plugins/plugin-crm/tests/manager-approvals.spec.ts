/**
 * Access stage B-D7 (PAR-15207): an approval about one client goes to that client's manager when he is a limited
 * member and the company is on enforce; hard stops (e-sign, erasure) keep the owner. Switch off, report, or no
 * access row: today's route, unchanged (the parity test).
 */
import { describe, expect, it } from "vitest";
import { accessCompanyScope, accessGrantScope, noteAccessReceived } from "@partnersinbiz/pib-plugin-kit";
import { onCareApprovalIssue } from "../src/care-approvals.js";
import { APPROVAL_KINDS, type ApprovalKind, type ClientKey } from "../src/care-store.js";
import { repairApprovalIssues, requestApproval } from "../src/outbound.js";
import { clientManagerApprover, HARD_STOP_APPROVAL_KINDS, MANAGER_APPROVAL_KINDS } from "../src/routing.js";
import { bootCare, CO, OWNER, type Harness } from "./helpers/care.js";

const JAN = "user-jan";
const ADMIN = "user-admin";

const member = (userId: string, role: string, status = "active") => ({
  id: `m-${userId}`, companyId: CO, principalType: "user" as const, principalId: userId, status, membershipRole: role, grants: [], createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
});

async function world(options: { mode?: "off" | "report" | "enforce" | null; manager?: string; role?: string; grant?: boolean } = {}) {
  const booted = await bootCare();
  const { harness, store } = booted;
  const manager = options.manager ?? JAN;
  harness.seed({ accessMembers: [member(OWNER, "owner"), member(ADMIN, "admin"), member(JAN, options.role ?? "member")] as never });
  // Acme is managed by Jan (owner of the CRM company); Ada works at Acme.
  store.companies!.find((row) => row.id === "acme")!.owner_user_id = manager;
  store.companies!.find((row) => row.id === "acme")!.manager_user_ids = [];
  store.contact_companies = [...(store.contact_companies ?? []).filter((l) => l.contact_id !== "ada"), { id: "l-ada", company_id: CO, contact_id: "ada", account_id: "acme", role_label: "staff", created_at: "2026-01-01T00:00:00Z" }];
  const mode = options.mode === undefined ? "enforce" : options.mode;
  if (mode) await harness.ctx.state.set(accessCompanyScope(CO), { mode, rev: 3, userIds: [], receivedAt: new Date().toISOString() });
  if (options.grant !== false) await harness.ctx.state.set(accessGrantScope(CO, JAN), { preset: "clientManager" });
  return booted;
}

async function ask(harness: Harness, kind: ApprovalKind, client: ClientKey | null, extra: { deferIssue?: boolean } = {}) {
  const opened = await requestApproval(harness.ctx, {
    companyId: CO, kind, client, subjectId: `s-${kind}-${Math.random()}`, title: `Approve ${kind}`, intro: ["Why."], checks: ["Check."], outward: true, ...extra,
  });
  return { opened, issue: opened.issueId ? await harness.ctx.issues.get(opened.issueId, CO) : null };
}

const ACME: ClientKey = { kind: "company", id: "acme" };
const ADA: ClientKey = { kind: "contact", id: "ada" };

describe("every approval kind is classed: to the client's manager, or a hard stop that stays with the owner", () => {
  it("names each kind exactly once", () => {
    const all = [...MANAGER_APPROVAL_KINDS, ...HARD_STOP_APPROVAL_KINDS];
    expect([...all].sort()).toEqual([...APPROVAL_KINDS].sort());
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("on enforce, with a limited manager", () => {
  it.each(MANAGER_APPROVAL_KINDS)("%s about his company goes to him", async (kind) => {
    const { harness } = await world();
    const { opened, issue } = await ask(harness, kind, ACME);
    expect(opened.assignedTo).toBe("person");
    expect(issue?.assigneeUserId).toBe(JAN);
  });

  it.each(MANAGER_APPROVAL_KINDS)("%s about a contact of his company goes to him", async (kind) => {
    const { harness } = await world();
    expect((await ask(harness, kind, ADA)).issue?.assigneeUserId).toBe(JAN);
  });

  it.each(HARD_STOP_APPROVAL_KINDS)("%s (a hard stop) stays with the owner", async (kind) => {
    const { harness } = await world();
    expect(await clientManagerApprover(harness.ctx, CO, kind, ACME)).toBeNull();
    expect((await ask(harness, kind, ACME)).issue?.assigneeUserId).toBe(OWNER);
  });

  it("a client with no manager, another client or no client stays with the owner", async () => {
    const { harness } = await world();
    expect((await ask(harness, "client_action", { kind: "company", id: "globex" })).issue?.assigneeUserId).toBe(OWNER);
    expect((await ask(harness, "client_action", { kind: "company", id: "foreign" })).issue?.assigneeUserId).toBe(OWNER);
    expect((await ask(harness, "client_action", null)).issue?.assigneeUserId).toBe(OWNER);
  });

  it("a report send to his client gets its own issue for him, not the shared monthly card", async () => {
    const { harness, store } = await world();
    const { opened, issue } = await ask(harness, "client_report", ACME, { deferIssue: true });
    expect(issue?.assigneeUserId).toBe(JAN);
    expect(store.care_approvals!.find((a) => a.id === opened.approvalId)!.payload.batch).toBeUndefined();
    // Another client's report still waits for the card.
    expect((await ask(harness, "client_report", { kind: "company", id: "globex" }, { deferIssue: true })).opened.issueId).toBeNull();
  });

  it("an agent that closes his approval has it reopened for him, not the owner", async () => {
    const { harness } = await world();
    const { issue } = await ask(harness, "client_action", ACME);
    harness.seed({ issues: [{ ...issue!, status: "done", assigneeUserId: null }] });
    await onCareApprovalIssue(harness.ctx, { companyId: CO, entityId: issue!.id, actorType: "agent", actorId: "am-1", payload: {} } as never, "done");
    expect((await harness.ctx.issues.get(issue!.id, CO))!).toMatchObject({ status: "todo", assigneeUserId: JAN });
  });
});

describe("the hourly repair opens a missed approval issue on the same route", () => {
  async function missed(harness: Harness, store: Record<string, any[]>) {
    const create = harness.ctx.issues.create;
    harness.ctx.issues.create = async () => { throw new Error("host down"); };
    const { opened } = await ask(harness, "client_action", ACME);
    harness.ctx.issues.create = create;
    expect(opened.issueId).toBeNull();
    const row = store.care_approvals!.find((a) => a.id === opened.approvalId)!;
    return { ...row, id: row.id, companyId: CO, kind: row.kind, client: { kind: row.client_kind, id: row.client_ref }, issueId: null, status: "open", payload: row.payload } as never;
  }

  it("to him on enforce", async () => {
    const { harness, store } = await world();
    const approval = await missed(harness, store as never);
    expect(await repairApprovalIssues(harness.ctx, CO, [approval])).toBe(1);
    const [issue] = (await harness.ctx.issues.list({ companyId: CO })).filter((i) => String(i.originId ?? "").includes("approval"));
    expect(issue?.assigneeUserId).toBe(JAN);
  });

  it("to the owner when his access cannot be read (fails to today's route)", async () => {
    const { harness, store } = await world();
    const approval = await missed(harness, store as never);
    harness.ctx.access.members.list = async () => { throw new Error("members down"); };
    noteAccessReceived(harness.ctx, CO); // a receive drops the cached read, as in production
    expect(await repairApprovalIssues(harness.ctx, CO, [approval])).toBe(1);
    const [issue] = (await harness.ctx.issues.list({ companyId: CO })).filter((i) => String(i.originId ?? "").includes("approval"));
    expect(issue?.assigneeUserId).toBe(OWNER);
  });
});

describe("an agent close is reopened for the owner when his access cannot be read", () => {
  it("fails to today's route", async () => {
    const { harness } = await world();
    const { issue } = await ask(harness, "client_action", ACME);
    harness.ctx.access.members.list = async () => { throw new Error("members down"); };
    noteAccessReceived(harness.ctx, CO);
    harness.seed({ issues: [{ ...issue!, status: "done", assigneeUserId: null }] });
    await onCareApprovalIssue(harness.ctx, { companyId: CO, entityId: issue!.id, actorType: "agent", actorId: "am-1", payload: {} } as never, "done");
    expect((await harness.ctx.issues.get(issue!.id, CO))!).toMatchObject({ status: "todo", assigneeUserId: OWNER });
  });
});

describe("today's route is kept", () => {
  it.each([["off"], ["report"], [null]] as const)("switch %s (parity): every kind goes to the owner", async (mode) => {
    const { harness } = await world({ mode });
    for (const kind of APPROVAL_KINDS) {
      expect(await clientManagerApprover(harness.ctx, CO, kind, ACME)).toBeNull();
      expect((await ask(harness, kind, ACME)).issue?.assigneeUserId).toBe(OWNER);
    }
    // Switch off: report sends still wait for the shared card.
    expect((await ask(harness, "client_report", ACME, { deferIssue: true })).opened.issueId).toBeNull();
  });

  it("the manager is an owner or admin (not limited)", async () => {
    const { harness } = await world({ manager: ADMIN });
    expect((await ask(harness, "client_action", ACME)).issue?.assigneeUserId).toBe(OWNER);
  });

  it("the manager has no grant, or is suspended", async () => {
    expect(await clientManagerApprover((await world({ grant: false })).harness.ctx, CO, "client_action", ACME)).toBeNull();
    const suspended = await world();
    suspended.harness.seed({ accessMembers: [member(JAN, "member", "suspended")] as never });
    expect(await clientManagerApprover(suspended.harness.ctx, CO, "client_action", ACME)).toBeNull();
  });

  it("a failed read is today's route, never an error", async () => {
    const { harness } = await world();
    harness.ctx.access.members.list = async () => { throw new Error("members down"); };
    expect(await clientManagerApprover(harness.ctx, CO, "client_action", ACME)).toBeNull();
    expect((await ask(harness, "client_action", ACME)).issue?.assigneeUserId).toBe(OWNER);
  });
});
