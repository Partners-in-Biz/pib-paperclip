/**
 * Done-checks and flows: an agent closing "Prepare pay run" or "EMP201 due"
 * is checked against Payroll's own data (pass, open again with what is
 * missing, or finished another way), and the Cockpit gets live numbers for
 * the payroll stages.
 */
import { runDoneCheck, type DoneCheckRule } from "@partnersinbiz/pib-plugin-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => import("./fake-db.js"));

const fake = await import("./fake-db.js");
const { payrollConfigFrom } = await import("../src/config.js");
const { createEnv } = await import("../src/service/env.js");
const employees = await import("../src/service/employees.js");
const runs = await import("../src/service/runs.js");
const lock = await import("../src/service/lock.js");
const triggers = await import("../src/service/triggers.js");
const { exportStatutory } = await import("../src/service/statutory.js");
const { payrollDoneChecks } = await import("../src/service/done-checks.js");
const { emp201Filing, markEmp201Filed, unmarkEmp201Filed } = await import("../src/service/emp201-filing.js");
const { payrollFlowReports, cockpitSnapshot } = await import("../src/service/cockpit.js");
const { runTool } = await import("../src/service/agent-tools.js");

const C = "company-1";
const preparer = { kind: "user" as const, userId: "user-preparer", agentId: null };
const owner = { kind: "user" as const, userId: "user-owner", agentId: null };
const clerk = { kind: "agent" as const, userId: null, agentId: "agent-clerk" };

const FULL = {
  employer: { legalName: "Partners in Biz (Pty) Ltd", payeReference: "7123456789", uifReference: "U123456789", sdlReference: "L123456789", address: "Ballito" },
  encryptionKey: "a-long-enough-test-encryption-key",
  r2: { accountId: "acc", bucket: "private", accessKeyId: "AK", secretAccessKey: "SECRET-ACCESS-KEY", prefix: "payroll" },
  approval: { defaultApproverUserId: "user-approver" },
  sdlMode: "registered",
  etiRegistered: true,
};

type Comment = { id: string; body: string; authorAgentId: string | null; authorUserId: string | null; deletedAt: null };
type Issue = Record<string, unknown> & { id: string; status?: string; comments: Comment[] };

function makeHost(now = "2026-09-20T08:00:00Z") {
  const issues = new Map<string, Issue>();
  const outbox = new Map<string, Record<string, unknown>>();
  const state = new Map<string, unknown>();
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
    events: { emit: async () => undefined, on: () => undefined },
    state: {
      get: async (k: Record<string, unknown>) => state.get(skey(k)) ?? null,
      set: async (k: Record<string, unknown>, value: unknown) => { state.set(skey(k), value); },
    },
    agents: { get: async () => null, list: async () => [] },
    config: { get: async () => FULL },
    companies: { list: async () => [{ id: C }] },
    issues: {
      create: async (input: Record<string, unknown>) => { const id = `issue-${++seq}`; issues.set(id, { id, comments: [], ...input }); return issues.get(id); },
      get: async (id: string) => issues.get(id) ?? null,
      update: async (id: string, patch: Record<string, unknown>) => { issues.set(id, { ...issues.get(id)!, ...patch }); return issues.get(id); },
      createComment: async (id: string, body: string, _companyId: string, options?: { authorAgentId?: string }) => {
        const comment: Comment = { id: `c-${++seq}`, body, authorAgentId: options?.authorAgentId ?? null, authorUserId: null, deletedAt: null };
        issues.get(id)!.comments.push(comment);
        return comment;
      },
      listComments: async (id: string) => issues.get(id)?.comments ?? [],
      requestWakeup: async () => ({}),
    },
    secrets: { resolve: async () => undefined },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  } as never;
  const clock = { now: new Date(now) };
  const env = createEnv(ctx, { now: () => clock.now, config: async (companyId: string) => payrollConfigFrom(ctx, companyId, FULL) });
  state.set(`company|${C}|pib-cockpit|roles`, { companyId: C, operatorAgentId: "agent-op", operatorStatus: "active", reviewerAgentId: null, ownerUserId: "user-owner", reviewOutward: false, updatedAt: "2026-09-20T00:00:00Z" });
  const rules: DoneCheckRule[] = payrollDoneChecks(env);
  /** The agent marks the issue done: the kit runs Payroll's rules on it. */
  const agentCloses = (issueId: string) => {
    issues.get(issueId)!.status = "done";
    return runDoneCheck(ctx, rules, { entityId: issueId, companyId: C, actorType: "agent" });
  };
  const lastComment = (issueId: string) => issues.get(issueId)!.comments.at(-1)?.body ?? "";
  /** What the Cockpit's ask-owner posts, and the owner's reply. */
  const ask = (issueId: string) => issues.get(issueId)!.comments.push({ id: `c-${++seq}`, body: "**Question for the owner** · Money · needed by 2026-10-07\n\nPlease file and pay the EMP201.", authorAgentId: "agent-books", authorUserId: null, deletedAt: null });
  const reply = (issueId: string, body = "Filed and paid, PRN 7123456789LC09") => issues.get(issueId)!.comments.push({ id: `c-${++seq}`, body, authorAgentId: null, authorUserId: "user-owner", deletedAt: null });
  return { env, ctx, issues, state, clock, rules, agentCloses, lastComment, ask, reply };
}

