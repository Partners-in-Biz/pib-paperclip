/**
 * Company Cockpit snapshot: unconfigured and configured companies, health
 * states, waiting approvals, the hourly push, and that the snapshot never
 * carries personal data.
 */
import { COCKPIT_ROUTE, SETUP_PLUGIN, registerModuleWatch, type CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => import("./fake-db.js"));

const fake = await import("./fake-db.js");
const { payrollConfigFrom } = await import("../src/config.js");
const { createEnv } = await import("../src/service/env.js");
const employees = await import("../src/service/employees.js");
const runs = await import("../src/service/runs.js");
const leave = await import("../src/service/leave.js");
const { generatePayslips } = await import("../src/service/payslips.js");
const { markRulesReviewed } = await import("../src/service/setup.js");
const { cockpitSnapshot, nextPayDay } = await import("../src/service/cockpit.js");
const { followUp } = await import("../src/service/jobs.js");
const { clerkOnLinked, CLERK_ROLE } = await import("../src/hire.js");
const manifest = (await import("../src/manifest.js")).default;

const C = "company-1";
const preparer = { kind: "user" as const, userId: "user-preparer", agentId: null };
const approver = { kind: "user" as const, userId: "user-approver", agentId: null };
const PII = ["9001015009086", "8501015009086", "0123456789", "62812345678", "250655", "Thandi", "Nkosi", "thandi@example.test", "Sipho", "Dlamini", "sipho@example.test"];

const FULL = {
  employer: { legalName: "Partners in Biz (Pty) Ltd", payeReference: "7123456789", uifReference: "U123456789", sdlReference: "L123456789", address: "Ballito" },
  encryptionKey: "a-long-enough-test-encryption-key",
  r2: { accountId: "acc", bucket: "private", accessKeyId: "AK", secretAccessKey: "SECRET-ACCESS-KEY", prefix: "payroll" },
  approval: { defaultApproverUserId: "user-approver" },
  sdlMode: "registered",
  etiRegistered: true,
};

