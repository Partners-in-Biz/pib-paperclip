/**
 * What starts and finishes payroll work without a person watching:
 * - "Prepare pay run" before pay day and "EMP201 due by the 7th", once per
 *   month, routed to the Payroll Clerk / Bookkeeper, else the Operator, else
 *   the owner (never unassigned);
 * - "Lock on approval": a person's approval locks the run as them;
 * - an agent closing an approval hands it back to the person;
 * - payslips the follow-up job makes are emailed when sendOnLock is on;
 * - approved but unlocked runs wait in the Cockpit with a Lock link.
 */
import type { MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => import("./fake-db.js"));

const fake = await import("./fake-db.js");
const { payrollConfigFrom } = await import("../src/config.js");
const { createEnv } = await import("../src/service/env.js");
const employees = await import("../src/service/employees.js");
const runs = await import("../src/service/runs.js");
const lock = await import("../src/service/lock.js");
const triggers = await import("../src/service/triggers.js");
const { followUp } = await import("../src/service/jobs.js");
const { cockpitSnapshot } = await import("../src/service/cockpit.js");
const { clerkOnLinked } = await import("../src/hire.js");

const C = "company-1";
const preparer = { kind: "user" as const, userId: "user-preparer", agentId: null };
const approver = { kind: "user" as const, userId: "user-approver", agentId: null };

const FULL = {
  employer: { legalName: "Partners in Biz (Pty) Ltd", payeReference: "7123456789", uifReference: "U123456789", sdlReference: "L123456789", address: "Ballito" },
  encryptionKey: "a-long-enough-test-encryption-key",
  r2: { accountId: "acc", bucket: "private", accessKeyId: "AK", secretAccessKey: "SECRET-ACCESS-KEY", prefix: "payroll" },
  approval: { defaultApproverUserId: "user-approver" },
  sdlMode: "registered",
  etiRegistered: true,
};

type Issue = Record<string, unknown> & { id: string; status?: string; comments?: string[] };