async function addEmployee(host: ReturnType<typeof makeHost>, first = "Thandi") {
  const { employee } = await employees.saveEmployee(host.env, C, preparer, {
    firstName: first, lastName: "Nkosi", email: `${first.toLowerCase()}@example.test`, startDate: "2025-01-01",
    idNumber: "9001015009086", taxReference: "0123456789", bankName: "FNB", branchCode: "250655", accountNumber: "62812345678",
  });
  await employees.saveTerms(host.env, C, preparer, { employeeId: employee!.id, rateMinor: 3_000_000, effectiveFrom: "2026-03-01" });
  return employee!.id;
}

/** September's run, locked by the approver (so it is in the September EMP201). */
async function lockedSeptemberRun(host: ReturnType<typeof makeHost>) {
  const { run } = await runs.createRun(host.env, C, preparer, { frequency: "monthly" });
  await runs.calculateRun(host.env, C, preparer, { runId: run.id });
  const { approvalIssueId } = await runs.requestApproval(host.env, C, preparer, { runId: run.id });
  host.issues.get(approvalIssueId)!.status = "done";
  await lock.onApprovalIssue(host.env, C, approvalIssueId, { actorType: "user", actorId: "user-approver", status: "done" });
  return run.id;
}

beforeEach(() => {
  fake.reset();
  vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
});

