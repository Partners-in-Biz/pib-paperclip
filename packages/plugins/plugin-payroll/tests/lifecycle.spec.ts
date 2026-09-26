/**
 * Pay run lifecycle through the services: employees with sealed details →
 * run → calculate → approval (separation of duties) → lock → ledger outbox
 * → Accounting result → payslips → Mailbox → bank file → reversal.
 * The database is the in-memory fake; host calls are recorded.
 */
import { isBalanced, type LedgerPostRequested, type MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => import("./fake-db.js"));

const fake = await import("./fake-db.js");
const { payrollConfigFrom } = await import("../src/config.js");
const { createEnv } = await import("../src/service/env.js");
const employees = await import("../src/service/employees.js");
const runs = await import("../src/service/runs.js");
const payslips = await import("../src/service/payslips.js");
const statutory = await import("../src/service/statutory.js");
const leave = await import("../src/service/leave.js");
const { assertMaskedOutput, PAYROLL_TOOL_NAMES } = await import("../src/tools.js");
const { runTool } = await import("../src/service/agent-tools.js");

const C = "company-1";
const preparer = { kind: "user" as const, userId: "user-preparer", agentId: null };
const approver = { kind: "user" as const, userId: "user-approver", agentId: null };
const other = { kind: "user" as const, userId: "user-other", agentId: null };
const clerk = { kind: "agent" as const, userId: null, agentId: "agent-clerk" };
const PII = ["9001015009086", "0123456789", "62812345678", "250655"];

function makeHost() {
  const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const issues = new Map<string, Record<string, unknown>>();
  const outbox = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const raw = {
    employer: { legalName: "Partners in Biz (Pty) Ltd", payeReference: "7123456789", uifReference: "U1", sdlReference: "L1", address: "Ballito" },
    encryptionKey: "a-long-enough-test-encryption-key",
    r2: { accountId: "acc", bucket: "private", accessKeyId: "AK", secretAccessKey: "SK", prefix: "payroll" },
    approval: { defaultApproverUserId: "user-approver" },
    sdlMode: "registered",
    etiRegistered: true,
  };
  const ctx = {
    db: {
      namespace: "plugin_payroll_c6fcddb95c",
      // Only the kit outbox talks SQL here; everything else goes through the fake db module.
      query: async (sql: string, params: unknown[] = []) => {
        if (!sql.includes(".outbox")) throw new Error(`unexpected query ${sql}`);
        if (/WHERE key = \$1/.test(sql)) return outbox.has(String(params[0])) ? [outbox.get(String(params[0]))] : [];
        return [...outbox.values()].filter((r) => r.status === "pending");
      },
      execute: async (sql: string, params: unknown[] = []) => {
        if (!sql.includes(".outbox")) throw new Error(`unexpected execute ${sql}`);
        const key = String(params[0]);
        if (sql.startsWith("INSERT")) {
          if (outbox.has(key)) return { rowCount: 0 };
          outbox.set(key, { key, company_id: params[1], event: params[2], payload: JSON.parse(String(params[3])), status: "pending", attempts: 1, last_error: null, result: null });
          return { rowCount: 1 };
        }
        const row = outbox.get(key);
        if (!row) return { rowCount: 0 };
        if (/SET status = \$2, result = \$3/.test(sql) && row.status === "pending") {
          Object.assign(row, { status: params[1], result: JSON.parse(String(params[2])) });
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      },
    },
    events: { emit: async (name: string, _companyId: string, payload: Record<string, unknown>) => { emitted.push({ name, payload }); } },
    issues: {
      create: async (input: Record<string, unknown>) => { const id = `issue-${++seq}`; issues.set(id, { id, ...input }); return issues.get(id); },
      get: async (id: string) => issues.get(id) ?? null,
      update: async (id: string, patch: Record<string, unknown>) => { issues.set(id, { ...issues.get(id), ...patch }); return issues.get(id); },
      createComment: async (id: string, body: string) => { const issue = issues.get(id)!; issue.comments = [...((issue.comments as string[]) ?? []), body]; },
      requestWakeup: async () => ({}),
    },
    secrets: { resolve: async () => undefined },
    logger: { info: () => undefined, error: () => undefined },
  } as never;
  const env = createEnv(ctx, { now: () => new Date("2026-09-20T08:00:00Z"), config: async (companyId: string) => payrollConfigFrom(ctx, companyId, raw) });
  return { env, ctx, emitted, issues, outbox };
}

const puts: string[] = [];
beforeEach(() => {
  fake.reset();
  puts.length = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    puts.push(url);
    return new Response("", { status: 200 });
  });
});