function makeHost(raw: Record<string, unknown> = FULL, now = "2026-09-20T08:00:00Z") {
  const emitted: Array<{ name: string; companyId: string; payload: Record<string, unknown> }> = [];
  const issues = new Map<string, Issue>();
  const outbox = new Map<string, Record<string, unknown>>();
  const state = new Map<string, unknown>();
  const agents = new Map<string, { id: string; name: string; status: string }>();
  const skey = (k: Record<string, unknown>) => `${k.scopeKind}|${k.scopeId ?? ""}|${k.namespace ?? "default"}|${k.stateKey}`;
  let seq = 0;
  const ctx = {
    db: {
      namespace: "plugin_payroll_c6fcddb95c",
      query: async (sql: string, params: unknown[] = []) => {
        if (!sql.includes(".outbox")) throw new Error(`unexpected query ${sql}`);
        if (/WHERE key = \$1/.test(sql)) return outbox.has(String(params[0])) ? [outbox.get(String(params[0]))] : [];
        if (/count\(\*\)/.test(sql)) return [{ stuck: "0", failed: "0", oldest: null }];
        return [...outbox.values()].filter((r) => r.status === "pending");
      },
      execute: async (sql: string, params: unknown[] = []) => {
        if (!sql.includes(".outbox")) throw new Error(`unexpected execute ${sql}`);
        const key = String(params[0]);
        if (sql.startsWith("INSERT")) {
          if (outbox.has(key)) return { rowCount: 0 };
          outbox.set(key, { key, company_id: params[1], event: params[2], payload: JSON.parse(String(params[3])), status: "pending", attempts: 1 });
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      },
    },
    events: {
      emit: async (name: string, companyId: string, payload: Record<string, unknown>) => { emitted.push({ name, companyId, payload }); },
      on: () => undefined,
    },
    state: {
      get: async (k: Record<string, unknown>) => state.get(skey(k)) ?? null,
      set: async (k: Record<string, unknown>, value: unknown) => { state.set(skey(k), value); },
    },
    agents: {
      get: async (id: string) => agents.get(id) ?? null,
      list: async () => [...agents.values()],
    },
    config: { get: async () => raw },
    companies: { list: async () => [{ id: C }] },
    issues: {
      create: async (input: Record<string, unknown>) => { const id = `issue-${++seq}`; issues.set(id, { id, ...input }); return issues.get(id); },
      get: async (id: string) => issues.get(id) ?? null,
      update: async (id: string, patch: Record<string, unknown>) => { issues.set(id, { ...issues.get(id)!, ...patch }); return issues.get(id); },
      createComment: async (id: string, body: string) => { const issue = issues.get(id)!; issue.comments = [...(issue.comments ?? []), body]; },
      requestWakeup: async () => ({}),
    },
    secrets: { resolve: async () => undefined },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  } as never;
  const clock = { now: new Date(now) };
  const env = createEnv(ctx, { now: () => clock.now, config: async (companyId: string) => payrollConfigFrom(ctx, companyId, raw) });
  /** What the Cockpit broadcasts as `roles.updated`. */
  const roles = (over: Record<string, unknown> = {}) =>
    state.set(`company|${C}|pib-cockpit|roles`, { companyId: C, operatorAgentId: "agent-op", operatorStatus: "active", reviewerAgentId: null, ownerUserId: "user-owner", reviewOutward: false, updatedAt: "2026-09-20T00:00:00Z", ...over });
  /** Payroll's own linked Payroll Clerk (kit agent-hire state). */
  const linkClerk = (status = "idle") => {
    agents.set("agent-clerk", { id: "agent-clerk", name: "Payroll Clerk", status });
    state.set(`company|${C}|pib-hire|role:payroll-clerk`, { agentId: "agent-clerk", linkedAt: "2026-09-01T00:00:00Z", linkedBy: "manual", hire: null });
  };
  return { env, ctx, emitted, issues, outbox, state, clock, roles, linkClerk };
}

async function addEmployee(host: ReturnType<typeof makeHost>, first = "Thandi", email: string | null = "thandi@example.test") {
  const { employee } = await employees.saveEmployee(host.env, C, preparer, {
    firstName: first, lastName: "Nkosi", ...(email ? { email } : {}), startDate: "2025-01-01",
    idNumber: "9001015009086", taxReference: "0123456789", bankName: "FNB", branchCode: "250655", accountNumber: "62812345678",
  });
  await employees.saveTerms(host.env, C, preparer, { employeeId: employee!.id, rateMinor: 3_000_000, effectiveFrom: "2026-03-01" });
  return employee!.id;
}

async function pendingRun(host: ReturnType<typeof makeHost>) {
  const { run } = await runs.createRun(host.env, C, preparer, { frequency: "monthly" });
  await runs.calculateRun(host.env, C, preparer, { runId: run.id });
  const request = await runs.requestApproval(host.env, C, preparer, { runId: run.id });
  return { runId: run.id, issueId: request.approvalIssueId };
}

/** The approver marks the approval issue done (what the host's issue.updated event carries). */
async function approveByIssue(host: ReturnType<typeof makeHost>, issueId: string, userId = "user-approver") {
  host.issues.get(issueId)!.status = "done";
  return lock.onApprovalIssue(host.env, C, issueId, { actorType: "user", actorId: userId, status: "done" });
}

beforeEach(() => {
  fake.reset();
  vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
});

describe("Prepare pay run", () => {
  it("opens once, five days before pay day, for the Operator when there is no Payroll Clerk", async () => {
    const host = makeHost();
    host.roles();
    await addEmployee(host);
    const id = await triggers.prepareRunTrigger(host.env, C);
    const issue = host.issues.get(id!)!;
    expect(issue).toMatchObject({ title: "Prepare pay run for September 2026", assigneeAgentId: "agent-op", status: "todo", originId: "payroll:prepare:2026-09" });
    for (const text of ["25 September 2026", "`create-pay-run`", "`calculate-pay-run`", "`pay-run-variances`", "`request-pay-run-approval`", "partnersinbiz.cockpit:ask-owner", "approving also locks the run"]) {
      expect(String(issue.description), text).toContain(text);
    }
    // Once per month.
    expect(await triggers.prepareRunTrigger(host.env, C)).toBeNull();
    expect([...host.issues.values()].filter((i) => String(i.title).startsWith("Prepare pay run"))).toHaveLength(1);
  });

  it("waits until the lead time, and the lead time is a setting", async () => {
    const host = makeHost(FULL, "2026-09-18T08:00:00Z");
    host.roles();
    await addEmployee(host);
    expect(await triggers.prepareRunTrigger(host.env, C)).toBeNull();
    const early = makeHost({ ...FULL, prepareDaysBefore: 10 }, "2026-09-18T08:00:00Z");
    early.roles();
    expect(await triggers.prepareRunTrigger(early.env, C)).toBeTruthy();
  });

  it("goes to Payroll's own linked Clerk, even before the Cockpit knows it", async () => {
    const host = makeHost();
    host.roles();
    host.linkClerk();
    await addEmployee(host);
    const id = await triggers.prepareRunTrigger(host.env, C);
    expect(host.issues.get(id!)).toMatchObject({ assigneeAgentId: "agent-clerk" });
  });

  it("goes to the owner (a person) when no agent can take it", async () => {
    const host = makeHost();
    host.roles({ operatorAgentId: null });
    host.linkClerk("paused");
    await addEmployee(host);
    const id = await triggers.prepareRunTrigger(host.env, C);
    expect(host.issues.get(id!)).toMatchObject({ assigneeUserId: "user-owner" });
    expect(host.issues.get(id!)!.assigneeAgentId).toBeUndefined();
  });

  it("skips a month whose run is already with the approver, and companies without monthly staff", async () => {
    const host = makeHost();
    host.roles();
    expect(await triggers.prepareRunTrigger(host.env, C)).toBeNull();
    await addEmployee(host);
    await pendingRun(host);
    expect(await triggers.prepareRunTrigger(host.env, C)).toBeNull();
  });

  it("finds the next pay day across the month end, moved back to a weekday", () => {
    expect(triggers.nextMonthlyPayDate("2026-09-20", 25)).toBe("2026-09-25");
    // 25 October 2026 is a Sunday.
    expect(triggers.nextMonthlyPayDate("2026-09-26", 25)).toBe("2026-10-23");
  });
});

describe("EMP201 due by the 7th", () => {
  it("opens once early in the next month for the Bookkeeper, with the export and ask steps", async () => {
    const host = makeHost();
    host.roles({ team: { bookkeeper: { agentId: "agent-books", status: "active" } } });
    await addEmployee(host);
    const { runId, issueId } = await pendingRun(host);
    await approveByIssue(host, issueId);
    const number = (await fake.getRun(null, C, runId))!.number;
    host.clock.now = new Date("2026-10-02T06:00:00Z");
    const id = await triggers.emp201Trigger(host.env, C);
    const issue = host.issues.get(id!)!;
    expect(issue).toMatchObject({ title: "EMP201 for September 2026 due by 7 October 2026", assigneeAgentId: "agent-books", originId: "payroll:emp201:2026-09" });
    for (const text of [`Locked runs in it: ${number}.`, "`partnersinbiz.payroll:emp201-summary` with `month: \"2026-09\"`", "Payroll → Statutory → EMP201 (monthly)", "pick September 2026", "**Download CSV**", "partnersinbiz.cockpit:ask-owner"]) {
      expect(String(issue.description), text).toContain(text);
    }
    expect(await triggers.emp201Trigger(host.env, C)).toBeNull();
  });

  it("falls back to the Payroll Clerk, and stops after the due date", async () => {
    const host = makeHost(FULL, "2026-10-05T06:00:00Z");
    host.roles();
    host.linkClerk();
    await addEmployee(host);
    const id = await triggers.emp201Trigger(host.env, C);
    expect(host.issues.get(id!)).toMatchObject({ assigneeAgentId: "agent-clerk" });
    expect(String(host.issues.get(id!)!.description)).toContain("No locked pay run in the month yet");
    const late = makeHost(FULL, "2026-10-08T06:00:00Z");
    late.roles();
    await addEmployee(late);
    expect(await triggers.emp201Trigger(late.env, C)).toBeNull();
  });

  it("nothing for a company without staff or runs", async () => {
    const host = makeHost(FULL, "2026-10-02T06:00:00Z");
    host.roles();
    expect(await triggers.emp201Trigger(host.env, C)).toBeNull();
  });

  it("the follow-up job runs both triggers for enabled companies", async () => {
    const host = makeHost();
    host.roles();
    await addEmployee(host);
    await followUp(host.env, clerkOnLinked(host.ctx, async () => []), new Map(), new Map());
    expect([...host.issues.values()].map((i) => i.title)).toContain("Prepare pay run for September 2026");
  });
});

describe("after approval", () => {
  it("a person's done on the approval issue approves and locks the run as that person", async () => {
    const host = makeHost();
    await addEmployee(host);
    await addEmployee(host, "Sipho", null);
    const { runId, issueId } = await pendingRun(host);
    expect(String(host.issues.get(issueId)!.description)).toContain("Approving also locks the run as you");
    const locked = await approveByIssue(host, issueId);
    expect(locked).toMatchObject({ runId, status: "locked", payslips: { created: 2, skipped: null, emailed: 0 } });
    expect(await fake.getRun(null, C, runId)).toMatchObject({ status: "locked", approvedByUserId: "user-approver", lockedByUserId: "user-approver", ledgerStatus: "pending" });
    expect(host.emitted.some((e) => e.name === "ledger.post.requested")).toBe(true);
    expect(host.issues.get(issueId)!.comments!.at(-1)).toBe("Locked as the approver: posted to Accounting. 2 payslip(s) made.");
  });

  it("emails the payslips on lock when the setting is on", async () => {
    const host = makeHost({ ...FULL, payslipEmail: { sendOnLock: true } });
    await addEmployee(host);
    const { issueId } = await pendingRun(host);
    const locked = await approveByIssue(host, issueId);
    expect(locked!.payslips).toMatchObject({ created: 1, emailed: 1 });
    const mail = host.emitted.find((e) => e.name === "mail.send.requested")!.payload as unknown as MailSendRequested;
    expect(mail.to).toEqual([{ email: "thandi@example.test", name: "Thandi Nkosi" }]);
    expect(mail.marketing).toBeUndefined();
  });

  it("Approve on the page locks too; with Lock on approval off it only approves, and the Cockpit lists it with a Lock link", async () => {
    const host = makeHost();
    await addEmployee(host);
    const first = await pendingRun(host);
    expect(await lock.approveFromPage(host.env, C, approver, { runId: first.runId })).toMatchObject({ status: "locked", locked: { payslips: { created: 1 } } });

    const off = makeHost({ ...FULL, approval: { defaultApproverUserId: "user-approver", lockOnApproval: false } });
    fake.reset();
    await addEmployee(off);
    const second = await pendingRun(off);
    expect(String(off.issues.get(second.issueId)!.description)).toContain("after approval a board member locks the run");
    expect(await lock.approveFromPage(off.env, C, approver, { runId: second.runId })).toMatchObject({ status: "approved", locked: null });
    expect((await fake.getRun(null, C, second.runId))!.status).toBe("approved");
    // The issue path does not lock either.
    const third = await (async () => {
      fake.reset();
      await addEmployee(off);
      return pendingRun(off);
    })();
    expect(await approveByIssue(off, third.issueId)).toBeNull();
    expect((await fake.getRun(null, C, third.runId))!.status).toBe("approved");
    const snap = await cockpitSnapshot(off.env, C);
    const run = (await fake.getRun(null, C, third.runId))!;
    expect(snap.waiting).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: `lock:${run.id}`, title: `Lock pay run ${run.number}`, kind: "money", href: `/payroll?tab=runs&run=${run.id}` }),
    ]));
    expect(snap.waiting.find((w) => w.key === `lock:${run.id}`)!.why).toMatch(/not in the books and no payslips/);
  });

  it("an agent closing or cancelling the approval hands it back to the approver; nothing is approved", async () => {
    const host = makeHost();
    await addEmployee(host);
    const { runId, issueId } = await pendingRun(host);
    const issue = host.issues.get(issueId)!;
    for (const status of ["done", "cancelled"]) {
      Object.assign(issue, { status, assigneeAgentId: "agent-op", assigneeUserId: null });
      expect(await lock.onApprovalIssue(host.env, C, issueId, { actorType: "agent", actorId: "agent-op", status })).toBeNull();
      expect(host.issues.get(issueId)).toMatchObject({ status: "todo", assigneeAgentId: null, assigneeUserId: "user-approver" });
      expect(host.issues.get(issueId)!.comments!.at(-1)).toMatch(/Only a person can decide it/);
      expect((await fake.getRun(null, C, runId))!.status).toBe("pending_approval");
    }
  });
});

