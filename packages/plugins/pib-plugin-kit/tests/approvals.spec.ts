import { describe, expect, it } from "vitest";
import {
  COCKPIT_EVENTS,
  COCKPIT_PLUGIN,
  assignableUserId,
  companyDefaultOwner,
  forgetCompanyDefaultOwner,
  companyRoles,
  lastKnownOwner,
  openApprovalIssue,
  ownerUserFor,
  registerRoleWatch,
  repairUnroutedApprovals,
  resolveApprover,
  rolesCopyHealth,
  rolesPayloadIsOlder,
  routeWork,
  stampMs,
  unroutedApprovalsCheck,
  findUnroutedApprovals,
  isApprovalIssue,
  readCompanyRoles,
} from "../src/index.js";
import { reopenApprovalForPerson } from "../src/issues.js";
import { fakeCtx, rolesCopy, setRoles, stateKeyOf } from "./helpers/fake-ctx.js";

const ROLES_EVENT = `plugin.${COCKPIT_PLUGIN}.${COCKPIT_EVENTS.rolesUpdated}`;
const roleKey = (companyId: string) => stateKeyOf({ scopeKind: "company", scopeId: companyId, namespace: "pib-cockpit", stateKey: "roles" });

/** The very first broadcast live: ISO stamp, no owner, nothing reviewed. */
const FIRST = rolesCopy({ ownerUserId: null, reviewOutward: false, updatedAt: "2026-09-27T06:32:49.178Z" });
/** Every later broadcast live: the host's Postgres text for the stamp, owner saved, outward work reviewed. */
const LATER = rolesCopy({ updatedAt: "2026-09-27 18:46:11.052+00" });


describe("Q5-6 root cause: the roles copy froze on the first broadcast", () => {
  it("reproduces the live bug: a text compare ranks the later stamp as older", () => {
    // This is exactly what the old watch did, and why every plugin kept {owner: null, reviewOutward: false} for five days.
    expect(FIRST.updatedAt > LATER.updatedAt).toBe(true);
    expect(rolesPayloadIsOlder(FIRST, LATER)).toBe(false);
    expect(stampMs(LATER.updatedAt)).toBeGreaterThan(stampMs(FIRST.updatedAt));
  });

  it("stores the later broadcast over the first, whatever format its stamp is in", async () => {
    const fake = fakeCtx();
    registerRoleWatch(fake.ctx);
    await fake.deliver(ROLES_EVENT, "co-1", FIRST);
    expect((await companyRoles(fake.ctx, "co-1"))?.ownerUserId).toBeNull();
    await fake.deliver(ROLES_EVENT, "co-1", LATER);
    const roles = await companyRoles(fake.ctx, "co-1");
    expect(roles?.ownerUserId).toBe("owner");
    expect(roles?.reviewOutward).toBe(true);
    expect(roles?.receivedAt).toBeTruthy();
  });

  it("still ignores a genuinely older broadcast, and accepts one with an unreadable stamp", async () => {
    const fake = fakeCtx();
    registerRoleWatch(fake.ctx);
    await fake.deliver(ROLES_EVENT, "co-1", LATER);
    await fake.deliver(ROLES_EVENT, "co-1", FIRST);
    expect((await companyRoles(fake.ctx, "co-1"))?.ownerUserId).toBe("owner");
    await fake.deliver(ROLES_EVENT, "co-1", rolesCopy({ ownerUserId: "new-owner", updatedAt: "not a date" }));
    expect((await companyRoles(fake.ctx, "co-1"))?.ownerUserId).toBe("new-owner");
  });

  it("remembers the last owner it ever saw, so a later copy without one cannot orphan approvals", async () => {
    const fake = fakeCtx();
    registerRoleWatch(fake.ctx);
    await fake.deliver(ROLES_EVENT, "co-1", LATER);
    await fake.deliver(ROLES_EVENT, "co-1", rolesCopy({ ownerUserId: null, updatedAt: "2026-09-28T10:00:00.000Z" }));
    expect((await companyRoles(fake.ctx, "co-1"))?.ownerUserId).toBeNull();
    expect(await lastKnownOwner(fake.ctx, "co-1")).toBe("owner");
    // An approval still finds a person; plain work routing respects an owner that was cleared on purpose.
    expect((await ownerUserFor(fake.ctx, "co-1", { lastKnown: true })).source).toBe("last-known");
    expect((await resolveApprover(fake.ctx, "co-1")).approverUserId).toBe("owner");
    expect(await ownerUserFor(fake.ctx, "co-1")).toEqual({ userId: null, source: null });
    expect(await routeWork(fake.ctx, "co-1", ["bookkeeper"])).toMatchObject({ assigneeUserId: null, via: "operator" });
  });

  it("plain work routing never uses the last owner (with no Operator to take it, it says none): only approvals do", async () => {
    const fake = fakeCtx();
    registerRoleWatch(fake.ctx);
    await fake.deliver(ROLES_EVENT, "co-1", LATER);
    await fake.deliver(ROLES_EVENT, "co-1", rolesCopy({ ownerUserId: null, operatorAgentId: null, updatedAt: "2026-09-28T10:00:00.000Z" }));
    expect(await lastKnownOwner(fake.ctx, "co-1")).toBe("owner");
    expect(await routeWork(fake.ctx, "co-1", ["bookkeeper"])).toEqual({ assigneeAgentId: null, assigneeUserId: null, via: "none" });
    expect((await resolveApprover(fake.ctx, "co-1")).approverUserId).toBe("owner");
  });
});

