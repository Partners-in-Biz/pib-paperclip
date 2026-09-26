/**
 * Guided setup and module switches: the setup-status checklist, the
 * follow-up job skipping companies that switched Payroll off, and no ledger
 * posting when Accounting is switched off.
 */
import { SETUP_PLUGIN, SETUP_STATUS_ROUTE, type LedgerPostRequested, type SetupItem, type SetupStatus } from "@partnersinbiz/pib-plugin-kit";
import { rememberPluginUiBase, registerModuleWatch } from "@partnersinbiz/pib-plugin-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => import("./fake-db.js"));

const fake = await import("./fake-db.js");
const { payrollConfigFrom } = await import("../src/config.js");
const { createEnv } = await import("../src/service/env.js");
const employees = await import("../src/service/employees.js");
const runs = await import("../src/service/runs.js");
const { setupStatus, markRulesReviewed } = await import("../src/service/setup.js");
const { followUp } = await import("../src/service/jobs.js");
const { clerkOnLinked } = await import("../src/hire.js");
const manifest = (await import("../src/manifest.js")).default;

const C = "company-1";
const preparer = { kind: "user" as const, userId: "user-preparer", agentId: null };
const approver = { kind: "user" as const, userId: "user-approver", agentId: null };
const PII = ["9001015009086", "0123456789", "62812345678", "250655"];
const SECRETS = ["a-long-enough-test-encryption-key", "SECRET-ACCESS-KEY"];

const FULL = {
  employer: { legalName: "Partners in Biz (Pty) Ltd", payeReference: "7123456789", uifReference: "U123456789", sdlReference: "L123456789", address: "Ballito" },
  encryptionKey: "a-long-enough-test-encryption-key",
  r2: { accountId: "acc", bucket: "private", accessKeyId: "AK", secretAccessKey: "SECRET-ACCESS-KEY", prefix: "payroll" },
  approval: { defaultApproverUserId: "user-approver" },
  sdlMode: "registered",
  etiRegistered: true,
};

