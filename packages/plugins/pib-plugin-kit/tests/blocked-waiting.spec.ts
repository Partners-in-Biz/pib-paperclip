import { describe, expect, it, vi } from "vitest";
import {
  BLOCKED_ESCALATE_HOURS,
  UNBLOCK_MARK,
  ASK_OWNER_COMMENT_MARK,
  backlogWaitingItems,
  blockedComment,
  blockedWithoutPath,
  blockedWithoutPathCheck,
  blockersUnreadableCheck,
  dbBlockedByLookup,
  listBlockedIssues,
  parseBlockedComment,
  unblockPath,
  waitingBacklog,
} from "../src/index.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

const now = Date.parse("2026-10-03T12:00:00.000Z");

describe("blocked comments and unblock paths", () => {
  it("writes a comment a machine can read back", () => {
    const text = blockedComment("Waiting for Gmail access", { owner: { userId: "owner" }, action: "Owner grants the mailbox delegation", askId: "ask-1" });
    expect(text).toContain("**Blocked: Waiting for Gmail access**");
    expect(text).toContain(UNBLOCK_MARK);
    expect(parseBlockedComment(text)).toEqual({ owner: { userId: "owner" }, action: "Owner grants the mailbox delegation", askId: "ask-1" });
    expect(parseBlockedComment(blockedComment("x", { owner: "board", action: "Add DNS record" }))).toMatchObject({ owner: "board", askId: null });
    expect(parseBlockedComment("just words")).toBeNull();
    expect(parseBlockedComment(`<!-- ${UNBLOCK_MARK} {"owner":"nobody","action":"x"} -->`)).toBeNull();
    expect(parseBlockedComment(`<!-- ${UNBLOCK_MARK} {"owner":"board"} -->`)).toBeNull();
  });

  it("knows the ways a block gets unblocked", () => {
    expect(unblockPath({})).toBeNull();
    expect(unblockPath({ unblockDescriptor: { owner: "board", action: "Add the DNS record" } })).toBe("descriptor");
    expect(unblockPath({ unblockDescriptor: { owner: "board", action: " " } })).toBeNull();
    expect(unblockPath({ blockedBy: [{ id: "x" }] })).toBe("blocked-by");
    expect(unblockPath({}, { hasOpenAsk: true })).toBe("ask");
    expect(unblockPath({}, { comments: [`${ASK_OWNER_COMMENT_MARK}: may we?`] })).toBe("comment");
    expect(unblockPath({}, { comments: [blockedComment("x", { owner: "board", action: "y" })] })).toBe("comment");
    expect(unblockPath({ scheduledRetry: { at: "x" } })).toBe("retry");
    expect(unblockPath({ activeRecoveryAction: { id: "r" } })).toBe("recovery");
    expect(unblockPath({ assigneeUserId: "user-1" })).toBe("person");
    expect(unblockPath({ assigneeUserId: " " })).toBeNull();
  });
});