describe("an approval an agent closed", () => {
  it("is handed back to the last known owner when the copy has none (an approval is never right unassigned)", async () => {
    const fake = fakeCtx();
    registerRoleWatch(fake.ctx);
    await fake.deliver(ROLES_EVENT, "co-1", LATER);
    await fake.deliver(ROLES_EVENT, "co-1", rolesCopy({ ownerUserId: null, updatedAt: "2026-09-28T10:00:00.000Z" }));
    expect(await reopenApprovalForPerson(fake.ctx, { issueId: "i1", companyId: "co-1" })).toBe(true);
    expect(fake.updates[0]).toEqual({ id: "i1", patch: { status: "todo", assigneeAgentId: null, assigneeUserId: "owner" } });
  });
});

describe("the approver chain", () => {
  it("sends outward work to the Reviewer first, then the owner decides", async () => {
    const fake = fakeCtx();
    setRoles(fake, "co-1", rolesCopy());
    const route = await resolveApprover(fake.ctx, "co-1", { outward: true });
    expect(route).toMatchObject({ reviewerAgentId: "rev", approverUserId: "owner", via: "reviewer", ownerSource: "roles" });
    expect(await resolveApprover(fake.ctx, "co-1", { outward: false })).toMatchObject({ reviewerAgentId: null, approverUserId: "owner", via: "owner" });
  });

  it("skips a Reviewer that is paused or not asked for", async () => {
    const fake = fakeCtx();
    setRoles(fake, "co-1", rolesCopy({ reviewerStatus: "paused" }));
    expect((await resolveApprover(fake.ctx, "co-1", { outward: true })).reviewerAgentId).toBeNull();
    setRoles(fake, "co-1", rolesCopy({ reviewOutward: false }));
    expect((await resolveApprover(fake.ctx, "co-1", { outward: true })).reviewerAgentId).toBeNull();
  });

  it("falls back to the host's default responsible user when the copy has no owner", async () => {
    const fake = fakeCtx({ companies: { "co-1": { defaultResponsibleUserId: "founder" } } });
    setRoles(fake, "co-1", FIRST);
    const route = await resolveApprover(fake.ctx, "co-1", { outward: true });
    expect(route).toMatchObject({ approverUserId: "founder", via: "owner", ownerSource: "company-default" });
    expect(route.notes.join(" ")).toContain("no owner");
  });

  it("works for a company that never had roles at all (Partners in Apps)", async () => {
    const fake = fakeCtx({ companies: { para: { defaultResponsibleUserId: "founder" } } });
    const route = await resolveApprover(fake.ctx, "para", { outward: true });
    expect(route).toMatchObject({ reviewerAgentId: null, approverUserId: "founder", ownerSource: "company-default" });
  });

  it("never treats the board sentinel as a person", async () => {
    expect(assignableUserId("local-board")).toBeNull();
    expect(assignableUserId("  ")).toBeNull();
    expect(assignableUserId(" u1 ")).toBe("u1");
    const fake = fakeCtx({ companies: { "co-1": { defaultResponsibleUserId: "local-board" } } });
    setRoles(fake, "co-1", rolesCopy({ ownerUserId: "local-board" }));
    expect((await resolveApprover(fake.ctx, "co-1")).approverUserId).toBeNull();
  });

  it("uses the person who triggered it, then the Operator, then says unrouted", async () => {
    const withActor = fakeCtx();
    setRoles(withActor, "co-1", FIRST);
    expect(await resolveApprover(withActor.ctx, "co-1", { actorUserId: "clicker" })).toMatchObject({ approverUserId: "clicker", ownerSource: "actor" });
    const nobody = fakeCtx();
    setRoles(nobody, "co-1", FIRST);
    expect(await resolveApprover(nobody.ctx, "co-1")).toMatchObject({ approverUserId: null, escalationAgentId: "op", via: "operator" });
    expect(await resolveApprover(fakeCtx().ctx, "co-1")).toMatchObject({ approverUserId: null, escalationAgentId: null, via: "unrouted" });
  });

  it("survives an unreadable copy and says so, once", async () => {
    const fake = fakeCtx({ stateReadThrows: true, companies: { "co-1": { defaultResponsibleUserId: "founder" } } });
    const read = await readCompanyRoles(fake.ctx, "co-1", 1_000_000);
    expect(read.roles).toBeNull();
    expect(read.error).toContain("state store failed");
    await readCompanyRoles(fake.ctx, "co-1", 1_000_100);
    expect(fake.ctx.logger.warn).toHaveBeenCalledTimes(1);
    const route = await resolveApprover(fake.ctx, "co-1", { outward: true });
    expect(route.approverUserId).toBe("founder");
    expect(route.notes.join(" ")).toContain("could not be read");
  });

  it("routeWork finds the default owner when the copy has none, and still says none with nobody", async () => {
    const withDefault = fakeCtx({ companies: { "co-1": { defaultResponsibleUserId: "founder" } } });
    setRoles(withDefault, "co-1", { ...FIRST, operatorAgentId: null });
    expect(await routeWork(withDefault.ctx, "co-1", ["bookkeeper"])).toMatchObject({ assigneeUserId: "founder", via: "owner" });
    expect(await routeWork(fakeCtx().ctx, "co-1", ["bookkeeper"])).toEqual({ assigneeAgentId: null, assigneeUserId: null, via: "none" });
  });
});