async function setup(host: ReturnType<typeof makeHost>) {
  const a = await employees.saveEmployee(host.env, C, preparer, {
    firstName: "Thandi", lastName: "Nkosi", email: "thandi@example.test", startDate: "2025-01-01",
    idNumber: "9001015009086", taxReference: "0123456789", bankName: "FNB", branchCode: "250655", accountNumber: "62812345678",
  });
  const b = await employees.saveEmployee(host.env, C, preparer, { firstName: "Sipho", lastName: "Dube", startDate: "2026-07-01", dateOfBirth: "2004-05-01", etiEligible: true });
  await employees.saveTerms(host.env, C, preparer, { employeeId: a.employee!.id, rateMinor: 3_000_000, effectiveFrom: "2026-03-01" });
  await employees.saveTerms(host.env, C, preparer, { employeeId: b.employee!.id, rateMinor: 600_000, effectiveFrom: "2026-07-01" });
  const { run } = await runs.createRun(host.env, C, preparer, { frequency: "monthly" });
  return { aId: a.employee!.id, bId: b.employee!.id, runId: run.id };
}

describe("employees", () => {
  it("seals ID, tax and bank details and never stores or returns them in plaintext", async () => {
    const host = makeHost();
    const { aId } = await setup(host);
    const stored = JSON.stringify(fake.rows());
    for (const value of PII) expect(stored).not.toContain(value);
    const view = (await fake.listEmployees(null, C)).map((e) => employees.employeeSummary(e));
    expect(view.find((v) => v.id === aId)!.details).toEqual({ idOrPassport: "••••••086", taxReference: "••••••789", bank: "FNB ••••••5678" });
    expect(() => assertMaskedOutput(view)).not.toThrow();
    const revealed = await employees.revealEmployeeField(host.env, C, approver, { employeeId: aId, field: "bank" });
    expect((revealed.value as { accountNumber: string }).accountNumber).toBe("62812345678");
    await expect(employees.revealEmployeeField(host.env, C, clerk, { employeeId: aId, field: "tax" })).rejects.toThrow(/board member/);
    expect(JSON.stringify(fake.rows())).toContain("employee.revealed");
  });

  it("refuses an ID number that does not match the date of birth", async () => {
    const host = makeHost();
    await expect(employees.saveEmployee(host.env, C, preparer, { firstName: "A", lastName: "B", startDate: "2026-01-01", dateOfBirth: "1991-01-01", idNumber: "9001015009086" })).rejects.toThrow(/does not match/);
    await expect(employees.saveEmployee(host.env, C, clerk, { firstName: "A", lastName: "B", startDate: "2026-01-01" })).rejects.toThrow(/board members/);
  });
});