describe("the waiting list nobody sees", () => {
  function company(options: Parameters<typeof fakeCtx>[0] = {}) {
    const fake = fakeCtx(options);
    const base = { companyId: "co-1", originKind: "plugin:partnersinbiz.crm", assigneeAgentId: null, assigneeUserId: null };
    fake.issues.push(
      { ...base, id: "b1", identifier: "PAR-501", title: "Reply to Covalonic", status: "blocked", assigneeAgentId: "ag", blockedTransitionAt: "2026-10-01T10:00:00.000Z", createdAt: "2026-10-01T09:00:00.000Z" } as never,
      { ...base, id: "b2", identifier: "PAR-502", title: "Has a blocker (the list carries no relations; they are read)", status: "blocked", blockedTransitionAt: "2026-10-01T10:00:00.000Z", createdAt: "2026-10-01T09:00:00.000Z" } as never,
      { ...base, id: "b3", identifier: "PAR-503", title: "Fresh block", status: "blocked", blockedTransitionAt: "2026-10-03T11:00:00.000Z", createdAt: "2026-10-03T10:00:00.000Z" } as never,
      { ...base, id: "b4", identifier: "PAR-504", title: "Asked the owner", status: "blocked", blockedTransitionAt: "2026-10-01T10:00:00.000Z", createdAt: "2026-10-01T09:00:00.000Z" } as never,
      { ...base, id: "a1", identifier: "PAR-457", title: "Approve email sending: Niche 2", status: "todo", createdAt: "2026-10-01T16:04:00.000Z" } as never,
    );
    return fake;
  }

  it("lists blocked issues with how each gets unblocked", async () => {
    const rows = await listBlockedIssues(company({ blockers: { b2: ["other-issue"] } }).ctx, "co-1", { askIssueIds: new Set(["b4"]), now });
    expect(rows.map((r) => [r.identifier, r.path])).toEqual([["PAR-501", null], ["PAR-502", "blocked-by"], ["PAR-503", null], ["PAR-504", "ask"]]);
    expect(rows[0]!.ageHours).toBeCloseTo(50, 0);
  });

  it("escalates only blocks with no way out that are over a day old", async () => {
    const rows = await listBlockedIssues(company({ blockers: { b2: ["other-issue"] } }).ctx, "co-1", { askIssueIds: new Set(["b4"]), now });
    expect(blockedWithoutPath(rows).map((r) => r.identifier)).toEqual(["PAR-501"]);
    expect(blockedWithoutPath(rows, { olderThanHours: 0 }).map((r) => r.identifier)).toEqual(["PAR-501", "PAR-503"]);
    expect(BLOCKED_ESCALATE_HOURS).toBe(24);
    const check = blockedWithoutPathCheck(rows)!;
    expect(check).toMatchObject({ key: "issues:blocked-no-path", status: "bad" });
    expect(check.detail).toContain("PAR-501");
    expect(blockedWithoutPathCheck([])).toBeNull();
  });

  it("counts unrouted approvals and dead blocks as waiting, and turns them into Needs-you items", async () => {
    const backlog = await waitingBacklog(company({ blockers: { b2: ["other-issue"] } }).ctx, "co-1", { askIssueIds: new Set(["b4"]), now });
    expect(backlog.total).toBe(2);
    expect(backlog.unroutedApprovals.map((a) => a.identifier)).toEqual(["PAR-457"]);
    expect(backlog.blockedNoPath.map((b) => b.identifier)).toEqual(["PAR-501"]);
    const items = backlogWaitingItems(backlog, { prefix: "PAR" });
    expect(items.map((i) => [i.key, i.kind, i.href])).toEqual([["approval:a1", "review", "/PAR/issues/PAR-457"], ["blocked:b1", "judgement", "/PAR/issues/PAR-501"]]);
  });

  it("does not escalate what it cannot judge: with blockers unreadable, an issue with no descriptor is unknown", async () => {
    const rows = await listBlockedIssues(company({ blockers: "throws" }).ctx, "co-1", { now });
    expect(rows.map((r) => r.path)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    expect(blockedWithoutPath(rows)).toEqual([]);
    expect(blockedWithoutPathCheck(rows)).toBeNull();
  });

  it("says so when it is blind: an all-unknown result is a visible warning, not silence (no PiB plugin declares issue.relations.read)", async () => {
    const rows = await listBlockedIssues(company({ blockers: "throws" }).ctx, "co-1", { now });
    const check = blockersUnreadableCheck(rows)!;
    expect(check).toMatchObject({ key: "issues:blockers-unreadable", status: "warn" });
    expect(check.detail).toContain("4 blocked issues");
    expect(check.detail).toContain("PAR-501");
    expect(check.fix).toContain("dbBlockedByLookup");
    const backlog = await waitingBacklog(company({ blockers: "throws" }).ctx, "co-1", { now });
    expect(backlog.blockedUnknown.map((b) => b.identifier)).toEqual(["PAR-501", "PAR-502", "PAR-503", "PAR-504"]);
    expect(backlog.total).toBe(1); // the unrouted approval only: unknown is never counted as stuck
    expect(blockersUnreadableCheck([])).toBeNull();
    expect(blockersUnreadableCheck(await listBlockedIssues(company({ blockers: { b2: ["x"] } }).ctx, "co-1", { askIssueIds: new Set(["b4"]), now }))).toBeNull();
  });

  it("uses an injected blocker lookup (the Cockpit's issue_relations read) so no new capability is needed", async () => {
    const fake = company({ blockers: "throws" });
    const lookup = vi.fn(async (_companyId: string, ids: string[]) => ids.filter((id) => id === "b2"));
    const rows = await listBlockedIssues(fake.ctx, "co-1", { askIssueIds: new Set(["b4"]), now, blockedBy: lookup });
    expect(rows.map((r) => [r.identifier, r.path])).toEqual([["PAR-501", null], ["PAR-502", "blocked-by"], ["PAR-503", null], ["PAR-504", "ask"]]);
    // one call for all the issues that needed it, scoped to the company, and not for the one that has an ask
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("co-1", ["b1", "b2", "b3"]);
    expect(blockedWithoutPath(rows).map((r) => r.identifier)).toEqual(["PAR-501"]);
    expect(blockersUnreadableCheck(rows)).toBeNull();
    const backlog = await waitingBacklog(fake.ctx, "co-1", { askIssueIds: new Set(["b4"]), now, blockedBy: lookup });
    expect(backlog.blockedNoPath.map((b) => b.identifier)).toEqual(["PAR-501"]);
    expect(backlog.blockedUnknown).toEqual([]);
  });

  it("a failing blocker lookup is unknown (and logged), never an escalation", async () => {
    const fake = company();
    const rows = await listBlockedIssues(fake.ctx, "co-1", { now, blockedBy: async () => { throw new Error("relation issue_relations is not whitelisted"); } });
    expect(rows.map((r) => r.path)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    expect((fake.ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("blocker lookup failed");
    expect(blockedWithoutPath(rows)).toEqual([]);
  });

  it("does not escalate a blocked issue a person holds", async () => {
    const fake = company();
    fake.issues.push({ companyId: "co-1", id: "b5", identifier: "PAR-505", title: "Held by Peet", status: "blocked", assigneeUserId: "owner", originKind: "plugin:partnersinbiz.crm", blockedTransitionAt: "2026-09-30T10:00:00.000Z", createdAt: "2026-09-30T09:00:00.000Z" } as never);
    const rows = await listBlockedIssues(fake.ctx, "co-1", { now, blockedBy: async () => [] });
    expect(rows.find((r) => r.identifier === "PAR-505")!.path).toBe("person");
    expect(blockedWithoutPath(rows).map((r) => r.identifier)).not.toContain("PAR-505");
  });

  it("the database blocker lookup is company-scoped, ignores finished blockers and skips the query for nothing", async () => {
    const query = vi.fn(async () => [{ id: "b2" }]);
    const ctx = { db: { query } } as never;
    const lookup = dbBlockedByLookup(ctx);
    expect([...(await lookup("co-1", ["b1", "b2"]))]).toEqual(["b2"]);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("r.company_id = $1::uuid");
    expect(sql).toContain("b.status NOT IN ('done', 'cancelled')");
    expect(sql).toContain("related_issue_id IN ($2::uuid, $3::uuid)");
    expect(sql).toMatch(/public\.issue_relations/);
    expect(params).toEqual(["co-1", "b1", "b2"]);
    expect([...(await lookup("co-1", []))]).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("survives an unreadable issue list", async () => {
    const fake = fakeCtx();
    (fake.ctx.issues as { list: unknown }).list = async () => {
      throw new Error("denied");
    };
    expect(await waitingBacklog(fake.ctx, "co-1", { now })).toEqual({ unroutedApprovals: [], blockedNoPath: [], blockedUnknown: [], total: 0 });
  });
});