describe("openApprovalIssue (the agent tool-call failure, reproduced)", () => {
  const input = { companyId: "co-1", title: "Approve email sending: Niche 1", description: "Check the steps.", originKind: "plugin:partnersinbiz.crm", originId: "crm:sequence-email:s1", outward: true };

  it("assigns the approval to a person even with the frozen, ownerless roles copy and an agent as the actor", async () => {
    // Live 2026-10-01 16:04: copy = FIRST (owner null, reviewOutward false), actor = an agent in a tool call.
    const fake = fakeCtx({ companies: { "co-1": { defaultResponsibleUserId: "owner" } } });
    setRoles(fake, "co-1", FIRST);
    const result = await openApprovalIssue(fake.ctx, input);
    expect(result.assignedTo).toBe("person");
    expect(fake.issues[0]).toMatchObject({ assigneeUserId: "owner", originId: "crm:sequence-email:s1" });
    expect(fake.issues[0]!.assigneeAgentId ?? null).toBeNull();
  });

  it("would have been unassigned before: the same copy gives no Reviewer and no owner on its own", async () => {
    const fake = fakeCtx();
    setRoles(fake, "co-1", FIRST);
    // No company default and no Operator in the copy's reach either: the only honest answer is unrouted, and it is loud.
    setRoles(fake, "co-1", { ...FIRST, operatorAgentId: null });
    const result = await openApprovalIssue(fake.ctx, input);
    expect(result.assignedTo).toBe("nobody");
    expect(result.route.via).toBe("unrouted");
    expect(fake.issues[0]!.description).toContain("**Unrouted");
    expect(fake.ctx.logger.warn).toHaveBeenCalledWith("Approval opened without a person to decide it", expect.objectContaining({ assignedTo: "nobody" }));
  });

  it("hands it to the Operator to ask the owner when no person is known", async () => {
    const fake = fakeCtx();
    setRoles(fake, "co-1", FIRST);
    const result = await openApprovalIssue(fake.ctx, input);
    expect(result.assignedTo).toBe("operator");
    expect(fake.issues[0]).toMatchObject({ assigneeAgentId: "op" });
    expect(fake.issues[0]!.description).toContain("ask-owner");
    expect(fake.wakeups).toContain("issue-1");
  });

  it("routes outward work to the Reviewer with a brief that hands on to the owner", async () => {
    const fake = fakeCtx();
    setRoles(fake, "co-1", rolesCopy());
    const result = await openApprovalIssue(fake.ctx, { ...input, reviewerBrief: (route) => `BRIEF for ${route.approverUserId}` });
    expect(result.assignedTo).toBe("reviewer");
    expect(fake.issues[0]).toMatchObject({ assigneeAgentId: "rev" });
    expect(fake.issues[0]!.description).toContain("BRIEF for owner");
    expect(result.woke).toBe(true);
  });

  it("tries the next route when the host refuses the owner as assignee", async () => {
    const fake = fakeCtx({ refusedUsers: ["owner"] });
    setRoles(fake, "co-1", rolesCopy({ reviewOutward: false }));
    const result = await openApprovalIssue(fake.ctx, input);
    expect(result.assignedTo).toBe("operator");
    expect(fake.issues).toHaveLength(1);
    expect(fake.ctx.logger.info).toHaveBeenCalledWith("Approval assignee refused; trying the next route", expect.objectContaining({ tried: "person" }));
  });
});