function makeHost(raw: Record<string, unknown> = FULL) {
  const emitted: Array<{ name: string; companyId: string; payload: Record<string, unknown> }> = [];
  const issues = new Map<string, Record<string, unknown>>();
  const outbox = new Map<string, Record<string, unknown>>();
  const state = new Map<string, unknown>();
  const handlers = new Map<string, (event: Record<string, unknown>) => Promise<void>>();
  const skey = (k: Record<string, unknown>) => `${k.scopeKind}|${k.scopeId ?? ""}|${k.namespace ?? "default"}|${k.stateKey}`;
  let seq = 0;
  const ctx = {
    db: {
      namespace: "plugin_payroll_c6fcddb95c",
      query: async (sql: string, params: unknown[] = []) => {
        if (!sql.includes(".outbox")) throw new Error(`unexpected query ${sql}`);
        if (/WHERE key = \$1/.test(sql)) return outbox.has(String(params[0])) ? [outbox.get(String(params[0]))] : [];
        if (/count\(\*\)/.test(sql)) return [{ stuck: "0", failed: String([...outbox.values()].filter((r) => r.status === "failed").length), oldest: null }];
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
      on: (name: string, handler: (event: Record<string, unknown>) => Promise<void>) => { handlers.set(name, handler); },
    },
    state: {
      get: async (k: Record<string, unknown>) => state.get(skey(k)) ?? null,
      set: async (k: Record<string, unknown>, value: unknown) => { state.set(skey(k), value); },
    },
    config: { get: async () => raw },
    companies: { list: async () => [{ id: C }] },
    issues: {
      create: async (input: Record<string, unknown>) => { const id = `issue-${++seq}`; issues.set(id, { id, ...input }); return issues.get(id); },
      get: async (id: string) => issues.get(id) ?? null,
      update: async (id: string, patch: Record<string, unknown>) => { issues.set(id, { ...issues.get(id), ...patch }); return issues.get(id); },
      createComment: async () => undefined,
      requestWakeup: async () => ({}),
    },
    secrets: { resolve: async () => undefined },
    logger: { info: () => undefined, error: () => undefined },
  } as never;
  const env = createEnv(ctx, { now: () => new Date("2026-09-20T08:00:00Z"), config: async (companyId: string) => payrollConfigFrom(ctx, companyId, raw) });
  registerModuleWatch(ctx);
  async function switchModules(modules: Record<string, boolean>) {
    await handlers.get(`plugin.${SETUP_PLUGIN}.modules.updated`)!({ companyId: C, payload: { companyId: C, modules, updatedAt: new Date().toISOString() } });
  }
  return { env, ctx, emitted, outbox, state, switchModules };
}

async function addEmployee(host: ReturnType<typeof makeHost>, first = "Thandi", last = "Nkosi", id = "9001015009086") {
  const { employee } = await employees.saveEmployee(host.env, C, preparer, {
    firstName: first, lastName: last, email: `${first.toLowerCase()}@example.test`, startDate: "2025-01-01",
    idNumber: id, taxReference: "0123456789", bankName: "FNB", branchCode: "250655", accountNumber: "62812345678",
  });
  await employees.saveTerms(host.env, C, preparer, { employeeId: employee!.id, rateMinor: 3_000_000, effectiveFrom: "2026-03-01" });
  return employee!.id;
}

const kpi = (s: CockpitSnapshot, key: string) => s.kpis.find((k) => k.key === key);
const check = (s: CockpitSnapshot, key: string) => s.health.find((c) => c.key === key)!;

beforeEach(() => {
  fake.reset();
  vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
});

describe("manifest and hire", () => {
  it("declares the cockpit route at the bumped version", () => {
    expect(manifest.version).toBe("0.1.2");
    expect(manifest.apiRoutes).toContainEqual(COCKPIT_ROUTE);
  });

  it("asks for a $10 monthly budget and says the Cockpit alerts at 80%", () => {
    expect(CLERK_ROLE.budgetMonthlyCents).toBe(1000);
    expect(CLERK_ROLE.capabilities).toContain("80%");
  });
});

describe("nextPayDay", () => {
  it("rolls to next month and clamps to the month's last day", () => {
    expect(nextPayDay("2026-09-20", 25)).toBe("2026-09-25");
    expect(nextPayDay("2026-09-26", 25)).toBe("2026-10-25");
    expect(nextPayDay("2026-02-01", 31)).toBe("2026-02-28");
    expect(nextPayDay("2026-12-28", 25)).toBe("2027-01-25");
  });
});

describe("cockpit snapshot", () => {
  it("works before anything is set up", async () => {
    const host = makeHost({});
    const s = await cockpitSnapshot(host.env, C);
    expect(s).toMatchObject({ plugin: "partnersinbiz.payroll", title: "Payroll", checkedAt: "2026-09-20T08:00:00.000Z" });
    expect(check(s, "settings")).toMatchObject({ status: "warn", href: "/setup" });
    expect(kpi(s, "next_pay_date")).toMatchObject({ value: "2026-09-25", raw: 5, group: "people" });
    expect(kpi(s, "employees_active")).toMatchObject({ raw: 0 });
    expect(kpi(s, "last_run_cost")).toBeUndefined();
    expect(kpi(s, "emp201")).toBeUndefined();
    expect(check(s, "job:follow-up")).toMatchObject({ status: "ok", detail: "Has not run yet." });
    expect(check(s, "rules")).toMatchObject({ status: "ok" });
    expect(check(s, "rules_review")).toMatchObject({ status: "warn", href: "/payroll?tab=statutory" });
    expect(check(s, "ledger").status).toBe("ok");
    expect(s.waiting).toEqual([]);
    expect(s.health.find((c) => c.key === "snapshot")).toBeUndefined();
  });

  it("shows pay dates, costs, the EMP201, problems and approvals without personal data", async () => {
    const host = makeHost();
    await markRulesReviewed(host.env, C, approver);
    await addEmployee(host);
    await addEmployee(host, "Sipho", "Dlamini", "8501015009086");
    const { run } = await runs.createRun(host.env, C, preparer, { frequency: "monthly" });
    await runs.calculateRun(host.env, C, preparer, { runId: run.id });
    await runs.requestApproval(host.env, C, preparer, { runId: run.id });
    await runs.approveRun(host.env, C, approver, { runId: run.id });
    await runs.lockRun(host.env, C, approver, { runId: run.id });
    await generatePayslips(host.env, C, run.id);
    const slips = await fake.listPayslips(null, C, run.id);
    await fake.updatePayslip(null, C, slips[0]!.id, { status: "failed", error: "Mailbox not connected" });
    await fake.updatePayslip(null, C, slips[1]!.id, { status: "sent", emailed_to: "sipho@example.test", emailed_at: "2026-09-20T07:00:00.000Z" });
    await fake.updateRun(null, C, run.id, { ledger_status: "rejected", ledger_error: "No account for role payroll_expense" });

    // A correction run waiting for approval, and a leave request.
    const second = await runs.createRun(host.env, C, preparer, { frequency: "monthly" });
    await runs.calculateRun(host.env, C, preparer, { runId: second.run.id });
    const pending = await runs.requestApproval(host.env, C, preparer, { runId: second.run.id });
    const employeeId = (await fake.listEmployees(null, C))[0]!.id;
    await leave.requestLeave(host.env, C, preparer, { employeeId, type: "sick", startDate: "2026-09-22", endDate: "2026-09-22", reason: "Doctor visit" });

    const s = await cockpitSnapshot(host.env, C);
    const locked = (await fake.getRun(null, C, run.id))!;
    expect(kpi(s, "employees_active")).toMatchObject({ raw: 2 });
    expect(kpi(s, "last_run_cost")).toMatchObject({ raw: locked.totals.employerCostMinor, group: "money" });
    expect(locked.totals.employerCostMinor).toBeGreaterThan(0);
    expect(kpi(s, "emp201")!.value).toMatch(/ by 2026-10-07$/);
    expect(kpi(s, "emp201")!.raw).toBeGreaterThan(0);
    expect(kpi(s, "next_pay_date")!.label).toContain(second.run.number);
    expect(check(s, "ledger")).toMatchObject({ status: "bad" });
    expect(check(s, "payslips")).toMatchObject({ status: "warn" });
    expect(check(s, "rules_review").status).toBe("ok");

    const issueId = (pending as { approvalIssueId?: string }).approvalIssueId ?? (await fake.getRun(null, C, second.run.id))!.approvalIssueId;
    expect(s.waiting).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: `approval:${issueId}`, issueId, kind: "money", title: `Approve pay run ${second.run.number}` }),
      expect.objectContaining({ title: "Approve a leave request", kind: "judgement" }),
    ]));
    expect(s.activity.map((a) => a.text)).toEqual(expect.arrayContaining([`Locked pay run ${run.number} (2 employees)`, `Emailed 1 payslip for ${run.number}`]));
    expect(s.quality.map((q) => q.key)).toContain("adjustments");

    const text = JSON.stringify(s);
    for (const value of [...PII, "sick", "Doctor visit", "user-approver", "user-preparer", "7123456789", "a-long-enough-test-encryption-key"]) expect(text, value).not.toContain(value);
  });

  it("reports a missing rule version and failing jobs", async () => {
    const host = makeHost();
    const realNow = host.env.now;
    host.env.now = () => new Date("2031-06-01T08:00:00Z");
    host.state.set("instance||pib-cockpit-jobs|job:redeliver", { lastStartedAt: null, lastOkAt: null, lastErrorAt: "2031-06-01T07:55:00Z", lastError: "boom", consecutiveFailures: 3 });
    const s = await cockpitSnapshot(host.env, C);
    expect(check(s, "rules")).toMatchObject({ status: "bad" });
    expect(check(s, "job:redeliver")).toMatchObject({ status: "bad", detail: "Last error: boom" });
    host.env.now = realNow;
  });

  it("keeps the rest when one query fails", async () => {
    const host = makeHost();
    const spy = vi.spyOn(fake, "listEmployees").mockRejectedValueOnce(new Error("db down"));
    const s = await cockpitSnapshot(host.env, C);
    expect(kpi(s, "employees_active")).toBeUndefined();
    expect(kpi(s, "next_pay_date")).toBeDefined();
    expect(check(s, "snapshot").detail).toContain("db down");
    spy.mockRestore();
  });

  it("is pushed hourly by the follow-up job, only while Payroll is on", async () => {
    const host = makeHost();
    await addEmployee(host);
    const onLinked = clerkOnLinked(host.ctx, async () => []);
    await host.switchModules({ payroll: false });
    await followUp(host.env, onLinked, new Map(), new Map());
    expect(host.emitted.filter((e) => e.name === "cockpit.snapshot")).toEqual([]);

    await host.switchModules({ payroll: true });
    const pushed = new Map<string, number>();
    await followUp(host.env, onLinked, new Map(), pushed);
    const snaps = host.emitted.filter((e) => e.name === "cockpit.snapshot");
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ companyId: C, payload: { plugin: "partnersinbiz.payroll" } });
    await followUp(host.env, onLinked, new Map(), pushed);
    expect(host.emitted.filter((e) => e.name === "cockpit.snapshot")).toHaveLength(1);
    for (const value of PII) expect(JSON.stringify(snaps), value).not.toContain(value);
  });

  it("skips a company whose settings were never saved", async () => {
    const host = makeHost({});
    await followUp(host.env, clerkOnLinked(host.ctx, async () => []), new Map(), new Map());
    expect(host.emitted.filter((e) => e.name === "cockpit.snapshot")).toEqual([]);
  });
});