describe("pay run lifecycle", () => {
  it("calculates, enforces separation of duties, locks, posts a balanced journal and settles on the result", async () => {
    const host = makeHost();
    const { aId, bId, runId } = await setup(host);
    const detail = await runs.calculateRun(host.env, C, preparer, { runId });
    expect(detail.run.status).toBe("calculated");
    expect(detail.items.map((i) => [i.name, i.payeMinor, i.netMinor])).toEqual(expect.arrayContaining([["Thandi Nkosi", 468_100, 2_514_188], ["Sipho Dube", 0, 594_000]]));
    expect(detail.items.find((i) => i.employeeId === bId)!.etiMinor).toBe(112_500);
    expect(() => assertMaskedOutput(detail)).not.toThrow();
    for (const value of PII) expect(JSON.stringify(detail)).not.toContain(value);

    // The preparer cannot send it to themselves.
    await expect(runs.requestApproval(host.env, C, preparer, { runId, approverUserId: "user-preparer" })).rejects.toThrow(/cannot approve/);
    const request = await runs.requestApproval(host.env, C, preparer, { runId });
    expect(host.issues.get(request.approvalIssueId)).toMatchObject({ assigneeUserId: "user-approver", status: "todo" });

    // Nobody but the named approver approves; the preparer and agents never do.
    await expect(runs.approveRun(host.env, C, preparer, { runId })).rejects.toThrow(/someone else/);
    await expect(runs.approveRun(host.env, C, clerk, { runId })).rejects.toThrow(/board member/);
    await expect(runs.approveRun(host.env, C, other, { runId })).rejects.toThrow(/different approver/);
    await expect(runs.lockRun(host.env, C, approver, { runId })).rejects.toThrow(/Only an approved/);

    // Closing the approval issue as the preparer reopens it.
    await host.env.ctx.issues.update(request.approvalIssueId, { status: "done" }, C);
    await runs.onApprovalIssueUpdated(host.env, C, request.approvalIssueId, { actorType: "user", actorId: "user-preparer" });
    expect(host.issues.get(request.approvalIssueId)!.status).toBe("todo");
    expect((await fake.getRun(null, C, runId))!.status).toBe("pending_approval");

    await runs.approveRun(host.env, C, approver, { runId });
    expect(host.issues.get(request.approvalIssueId)!.status).toBe("done");
    await runs.lockRun(host.env, C, approver, { runId });

    const post = host.emitted.find((e) => e.name === "ledger.post.requested")!.payload as unknown as LedgerPostRequested;
    expect(post.key).toBe(`payroll:run:${runId}`);
    expect(post.source.plugin).toBe("partnersinbiz.payroll");
    expect(isBalanced(post.lines)).toBe(true);
    expect(host.outbox.get(post.key)!.status).toBe("pending");

    // Accounting answers: the outbox settles and the run shows the journal.
    await runs.onLedgerResult(host.env, C, { key: post.key, status: "posted", journalId: "j-1", journalNumber: "JNL-0007", source: post.source });
    expect(host.outbox.get(post.key)!.status).toBe("done");
    expect((await fake.getRun(null, C, runId))!).toMatchObject({ status: "locked", ledgerStatus: "posted", journalNumber: "JNL-0007" });
    // Another plugin's result is ignored.
    await runs.onLedgerResult(host.env, C, { key: "billing:invoice:1:issue", status: "posted", source: { plugin: "partnersinbiz.billing", kind: "invoice", id: "1" } });

    // A locked run cannot change.
    await expect(runs.calculateRun(host.env, C, preparer, { runId })).rejects.toThrow(/cannot be recalculated/);
    await expect(runs.adjustItem(host.env, C, preparer, { runId, employeeId: aId, inputs: { overtimeHours: 1 } })).rejects.toThrow(/Correct it with a new run/);
  });

  it("drops a pending approval when the run is recalculated", async () => {
    const host = makeHost();
    const { aId, runId } = await setup(host);
    await runs.calculateRun(host.env, C, preparer, { runId });
    const request = await runs.requestApproval(host.env, C, preparer, { runId });
    await runs.adjustItem(host.env, C, preparer, { runId, employeeId: aId, inputs: { components: [{ code: "BONUS", amountMinor: 1_000_000 }] } });
    expect((await fake.getRun(null, C, runId))!).toMatchObject({ status: "calculated", approvalIssueId: null });
    expect(host.issues.get(request.approvalIssueId)!.status).toBe("cancelled");
  });

  it("lets an agent prepare and request approval, but a person approves", async () => {
    const host = makeHost();
    const { runId } = await setup(host);
    await runs.calculateRun(host.env, C, clerk, { runId });
    const run = await fake.getRun(null, C, runId);
    expect(run).toMatchObject({ preparedByUserId: null, preparedByAgentId: "agent-clerk" });
    await runs.requestApproval(host.env, C, clerk, { runId, approverUserId: "user-preparer" });
    await runs.approveRun(host.env, C, preparer, { runId });
    expect((await fake.getRun(null, C, runId))!.status).toBe("approved");
  });
});