describe("unroutedApprovalsCheck", () => {
  const now = Date.parse("2026-10-03T12:00:00.000Z");
  const issue = (patch: Record<string, unknown>) => ({ companyId: "co-1", status: "todo", originKind: "plugin:partnersinbiz.crm", createdAt: "2026-10-03T09:00:00.000Z", ...patch });

  function seeded(patches: Array<Record<string, unknown>>) {
    const fake = fakeCtx();
    patches.forEach((patch, i) => fake.issues.push({ id: `i${i}`, identifier: `TST-${i}`, title: "Approve email sending: A", assigneeAgentId: null, assigneeUserId: null, ...issue(patch) } as never));
    return fake;
  }

  it("is red for an unassigned approval older than an hour, and names it", async () => {
    const fake = seeded([{ id: "i0", identifier: "PAR-457" }]);
    const check = await unroutedApprovalsCheck(fake.ctx, "co-1", { now });
    expect(check.key).toBe("approvals:unrouted");
    expect(check.status).toBe("bad");
    expect(check.detail).toContain("PAR-457");
    expect(check.since).toBe("2026-10-03T09:00:00.000Z");
  });

  it("ignores young, assigned and non-approval issues", async () => {
    const fake = seeded([
      { createdAt: "2026-10-03T11:30:00.000Z" },
      { assigneeUserId: "owner" },
      { assigneeAgentId: "rev" },
      { title: "Reconcile 16 new bank lines" },
      { originKind: "routine_execution" },
    ]);
    expect((await unroutedApprovalsCheck(fake.ctx, "co-1", { now })).status).toBe("ok");
  });

  it("finds approvals by title or origin and in the statuses people miss", async () => {
    expect(isApprovalIssue({ title: "Review social post: hello" })).toBe(true);
    expect(isApprovalIssue({ title: "Something", originKind: "plugin:partnersinbiz.seo:approval" })).toBe(true);
    expect(isApprovalIssue({ title: "Something", originId: "draft:approval-12" })).toBe(true);
    expect(isApprovalIssue({ title: "Reconcile bank lines" })).toBe(false);
    const fake = seeded([{ status: "backlog" }, { status: "blocked" }]);
    expect(await findUnroutedApprovals(fake.ctx, "co-1", { now })).toHaveLength(2);
  });

  it("warns, never reads ok, when the issue list cannot be read (a watchdog that is blind says so)", async () => {
    const fake = fakeCtx();
    (fake.ctx.issues as { list: unknown }).list = async () => {
      throw new Error("issues.read denied");
    };
    const check = await unroutedApprovalsCheck(fake.ctx, "co-1", { now });
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("issues.read denied");
    expect(check.detail).toContain("cannot tell whether any are waiting");
  });

  it("repairs them: assigns the approver and comments, and reports what it could not", async () => {
    const fake = seeded([{ id: "i0" }]);
    setRoles(fake, "co-1", rolesCopy());
    const done = await repairUnroutedApprovals(fake.ctx, "co-1", { now });
    expect(done.repaired).toEqual(["i0"]);
    expect(fake.updates[0]).toEqual({ id: "i0", patch: { assigneeUserId: "owner" } });
    expect(fake.comments[0]!.body).toContain("nobody assigned");
    const none = seeded([{ id: "i0" }]);
    expect(await repairUnroutedApprovals(none.ctx, "co-1", { now })).toEqual({ repaired: [], stillUnrouted: ["i0"] });
  });

  it("moves a backlog approval to todo when it assigns it, so it reaches the approver's inbox; other statuses keep theirs", async () => {
    const fake = seeded([{ id: "i0", status: "backlog" }, { id: "i1", status: "blocked" }, { id: "i2", status: "todo" }]);
    setRoles(fake, "co-1", rolesCopy());
    const done = await repairUnroutedApprovals(fake.ctx, "co-1", { now });
    expect(done.repaired.sort()).toEqual(["i0", "i1", "i2"]);
    const patch = (id: string) => fake.updates.find((u) => u.id === id)!.patch;
    expect(patch("i0")).toEqual({ assigneeUserId: "owner", status: "todo" });
    expect(patch("i1")).toEqual({ assigneeUserId: "owner" });
    expect(patch("i2")).toEqual({ assigneeUserId: "owner" });
  });
});