describe("Prepare pay run: done when the month's run is with the approver", () => {
  it("opens again with the next step until the run is sent for approval", async () => {
    const host = makeHost();
    const employeeId = await addEmployee(host);
    const issueId = (await triggers.prepareRunTrigger(host.env, C))!;
    expect(host.issues.get(issueId)!.originId).toBe("payroll:prepare:2026-09");
    expect(String(host.issues.get(issueId)!.description)).toContain("Closing it checks that the month's run is with the approver");

    // Nothing made yet.
    expect(await host.agentCloses(issueId)).toBe("reopened");
    expect(host.issues.get(issueId)!.status).toBe("todo");
    expect(host.lastComment(issueId)).toContain("**Not done yet** (Prepare pay run)");
    expect(host.lastComment(issueId)).toContain("No monthly pay run for September 2026 yet: `create-pay-run`");

    // A draft.
    const { run } = await runs.createRun(host.env, C, clerk, { frequency: "monthly" });
    expect(await host.agentCloses(issueId)).toBe("reopened");
    expect(host.lastComment(issueId)).toContain(`${run.number} is still a draft: \`calculate-pay-run\` with \`runId: "${run.id}"\``);

    // Calculated but not sent. (The third early close goes to the Operator instead of back to the agent.)
    await runs.calculateRun(host.env, C, clerk, { runId: run.id });
    expect(await host.agentCloses(issueId)).toBe("escalated");
    expect(host.lastComment(issueId)).toContain(`${run.number} is calculated but not sent for approval: \`request-pay-run-approval\``);
    expect(host.issues.get(issueId)).toMatchObject({ status: "todo", assigneeAgentId: "agent-op" });

    // With the approver: done.
    await runs.requestApproval(host.env, C, clerk, { runId: run.id });
    expect(await host.agentCloses(issueId)).toBe("passed");
    expect(host.issues.get(issueId)!.status).toBe("done");
    expect(employeeId).toBeTruthy();
  });

  it("names employees with errors, and a cancelled run with nothing in its place", async () => {
    const host = makeHost();
    await addEmployee(host);
    const issueId = (await triggers.prepareRunTrigger(host.env, C))!;
    const { run } = await runs.createRun(host.env, C, clerk, { frequency: "monthly" });
    await runs.calculateRun(host.env, C, clerk, { runId: run.id });
    // One employee's calculation failed.
    const [item] = await fake.listItems(null, C, run.id);
    await fake.upsertItem(null, C, { ...item!, status: "error" });
    expect(await host.agentCloses(issueId)).toBe("reopened");
    expect(host.lastComment(issueId)).toContain(`${run.number} has 1 employee with errors (\`get-pay-run\`)`);
    expect(host.lastComment(issueId)).toContain("partnersinbiz.cockpit:ask-owner");

    await runs.cancelRun(host.env, C, preparer, { runId: run.id });
    expect(await host.agentCloses(issueId)).toBe("reopened");
    expect(host.lastComment(issueId)).toContain(`The September 2026 run ${run.number} was cancelled and no run replaces it`);
  });

  it("finished another way: nobody is on monthly pay any more, or a person prepared it; a person's close is never checked", async () => {
    const host = makeHost();
    const employeeId = await addEmployee(host);
    const issueId = (await triggers.prepareRunTrigger(host.env, C))!;
    await employees.terminateEmployee(host.env, C, preparer, { employeeId, endDate: "2026-09-15", reason: "resigned" });
    expect(await host.agentCloses(issueId)).toBe("passed");

    fake.reset();
    const other = makeHost();
    await addEmployee(other);
    const otherIssue = (await triggers.prepareRunTrigger(other.env, C))!;
    const { run } = await runs.createRun(other.env, C, preparer, { frequency: "monthly" });
    await runs.calculateRun(other.env, C, preparer, { runId: run.id });
    await runs.requestApproval(other.env, C, preparer, { runId: run.id });
    expect(await other.agentCloses(otherIssue)).toBe("passed");

    fake.reset();
    const third = makeHost();
    await addEmployee(third);
    const thirdIssue = (await triggers.prepareRunTrigger(third.env, C))!;
    third.issues.get(thirdIssue)!.status = "done";
    expect(await runDoneCheck(third.ctx, third.rules, { entityId: thirdIssue, companyId: C, actorType: "user" })).toBe("skipped");
  });
});