describe("team", () => {
  it("the Cockpit snapshot reports Payroll's linked Clerk, so routeWork can find it", async () => {
    const host = makeHost();
    expect((await cockpitSnapshot(host.env, C)).team).toEqual([{ role: "payroll-clerk", agentId: null, status: null }]);
    host.linkClerk("idle");
    expect((await cockpitSnapshot(host.env, C)).team).toEqual([{ role: "payroll-clerk", agentId: "agent-clerk", status: "idle" }]);
  });
});

describe("payslips from the follow-up job", () => {
  async function lockedWithoutPayslips(host: ReturnType<typeof makeHost>) {
    await addEmployee(host);
    const { runId } = await pendingRun(host);
    await runs.approveRun(host.env, C, approver, { runId });
    await runs.lockRun(host.env, C, approver, { runId });
    return runId;
  }

  it("are emailed when sendOnLock is on", async () => {
    const host = makeHost({ ...FULL, payslipEmail: { sendOnLock: true } });
    const runId = await lockedWithoutPayslips(host);
    await followUp(host.env, clerkOnLinked(host.ctx, async () => []), new Map(), new Map());
    expect((await fake.listPayslips(null, C, runId)).map((p) => p.status)).toEqual(["sending"]);
    expect(host.emitted.filter((e) => e.name === "mail.send.requested")).toHaveLength(1);
    // The next run finds nothing missing and sends nothing again.
    await followUp(host.env, clerkOnLinked(host.ctx, async () => []), new Map(), new Map());
    expect(host.emitted.filter((e) => e.name === "mail.send.requested")).toHaveLength(1);
  });

  it("are only made when sendOnLock is off", async () => {
    const host = makeHost();
    const runId = await lockedWithoutPayslips(host);
    await followUp(host.env, clerkOnLinked(host.ctx, async () => []), new Map(), new Map());
    expect((await fake.listPayslips(null, C, runId)).map((p) => p.status)).toEqual(["ready"]);
    expect(host.emitted.filter((e) => e.name === "mail.send.requested")).toEqual([]);
  });
});