describe("rolesCopyHealth", () => {
  const now = Date.parse("2026-10-03T12:00:00.000Z");

  it("is quiet for a fresh copy with an owner", async () => {
    const fake = fakeCtx();
    setRoles(fake, "co-1", rolesCopy({ receivedAt: "2026-10-03T11:10:00.000Z" }));
    expect(await rolesCopyHealth(fake.ctx, "co-1", { now })).toBeNull();
  });

  it("flags a missing, ownerless, stale or unreadable copy", async () => {
    expect((await rolesCopyHealth(fakeCtx().ctx, "co-1", { now }))?.status).toBe("warn");
    const ownerless = fakeCtx();
    setRoles(ownerless, "co-1", rolesCopy({ ownerUserId: null, receivedAt: "2026-10-03T11:30:00.000Z" }));
    expect((await rolesCopyHealth(ownerless.ctx, "co-1", { now }))?.detail).toContain("no owner is set");
    const stale = fakeCtx();
    setRoles(stale, "co-1", rolesCopy({ receivedAt: "2026-10-02T11:00:00.000Z" }));
    expect((await rolesCopyHealth(stale.ctx, "co-1", { now }))?.detail).toContain("h old");
    const broken = fakeCtx({ stateReadThrows: true });
    expect((await rolesCopyHealth(broken.ctx, "co-1", { now }))?.status).toBe("bad");
  });

  it("keeps the roles copy under its own state key", () => {
    expect(roleKey("co-1")).toContain("pib-cockpit");
  });
});