describe("EMP201 due: done when filed, or downloaded and handed to the owner", () => {
  async function emp201Issue(host: ReturnType<typeof makeHost>) {
    await addEmployee(host);
    await lockedSeptemberRun(host);
    host.clock.now = new Date("2026-10-02T06:00:00Z");
    const issueId = (await triggers.emp201Trigger(host.env, C))!;
    expect(host.issues.get(issueId)!.originId).toBe("payroll:emp201:2026-09");
    return issueId;
  }

  it("opens again until the figures are downloaded and the owner was asked", async () => {
    const host = makeHost();
    const issueId = await emp201Issue(host);
    expect(String(host.issues.get(issueId)!.description)).toContain('`partnersinbiz.payroll:mark-emp201-filed` (`month: "2026-09"`');

    expect(await host.agentCloses(issueId)).toBe("reopened");
    let body = host.lastComment(issueId);
    expect(body).toContain("The EMP201 for September 2026 is not marked filed.");
    expect(body).toContain("Its figures were not downloaded yet");
    expect(body).toContain("Nobody was asked to file and pay it: ask the owner once with `partnersinbiz.cockpit:ask-owner`");
    expect(body).toContain('`mark-emp201-filed` (`month: "2026-09"`');

    // Asked, but nobody downloaded the figures yet.
    host.ask(issueId);
    expect(await host.agentCloses(issueId)).toBe("reopened");
    body = host.lastComment(issueId);
    expect(body).toContain("Its figures were not downloaded yet");
    expect(body).not.toContain("Nobody was asked");

    // The owner downloads the figures (the export) while filing: done.
    await exportStatutory(host.env, C, owner, { kind: "emp201", month: "2026-09" });
    expect(await host.agentCloses(issueId)).toBe("passed");
    // Not filed until someone says so: the Cockpit still shows it.
    expect((await payrollFlowReports(host.env, C, await fake.listRuns(null, C))).find((f) => f.stage === "payroll.emp201")).toMatchObject({ count: 1 });
  });

  it("a person's reply with the download also counts; marking it filed finishes it on its own", async () => {
    const host = makeHost();
    const issueId = await emp201Issue(host);
    await exportStatutory(host.env, C, owner, { kind: "emp201", month: "2026-09" });
    host.reply(issueId);
    expect(await host.agentCloses(issueId)).toBe("passed");

    fake.reset();
    const other = makeHost();
    const otherIssue = await emp201Issue(other);
    // The owner filed without downloading and said so: the agent records it.
    const result = await runTool(other.env, "mark-emp201-filed", { month: "2026-09", reference: "7123456789LC09", filedOn: "2026-10-02" }, { agentId: "agent-books", runId: "r-1", companyId: C, projectId: "p" });
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ month: "2026-09", filed: true, filedOn: "2026-10-02", referenceSaved: true });
    expect(JSON.stringify(result.data)).not.toContain("7123456789");
    expect(await emp201Filing(other.env, C, "2026-09")).toMatchObject({ reference: "7123456789LC09", recordedBy: { agentId: "agent-books" } });
    expect(await other.agentCloses(otherIssue)).toBe("passed");
    expect(fake.rows()).toMatchObject({ audit: expect.arrayContaining([expect.objectContaining({ action: "emp201.filed", entityId: "2026-09" })]) });
  });

  it("marking filed: only a month that has ended, never in the future; only a person undoes it", async () => {
    const host = makeHost("2026-10-02T06:00:00Z");
    await expect(markEmp201Filed(host.env, C, clerk, { month: "2026-10" })).rejects.toThrow(/once the month has ended/);
    await expect(markEmp201Filed(host.env, C, clerk, { month: "2026-09", filedOn: "2026-10-09" })).rejects.toThrow(/future/);
    await expect(markEmp201Filed(host.env, C, { kind: "system", userId: null, agentId: null }, { month: "2026-09" })).rejects.toThrow(/person or agent/);
    const filing = await markEmp201Filed(host.env, C, owner, { month: "2026-09" });
    expect(filing).toMatchObject({ month: "2026-09", filedOn: "2026-10-02", reference: null, recordedBy: { userId: "user-owner" } });
    await expect(unmarkEmp201Filed(host.env, C, clerk, { month: "2026-09" })).rejects.toThrow(/board members/);
    expect(await unmarkEmp201Filed(host.env, C, owner, { month: "2026-09" })).toEqual({ month: "2026-09", filed: false });
    expect(await emp201Filing(host.env, C, "2026-09")).toBeNull();
  });
});