describe("after locking", () => {
  async function lockedRun() {
    const host = makeHost();
    const ids = await setup(host);
    await runs.calculateRun(host.env, C, preparer, { runId: ids.runId });
    await runs.requestApproval(host.env, C, preparer, { runId: ids.runId });
    await runs.approveRun(host.env, C, approver, { runId: ids.runId });
    await runs.lockRun(host.env, C, approver, { runId: ids.runId });
    return { host, ...ids };
  }

  it("renders payslips to private storage and emails them once through the Mailbox", async () => {
    const { host, runId } = await lockedRun();
    const made = await payslips.generatePayslips(host.env, C, runId);
    expect(made).toEqual({ created: 2, skipped: null });
    expect(puts.every((url) => url.startsWith("https://acc.r2.cloudflarestorage.com/private/payroll/company-1/payslips/2026-09/"))).toBe(true);
    const sent = await payslips.emailPayslips(host.env, C, approver, { runId });
    // Sipho has no email address.
    expect(sent.queued).toBe(1);
    expect(sent.skipped).toEqual([{ payslip: expect.stringMatching(/-E002$/), reason: "no email address" }]);
    const mail = host.emitted.find((e) => e.name === "mail.send.requested")!.payload as unknown as MailSendRequested;
    expect(mail.to).toEqual([{ email: "thandi@example.test", name: "Thandi Nkosi" }]);
    expect(mail.context).toMatchObject({ plugin: "partnersinbiz.payroll", kind: "payslip" });
    expect(mail.attachments![0]!.url).toContain("X-Amz-Expires=604800");
    expect(mail.text).toContain("Hi Thandi");
    expect((await payslips.emailPayslips(host.env, C, approver, { runId })).queued).toBe(0);
    await payslips.onMailResult(host.env, C, { key: mail.key, status: "sent", sentAt: "2026-09-25T10:00:00Z", context: mail.context });
    expect((await fake.listPayslips(null, C, runId)).find((p) => p.mailKey === mail.key)!.status).toBe("sent");
    expect(host.outbox.get(mail.key)!.status).toBe("done");
    await expect(payslips.emailPayslips(host.env, C, clerk, { runId })).rejects.toThrow(/board members/);
  });

  it("builds the net pay file only for board members, with the sealed bank details", async () => {
    const { host, runId } = await lockedRun();
    const file = await statutory.netPayFile(host.env, C, approver, { runId, format: "netcash" });
    expect(file.rows).toBe(1);
    expect(file.missing).toEqual(["Sipho Dube"]);
    expect(file.url).toContain("X-Amz-Expires=900");
    expect(JSON.stringify(fake.rows())).not.toContain("62812345678");
    await expect(statutory.netPayFile(host.env, C, clerk, { runId, format: "acb" })).rejects.toThrow(/board members/);
  });

  it("reverses through a new run that needs its own approval", async () => {
    const { host, runId } = await lockedRun();
    const { run: reversal } = await runs.reverseRun(host.env, C, preparer, { runId, reason: "Wrong month" });
    expect(reversal).toMatchObject({ kind: "reversal", status: "calculated", reversesRunId: runId });
    expect(reversal.totals.netPayMinor).toBe(-(2_514_188 + 594_000));
    await expect(runs.reverseRun(host.env, C, preparer, { runId })).rejects.toThrow(/already has a reversal/);
    await runs.requestApproval(host.env, C, preparer, { runId: reversal.id });
    await runs.approveRun(host.env, C, approver, { runId: reversal.id });
    await runs.lockRun(host.env, C, approver, { runId: reversal.id });
    const post = host.emitted.filter((e) => e.name === "ledger.post.requested").pop()!.payload as unknown as LedgerPostRequested;
    expect(post.reverseKey).toBe(`payroll:run:${runId}`);
    expect(isBalanced(post.lines)).toBe(true);
    expect((await fake.getRun(null, C, runId))!.status).toBe("reversed");
    const emp201 = await statutory.emp201(host.env, C, { month: "2026-09" });
    expect(emp201.emp201.payeMinor).toBe(0);
  });
});