function makeHost(raw: Record<string, unknown> = FULL, options: { configFails?: boolean } = {}) {
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
        const row = outbox.get(key);
        if (row && /SET status = \$2, result = \$3/.test(sql) && row.status === "pending") {
          Object.assign(row, { status: params[1], result: JSON.parse(String(params[2])) });
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
  const env = createEnv(ctx, {
    now: () => new Date("2026-09-20T08:00:00Z"),
    config: async (companyId: string) => {
      if (options.configFails) throw new Error("host unavailable");
      return payrollConfigFrom(ctx, companyId, raw);
    },
  });
  registerModuleWatch(ctx);
  /** What the Setup plugin broadcasts when a company changes its modules. */
  async function switchModules(modules: Record<string, boolean>) {
    const handler = handlers.get(`plugin.${SETUP_PLUGIN}.modules.updated`)!;
    await handler({ companyId: C, payload: { companyId: C, modules, updatedAt: new Date().toISOString() } });
  }
  return { env, ctx, emitted, outbox, state, switchModules };
}

const item = (status: SetupStatus, key: string): SetupItem => {
  const found = status.items.find((i) => i.key === key);
  if (!found) throw new Error(`no item ${key}`);
  return found;
};

async function addEmployee(host: ReturnType<typeof makeHost>, sealed = true) {
  const { employee } = await employees.saveEmployee(host.env, C, preparer, {
    firstName: "Thandi", lastName: "Nkosi", email: "thandi@example.test", startDate: "2025-01-01",
    ...(sealed ? { idNumber: "9001015009086", taxReference: "0123456789", bankName: "FNB", branchCode: "250655", accountNumber: "62812345678" } : {}),
  });
  await employees.saveTerms(host.env, C, preparer, { employeeId: employee!.id, rateMinor: 3_000_000, effectiveFrom: "2026-03-01" });
  return employee!.id;
}

async function lockedRun(host: ReturnType<typeof makeHost>) {
  await addEmployee(host);
  const { run } = await runs.createRun(host.env, C, preparer, { frequency: "monthly" });
  await runs.calculateRun(host.env, C, preparer, { runId: run.id });
  await runs.requestApproval(host.env, C, preparer, { runId: run.id });
  await runs.approveRun(host.env, C, approver, { runId: run.id });
  await runs.lockRun(host.env, C, approver, { runId: run.id });
  return run.id;
}

beforeEach(() => {
  fake.reset();
  vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
});

describe("manifest", () => {
  it("declares the setup-status route and its capability, at the bumped version", () => {
    expect(manifest.version).toBe("0.1.1");
    expect(manifest.apiRoutes).toEqual([expect.objectContaining({ routeKey: SETUP_STATUS_ROUTE.routeKey, path: "/setup-status", method: "GET" })]);
    expect(manifest.capabilities).toContain("api.routes.register");
  });
});

describe("setup status", () => {
  it("lists everything still missing for a company that has not set up payroll", async () => {
    const host = makeHost({});
    const status = await setupStatus(host.env, C);
    expect(status).toMatchObject({ plugin: "partnersinbiz.payroll", module: "payroll", title: "Payroll", version: "0.1.1", checkedAt: "2026-09-20T08:00:00.000Z" });
    expect(status.items.map((i) => i.key)).toEqual(["settings", "employer", "encryption_key", "private_storage", "approver", "employees", "tax_rules", "rules_review", "mailbox", "clerk"]);
    // Before the page reported its installation uuid, settings links go to the plugin list.
    expect(item(status, "settings")).toMatchObject({ status: "missing", required: true, href: "/company/settings/instance/plugins" });
    for (const key of ["employer", "encryption_key", "private_storage", "approver"]) {
      expect(item(status, key), key).toMatchObject({ status: "missing", required: true });
      expect(item(status, key).steps?.length, key).toBeGreaterThan(0);
    }
    expect(item(status, "employer").detail).toMatch(/PAYE reference number/);
    expect(item(status, "employees")).toMatchObject({ status: "blocked", blockedBy: ["encryption_key"], href: "/payroll?tab=employees" });
    expect(item(status, "tax_rules").status).toBe("done");
    const review = item(status, "rules_review");
    expect(review).toMatchObject({ status: "optional", required: false, action: { plugin: "partnersinbiz.payroll", key: "payroll.review-rules" } });
    expect(review.detail).toContain("treatment.uifFringeBenefits");
    expect(review.detail).toContain("leave.annualWorkingDays");
    expect(item(status, "mailbox")).toMatchObject({ status: "optional", required: false, href: "/mailbox" });
    expect(item(status, "clerk")).toMatchObject({ status: "optional", action: { plugin: "partnersinbiz.payroll", key: "payroll.start-hire" } });
  });

  it("shows done for a configured company, without personal details or secrets", async () => {
    const host = makeHost();
    await rememberPluginUiBase(host.ctx, "/_plugins/0f8e2c1a-1b2c-4d5e-8f90-123456789abc/ui/");
    await addEmployee(host);
    await markRulesReviewed(host.env, C, approver);
    await fake.upsertPayslip(null, C, { id: "ps-1", runId: "run-x", employeeId: "e", number: "PS-1", status: "sent", r2Key: null, bytes: 0, sha256: null, mailKey: "m", emailedTo: "thandi@example.test", emailedAt: null, error: null, createdAt: null });
    const status = await setupStatus(host.env, C);
    expect(item(status, "settings")).toMatchObject({ status: "done", href: "/company/settings/instance/plugins/0f8e2c1a-1b2c-4d5e-8f90-123456789abc" });
    expect(item(status, "employer").href).toBe("/company/settings/instance/plugins/0f8e2c1a-1b2c-4d5e-8f90-123456789abc");
    for (const key of ["employer", "encryption_key", "private_storage", "approver", "employees", "tax_rules", "rules_review", "mailbox"]) {
      expect(item(status, key).status, key).toBe("done");
    }
    expect(item(status, "clerk").status).toBe("optional");
    const text = JSON.stringify(status);
    for (const value of [...PII, ...SECRETS, "thandi@example.test", "user-approver", "7123456789"]) expect(text).not.toContain(value);
  });

  it("flags a default approver who also prepares runs", async () => {
    const host = makeHost();
    await addEmployee(host);
    await runs.createRun(host.env, C, approver, { frequency: "monthly" });
    const status = await setupStatus(host.env, C);
    expect(item(status, "approver")).toMatchObject({ status: "missing" });
    expect(item(status, "approver").detail).toMatch(/also prepared 1 recent pay run/);
  });

  it("marks a check it cannot run as unknown instead of failing the status", async () => {
    const host = makeHost(FULL, { configFails: true });
    const status = await setupStatus(host.env, C);
    expect(item(status, "settings").status).toBe("missing");
    for (const key of ["employer", "encryption_key", "private_storage", "approver"]) expect(item(status, key).status, key).toBe("unknown");
    expect(item(status, "tax_rules").status).toBe("done");
  });
});

describe("module switches", () => {
  it("skips new automatic work for a company that switched Payroll off", async () => {
    const host = makeHost();
    const runId = await lockedRun(host);
    // Payslips were not made at lock time here, so the follow-up job has work.
    expect(await fake.runsNeedingFollowUp()).toEqual([{ id: runId, companyId: C }]);
    const onLinked = clerkOnLinked(host.ctx, async () => []);

    await host.switchModules({ payroll: false });
    await followUp(host.env, onLinked, new Map());
    expect(await fake.listPayslips(null, C, runId)).toEqual([]);
    expect(host.emitted.filter((e) => e.name === "setup.status")).toEqual([]);

    await host.switchModules({ payroll: true });
    const published = new Map<string, number>();
    await followUp(host.env, onLinked, published);
    expect((await fake.listPayslips(null, C, runId)).length).toBe(1);
    const pushed = host.emitted.filter((e) => e.name === "setup.status");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ companyId: C, payload: { plugin: "partnersinbiz.payroll", module: "payroll" } });
    // Hourly at most per company.
    await followUp(host.env, onLinked, published);
    expect(host.emitted.filter((e) => e.name === "setup.status")).toHaveLength(1);
  });

  it("does not queue a ledger posting while Accounting is switched off, and posts once it is on", async () => {
    const host = makeHost();
    await host.switchModules({ accounting: false });
    const runId = await lockedRun(host);
    expect(host.emitted.filter((e) => e.name === "ledger.post.requested")).toEqual([]);
    expect(host.outbox.size).toBe(0);
    // The run itself still locks.
    expect(await fake.getRun(null, C, runId)).toMatchObject({ status: "locked", ledgerStatus: "none", ledgerError: runs.ACCOUNTING_OFF });
    await expect(runs.repostLedger(host.env, C, approver, { runId })).rejects.toThrow(/switched off/);

    await host.switchModules({ accounting: true });
    expect(await runs.repostLedger(host.env, C, approver, { runId })).toEqual({ runId, ledgerStatus: "pending" });
    const post = host.emitted.find((e) => e.name === "ledger.post.requested")!.payload as unknown as LedgerPostRequested;
    expect(post.key).toBe(`payroll:run:${runId}`);
    expect(await fake.getRun(null, C, runId)).toMatchObject({ ledgerStatus: "pending", ledgerError: null });
  });

  it("queues the ledger posting when Accounting is on, and explains a switched-off rejection", async () => {
    const host = makeHost();
    await host.switchModules({ accounting: true, payroll: true });
    const runId = await lockedRun(host);
    const post = host.emitted.find((e) => e.name === "ledger.post.requested")!.payload as unknown as LedgerPostRequested;
    expect(host.outbox.get(post.key)!.status).toBe("pending");
    // Accounting was switched off after the run was queued: it answers "rejected".
    await runs.onLedgerResult(host.env, C, { key: post.key, status: "rejected", error: "Accounting is switched off for this company", source: post.source });
    const run = await fake.getRun(null, C, runId);
    expect(run).toMatchObject({ ledgerStatus: "rejected" });
    expect(run!.ledgerError).toBe("Accounting is switched off for this company. Turn Accounting on in Setup, then post it again.");
    expect(host.outbox.get(post.key)!.status).toBe("failed");
  });
});