describe("the default-owner lookup", () => {
  it("is cached for five minutes per context, and can be cleared", async () => {
    const fake = fakeCtx({ companies: { "co-1": { defaultResponsibleUserId: "founder" } } });
    let calls = 0;
    const original = fake.ctx.companies.get.bind(fake.ctx.companies);
    (fake.ctx.companies as { get: unknown }).get = async (id: string) => {
      calls += 1;
      return original(id);
    };
    expect(await companyDefaultOwner(fake.ctx, "co-1", 1_000)).toBe("founder");
    expect(await companyDefaultOwner(fake.ctx, "co-1", 1_000 + 60_000)).toBe("founder");
    expect(calls).toBe(1);
    expect(await companyDefaultOwner(fake.ctx, "co-1", 1_000 + 6 * 60_000)).toBe("founder");
    expect(calls).toBe(2);
    forgetCompanyDefaultOwner(fake.ctx, "co-1");
    await companyDefaultOwner(fake.ctx, "co-1", 1_000 + 6 * 60_000 + 1);
    expect(calls).toBe(3);
    // Another context never sees this one's memo.
    expect(await companyDefaultOwner(fakeCtx().ctx, "co-1")).toBeNull();
  });

  it("caches only an answer: a refused call (a job for an unconfigured company) does not hide the owner from a tool call seconds later", async () => {
    const fake = fakeCtx({ companies: { "co-1": { defaultResponsibleUserId: "founder" } } });
    const original = fake.ctx.companies.get.bind(fake.ctx.companies);
    let refuse = true;
    (fake.ctx.companies as { get: unknown }).get = async (id: string) => {
      if (refuse) throw new Error('Plugin "x" is not allowed to perform "companies.get": company context is required');
      return original(id);
    };
    expect(await companyDefaultOwner(fake.ctx, "co-1", 1_000)).toBeNull();
    refuse = false;
    expect(await companyDefaultOwner(fake.ctx, "co-1", 1_000 + 10_000)).toBe("founder");
    // an unknown company (null) is not cached either
    const unknown = fakeCtx();
    expect(await companyDefaultOwner(unknown.ctx, "ghost", 1_000)).toBeNull();
    (unknown.ctx.companies as { get: unknown }).get = async () => ({ id: "ghost", defaultResponsibleUserId: "late" });
    expect(await companyDefaultOwner(unknown.ctx, "ghost", 1_000 + 10_000)).toBe("late");
  });
});

describe("companyRoles repairs a missing owner for every existing caller", () => {
  it("fills the owner from the company default when the copy is frozen or ownerless", async () => {
    const fake = fakeCtx({ companies: { "co-1": { defaultResponsibleUserId: "founder" } } });
    setRoles(fake, "co-1", FIRST);
    const roles = await companyRoles(fake.ctx, "co-1");
    expect(roles).toMatchObject({ ownerUserId: "founder", operatorAgentId: "op", reviewOutward: false });
    // The raw copy is untouched.
    expect((await readCompanyRoles(fake.ctx, "co-1")).roles?.ownerUserId).toBeNull();
  });

  it("returns a minimal roles object for a company that never had one, so `.ownerUserId` is there", async () => {
    const fake = fakeCtx({ companies: { para: { defaultResponsibleUserId: "founder" } } });
    expect(await companyRoles(fake.ctx, "para")).toEqual({ companyId: "para", operatorAgentId: null, reviewerAgentId: null, ownerUserId: "founder", reviewOutward: false, updatedAt: "" });
  });

  it("leaves a copy that has an owner alone, and returns null when nothing is known", async () => {
    const fake = fakeCtx({ companies: { "co-1": { defaultResponsibleUserId: "founder" } } });
    setRoles(fake, "co-1", rolesCopy());
    expect((await companyRoles(fake.ctx, "co-1"))?.ownerUserId).toBe("owner");
    expect(await companyRoles(fakeCtx().ctx, "co-1")).toBeNull();
    const ownerless = fakeCtx();
    setRoles(ownerless, "co-1", FIRST);
    expect((await companyRoles(ownerless.ctx, "co-1"))?.ownerUserId).toBeNull();
  });
});