describe("leave", () => {
  it("routes approval to a board member who did not ask, and unpaid leave reduces pay", async () => {
    const host = makeHost();
    const { aId, runId } = await setup(host);
    const { request } = await leave.requestLeave(host.env, C, preparer, { employeeId: aId, type: "unpaid", startDate: "2026-09-14", endDate: "2026-09-14" });
    expect(request.days).toBe(1);
    await expect(leave.decideLeave(host.env, C, preparer, { requestId: request.id, decision: "approve" })).rejects.toThrow(/someone else/);
    await leave.decideLeave(host.env, C, approver, { requestId: request.id, decision: "approve" });
    const detail = await runs.calculateRun(host.env, C, preparer, { runId });
    const thandi = detail.items.find((i) => i.employeeId === aId)!;
    // 8 hours of 173.33: R30 000 × 800 / 17 333 = R1 384.64 off
    expect(thandi.lines.find((l) => l.code === "LEAVE_UNPAID")!.amountMinor).toBe(-138_464);
    await expect(leave.requestLeave(host.env, C, preparer, { employeeId: aId, type: "family", startDate: "2026-09-21", endDate: "2026-09-25" })).rejects.toThrow(/Only 3/);
  });
});

describe("agent tools", () => {
  it("return masked data only, for every tool", async () => {
    const host = makeHost();
    const { aId, runId } = await setup(host);
    const run = { agentId: "agent-clerk", runId: "hb-1", companyId: C, projectId: "p" };
    const calls: Record<string, Record<string, unknown>> = {
      "payroll-overview": {},
      "payroll-rules": { taxYear: "2026/27" },
      "list-employees": {},
      "list-pay-runs": {},
      "adjust-pay-run-item": { runId, employeeId: aId, inputs: { overtimeHours: 2 } },
      "calculate-pay-run": { runId },
      "get-pay-run": { runId },
      "pay-run-variances": { runId },
      "request-pay-run-approval": { runId },
      "create-pay-run": { frequency: "weekly" },
      "request-leave": { employeeId: aId, type: "annual", startDate: "2026-10-05", endDate: "2026-10-06" },
      "list-leave": {},
      "leave-balances": {},
      "emp201-summary": { month: "2026-09" },
    };
    expect(Object.keys(calls).sort()).toEqual([...PAYROLL_TOOL_NAMES].sort());
    for (const [name, params] of Object.entries(calls)) {
      const result = await runTool(host.env, name, params, run);
      expect(result.error, `${name}: ${result.error}`).toBeUndefined();
      expect(result.data && typeof result.data === "object" && !Array.isArray(result.data), name).toBe(true);
      const text = JSON.stringify(result.data);
      for (const value of PII) expect(text, name).not.toContain(value);
      expect(text, name).not.toContain("thandi@example.test");
      expect(text, name).not.toContain("1990-01-01");
    }
    // No tool can approve, lock, reveal or make a bank file.
    for (const name of ["approve-pay-run", "lock-pay-run", "reveal-employee", "net-pay-file"]) {
      const refused = await runTool(host.env, name, { runId }, run);
      expect(refused.error).toMatch(/Unknown payroll tool/);
      expect(refused.data).toEqual({ ok: false, error: refused.error });
    }
  });
});