describe("flows: the payroll stages in the Cockpit", () => {
  const stage = (reports: Awaited<ReturnType<typeof payrollFlowReports>>, key: string) => reports.find((r) => r.stage === key)!;

  it("runs being prepared and waiting for approval, stuck from 2 days before pay day", async () => {
    const host = makeHost();
    await addEmployee(host);
    const { run } = await runs.createRun(host.env, C, clerk, { frequency: "monthly" });
    await runs.calculateRun(host.env, C, clerk, { runId: run.id });
    let reports = await payrollFlowReports(host.env, C, await fake.listRuns(null, C));
    const net = (await fake.getRun(null, C, run.id))!.totals.netPayMinor;
    expect(stage(reports, "payroll.prepare")).toEqual({ stage: "payroll.prepare", count: 1, stuck: 0, stuckReason: null, amountMinor: net, currency: "ZAR" });
    expect(stage(reports, "payroll.approval")).toEqual({ stage: "payroll.approval", count: 0, stuck: 0, stuckReason: null });

    host.clock.now = new Date("2026-09-23T08:00:00Z");
    reports = await payrollFlowReports(host.env, C, await fake.listRuns(null, C));
    expect(stage(reports, "payroll.prepare")).toMatchObject({ count: 1, stuck: 1, stuckReason: "1 with pay day in 2 days or less" });

    await runs.requestApproval(host.env, C, clerk, { runId: run.id });
    host.clock.now = new Date("2026-09-26T08:00:00Z");
    reports = await payrollFlowReports(host.env, C, await fake.listRuns(null, C));
    expect(stage(reports, "payroll.prepare")).toMatchObject({ count: 0, stuck: 0 });
    expect(stage(reports, "payroll.approval")).toMatchObject({ count: 1, stuck: 1, stuckReason: "1 past pay day", amountMinor: net });
  });

  it("the EMP201 due and not filed, stuck from 2 days before the 7th, gone once filed", async () => {
    const host = makeHost();
    await addEmployee(host);
    await lockedSeptemberRun(host);
    host.clock.now = new Date("2026-10-02T06:00:00Z");
    const all = await fake.listRuns(null, C);
    let emp201 = stage(await payrollFlowReports(host.env, C, all), "payroll.emp201");
    expect(emp201).toMatchObject({ count: 1, stuck: 0, stuckReason: null, currency: "ZAR" });
    expect(emp201.amountMinor).toBeGreaterThan(0);

    host.clock.now = new Date("2026-10-05T06:00:00Z");
    expect(stage(await payrollFlowReports(host.env, C, all), "payroll.emp201")).toMatchObject({ count: 1, stuck: 1, stuckReason: "Sep 2026 due 7 Oct 2026" });
    host.clock.now = new Date("2026-10-08T06:00:00Z");
    expect(stage(await payrollFlowReports(host.env, C, all), "payroll.emp201")).toMatchObject({ count: 1, stuck: 1, stuckReason: "Sep 2026 overdue since 7 Oct 2026" });

    await markEmp201Filed(host.env, C, owner, { month: "2026-09", filedOn: "2026-10-06" });
    expect(stage(await payrollFlowReports(host.env, C, all), "payroll.emp201")).toEqual({ stage: "payroll.emp201", count: 0, stuck: 0, stuckReason: null });

    // A company without staff or runs has nothing to file.
    fake.reset();
    expect(stage(await payrollFlowReports(host.env, C, []), "payroll.emp201")).toMatchObject({ count: 0 });
  });

  it("is in the Cockpit snapshot for every payroll stage, and the EMP201 KPI says when it was filed", async () => {
    const host = makeHost();
    await addEmployee(host);
    await lockedSeptemberRun(host);
    host.clock.now = new Date("2026-10-02T06:00:00Z");
    let snap = await cockpitSnapshot(host.env, C);
    expect(snap.flows!.map((f) => f.stage).sort()).toEqual(["payroll.approval", "payroll.emp201", "payroll.prepare"]);
    expect(snap.kpis.find((k) => k.key === "emp201")).toMatchObject({ label: "SARS EMP201 for Sep 2026, due 7 Oct 2026" });
    await markEmp201Filed(host.env, C, owner, { month: "2026-09", filedOn: "2026-10-02" });
    snap = await cockpitSnapshot(host.env, C);
    expect(snap.kpis.find((k) => k.key === "emp201")).toMatchObject({ label: "SARS EMP201 for Sep 2026, filed 2 Oct 2026", tone: "ok" });
    expect(snap.flows!.find((f) => f.stage === "payroll.emp201")).toMatchObject({ count: 0 });
  });
});
