/**
 * End-to-end against a real (embedded) Postgres, through a ctx.db shim that
 * applies the host SQL guard and binds params the way the host does
 * (JSON over the wire, then drizzle + postgres-js). Skipped when the
 * repository's embedded-postgres package is not installed.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNT_ROLES, rememberPluginUiBase, type CockpitSnapshot, type LedgerPostRequested, type SetupItem } from "@partnersinbiz/pib-plugin-kit";
import { cockpitSnapshot, recordChainCheck, resetCockpitThrottle } from "../src/service/cockpit.js";
import { todayIso } from "../src/domain/util.js";
import * as db from "../src/db.js";
import { ZA_CHART } from "../src/domain/chart.js";
import { NAMESPACE } from "../src/namespace.js";
import { assetDetail, disposeAsset, runDepreciation, saveAsset } from "../src/service/assets.js";
import { acceptSuggestion, categorise, excludeLine, importStatement, refreshSuggestions, saveBankAccount, saveRule, undoLine } from "../src/service/bank.js";
import { ensureBook, loadChart, mapRole, roleGaps, setPeriod } from "../src/service/books.js";
import { closeChecklist } from "../src/service/close.js";
import { postCutover, previewCutover } from "../src/service/cutover.js";
import { revalueMonth } from "../src/service/fx.js";
import { approveDraft, onDraftIssue, postJournal, requestDraftApproval, saveDraft, verifyJournalChain } from "../src/service/journals.js";
import { receiveMail, receiveMatchResult, receiveOpenItem, receivePostRequest, retryRejection } from "../src/service/ledger.js";
import { buildPack } from "../src/service/pack.js";
import { setupStatus } from "../src/service/setup.js";
import { approveReconciliation, prepareReconciliation, requestReconciliationApproval } from "../src/service/reconcile.js";
import { runReport } from "../src/service/reports.js";
import { approveVatReturn, prepareVatReturn, requestVatApproval } from "../src/service/vat.js";
import * as guard from "./helpers/sql-guard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG = path.resolve(here, "../../../db/node_modules");
const available = existsSync(`${DB_PKG}/embedded-postgres/dist/index.js`) && existsSync(`${DB_PKG}/drizzle-orm/postgres-js/index.js`);

const CO = "co-1";
const BILLING = "partnersinbiz.billing";
const user = { kind: "user" as const, userId: "user-peet" };
const agent = { kind: "agent" as const, agentId: "agent-books", runId: "run-1", userId: null };
const fixture = (name: string) => readFileSync(path.join(here, "fixtures", name), "utf8");

type Issue = { id: string; identifier: string; status: string; title: string; description: string; assigneeAgentId: string | null; assigneeUserId: string | null; originKind: string; originId: string | null };

describe.skipIf(!available)("Accounting on real Postgres", () => {
  let pg: { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void>; createDatabase(n: string): Promise<void> };
  let client: { unsafe(q: string, p?: unknown[]): Promise<Array<Record<string, unknown>>>; end(): Promise<void> };
  let orm: { execute(q: unknown): Promise<unknown> };
  let sqlTag: { raw(s: string): unknown; join(chunks: unknown[], sep: unknown): unknown } & ((strings: TemplateStringsArray, ...values: unknown[]) => unknown);
  const dataDir = mkdtempSync(path.join(tmpdir(), "acct-pg-"));
  const issues = new Map<string, Issue>();
  const comments: Array<{ issueId: string; body: string }> = [];
  const emitted: Array<{ name: string; companyId: string; payload: Record<string, unknown> }> = [];
  const state = new Map<string, unknown>();
  const config: Record<string, unknown> = { legalName: "Partners in Biz (Pty) Ltd", vatNumber: "4123456789", vatCategory: "B", financialYearEndMonth: 2 };
  const configs = new Map<string, Record<string, unknown>>();
  let issueSeq = 0;
  let ctx: any;

  function bindSql(statement: string, params: readonly unknown[] = []) {
    if (params.length === 0) return sqlTag.raw(statement);
    const chunks: unknown[] = [];
    let cursor = 0;
    for (const match of statement.matchAll(/\$(\d+)/g)) {
      chunks.push(sqlTag.raw(statement.slice(cursor, match.index)));
      chunks.push(sqlTag`${params[Number(match[1]) - 1]}`);
      cursor = match.index! + match[0].length;
    }
    chunks.push(sqlTag.raw(statement.slice(cursor)));
    return sqlTag.join(chunks, sqlTag.raw(""));
  }

  function shimDb() {
    return {
      namespace: NAMESPACE,
      async query(text: string, params: unknown[] = []) {
        guard.validateRuntimeQuery(text, NAMESPACE, ["issues"]);
        guard.validateParams(text, params);
        const rows = await orm.execute(bindSql(text, JSON.parse(JSON.stringify(params))));
        return JSON.parse(JSON.stringify([...(rows as Iterable<unknown>)]));
      },
      async execute(text: string, params: unknown[] = []) {
        guard.validateRuntimeExecute(text, NAMESPACE);
        guard.validateParams(text, params);
        const result = await orm.execute(bindSql(text, JSON.parse(JSON.stringify(params))));
        return { rowCount: Number((result as { count?: number }).count ?? 0) };
      },
    };
  }

  beforeAll(async () => {
    const { default: EmbeddedPostgres } = await import(`${DB_PKG}/embedded-postgres/dist/index.js`);
    const { drizzle } = await import(`${DB_PKG}/drizzle-orm/postgres-js/index.js`);
    sqlTag = (await import(`${DB_PKG}/drizzle-orm/sql/sql.js`)).sql;
    const postgres = (await import(`${DB_PKG}/postgres/src/index.js`)).default;
    const port = 55_500 + Math.floor(Math.random() * 400);
    pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "t", password: "t", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("acct");
    client = postgres({ host: "127.0.0.1", port, user: "t", password: "t", database: "acct", onnotice: () => {} });
    orm = drizzle(client);
    await client.unsafe(`CREATE SCHEMA ${NAMESPACE}`);
    for (const statement of guard.splitSqlStatements(readFileSync(path.join(here, "../migrations/001_accounting.sql"), "utf8"))) {
      guard.validateMigrationStatement(statement, NAMESPACE);
      await client.unsafe(statement);
    }
    ctx = {
      db: shimDb(),
      config: { get: async (companyId?: string) => (companyId === CO ? config : configs.get(companyId ?? "") ?? {}) },
      secrets: { resolve: async () => undefined },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      state: { get: async (k: { stateKey: string }) => state.get(k.stateKey) ?? null, set: async (k: { stateKey: string }, v: unknown) => void state.set(k.stateKey, v) },
      events: { emit: async (name: string, companyId: string, payload: Record<string, unknown>) => void emitted.push({ name, companyId, payload }) },
      agents: { list: async () => [], get: async () => null },
      authorization: { grants: { list: async () => [], set: async () => [] } },
      skills: { managed: { reconcile: async () => ({}), reset: async () => ({}) } },
      issues: {
        create: async (input: Record<string, unknown>) => {
          issueSeq += 1;
          const issue: Issue = {
            id: `iss-${issueSeq}`,
            identifier: `PIB-${issueSeq}`,
            status: String(input.status ?? "backlog"),
            title: String(input.title),
            description: String(input.description ?? ""),
            assigneeAgentId: (input.assigneeAgentId as string) ?? null,
            assigneeUserId: (input.assigneeUserId as string) ?? null,
            originKind: String(input.originKind),
            originId: (input.originId as string) ?? null,
          };
          issues.set(issue.id, issue);
          return issue;
        },
        get: async (id: string) => issues.get(id) ?? null,
        update: async (id: string, patch: Partial<Issue>) => Object.assign(issues.get(id)!, patch),
        requestWakeup: async () => ({ queued: true }),
        createComment: async (issueId: string, body: string) => {
          comments.push({ issueId, body });
          return { id: `c-${comments.length}` };
        },
      },
    };
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await pg?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const q = (text: string, params: unknown[] = []) => client.unsafe(text, params);

  function invoiceRequest(key: string, date: string, over: Partial<LedgerPostRequested> = {}): LedgerPostRequested {
    return {
      key,
      source: { plugin: BILLING, kind: "invoice", id: key.split(":")[2] ?? key },
      date,
      memo: `Invoice ${key}`,
      currency: "ZAR",
      lines: [
        { role: "ar", debitMinor: 11_500_00, creditMinor: 0, clientKind: "company", clientRef: "crm-acme" },
        { role: "revenue", debitMinor: 0, creditMinor: 10_000_00, taxCode: "za_std_15" },
        { role: "vat_output", debitMinor: 0, creditMinor: 1_500_00, taxCode: "za_std_15", taxBaseMinor: 10_000_00 },
      ],
      ...over,
    };
  }

  const post = (req: LedgerPostRequested) => receivePostRequest(ctx, CO, `plugin.${BILLING}.ledger.post.requested`, req);

  it("sets up the book with the SA chart, every role and VAT codes", async () => {
    const book = await ensureBook(ctx, CO);
    expect(book.currency).toBe("ZAR");
    const chart = await loadChart(ctx, CO);
    expect(chart.accounts).toHaveLength(ZA_CHART.length);
    expect(roleGaps(chart)).toEqual([]);
    for (const role of ACCOUNT_ROLES) expect(chart.roles.has(role), role).toBe(true);
    expect((await db.listTaxRates(ctx.db, CO)).find((t) => t.code === "za_std_15")?.rateBps).toBe(1500);
    await ensureBook(ctx, CO); // idempotent
    expect((await loadChart(ctx, CO)).accounts).toHaveLength(ZA_CHART.length);
  });

  it("posts a Billing invoice once, re-sends the stored result on repeats", async () => {
    const r1 = await post(invoiceRequest("billing:invoice:inv1001:issue", "2026-09-02"));
    expect(r1).toMatchObject({ status: "posted", journalNumber: "JNL-000001" });
    const r2 = await post(invoiceRequest("billing:invoice:inv1001:issue", "2026-09-02"));
    expect(r2!.journalId).toBe(r1!.journalId);
    const results = emitted.filter((e) => e.name === "ledger.post.result");
    expect(results).toHaveLength(2);
    expect(results[1]!.payload).toMatchObject({ key: "billing:invoice:inv1001:issue", status: "posted" });
    const { journals } = await db.listJournals(ctx.db, CO);
    expect(journals).toHaveLength(1);
    expect(journals[0]!.lines.map((l) => l.accountCode)).toEqual(["1100", "4000", "2100"]);
    expect(journals[0]!.source.plugin).toBe(BILLING);
  });

  it("rejects bad postings with a clear error and keeps ONE issue for them", async () => {
    const unbalanced = invoiceRequest("billing:invoice:bad1:issue", "2026-09-03", {
      lines: [
        { role: "ar", debitMinor: 100, creditMinor: 0 },
        { role: "revenue", debitMinor: 0, creditMinor: 99 },
      ],
    });
    const r = await post(unbalanced);
    expect(r).toMatchObject({ status: "rejected" });
    expect(r!.error).toMatch(/does not balance/);
    const unknownRole = invoiceRequest("billing:invoice:bad2:issue", "2026-09-03", {
      lines: [
        { role: "ar", debitMinor: 100, creditMinor: 0 },
        { role: "revenue:weird" as never, debitMinor: 0, creditMinor: 100 },
      ],
    });
    await db.deleteRole(ctx.db, CO, "revenue");
    const r2 = await post(unknownRole);
    expect(r2!.error).toMatch(/No account is mapped to role revenue:weird/);
    const rejectionIssues = [...issues.values()].filter((i) => i.originId === "rejections");
    expect(rejectionIssues).toHaveLength(1);
    expect(comments.some((c) => c.issueId === rejectionIssues[0]!.id && c.body.includes("bad2"))).toBe(true);
    // Fix the cause and retry: posts, and once nothing is left the issue closes.
    await mapRole(ctx, CO, "revenue", "4000");
    const retried = await retryRejection(ctx, CO, "billing:invoice:bad2:issue");
    expect(retried.status).toBe("posted");
    await q(`UPDATE ${NAMESPACE}.posting_rejections SET status = 'dismissed' WHERE key = 'billing:invoice:bad1:issue'`);
    await retryRejection(ctx, CO, "billing:invoice:bad2:issue"); // repeat: already posted
    const { closeRejectionIssueWhenClear } = await import("../src/service/ledger.js");
    await closeRejectionIssueWhenClear(ctx, CO);
    expect(issues.get(rejectionIssues[0]!.id)!.status).toBe("done");
  });

  it("refuses closed periods; soft-closed only takes approved manual journals", async () => {
    await setPeriod(ctx, CO, "2026-05", "closed", user);
    const closed = await post(invoiceRequest("billing:invoice:may:issue", "2026-05-10"));
    expect(closed!.error).toMatch(/2026-05 is closed/);
    await setPeriod(ctx, CO, "2025-12", "soft_closed", user);
    const soft = await post(invoiceRequest("billing:invoice:dec:issue", "2025-12-10"));
    expect(soft!.error).toMatch(/soft-closed/);
    // Manual journal by an agent: draft → approval issue → a person approves.
    const draft = await saveDraft(ctx, CO, { date: "2025-12-15", memo: "Accrue audit fee", lines: [{ accountCode: "6100", debitMinor: 5_000_00 }, { accountCode: "2300", creditMinor: 5_000_00 }] }, agent);
    const pending = await requestDraftApproval(ctx, CO, draft.id, agent);
    expect(pending.status).toBe("pending_approval");
    const approvalIssue = issues.get(pending.approvalIssueId!)!;
    expect(approvalIssue.title).toMatch(/Approve journal/);
    await expect(approveDraft(ctx, CO, draft.id, agent)).rejects.toThrow(/board user/);
    approvalIssue.status = "done";
    await onDraftIssue(ctx, CO, pending, "done", { type: "agent", id: "agent-books" });
    expect((await db.getDraft(ctx.db, CO, draft.id))!.status).toBe("pending_approval");
    const { journal } = await approveDraft(ctx, CO, draft.id, user);
    expect(journal!.kind).toBe("manual");
    expect((await db.getDraft(ctx.db, CO, draft.id))!.status).toBe("posted");
  });

  it("reverses by reverseKey and keeps the hash chain verifiable", async () => {
    await post(invoiceRequest("billing:invoice:inv1002:issue", "2026-09-04"));
    const r = await post({ ...invoiceRequest("billing:invoice:inv1002:void", "2026-09-05"), reverseKey: "billing:invoice:inv1002:issue", lines: [] });
    expect(r!.status).toBe("posted");
    const original = await db.journalBySourceKey(ctx.db, CO, "billing:invoice:inv1002:issue");
    expect(original!.status).toBe("reversed");
    const reversal = await db.journalById(ctx.db, CO, r!.journalId!);
    expect(reversal!.reversesId).toBe(original!.id);
    expect(reversal!.lines[0]).toMatchObject({ accountCode: "1100", creditMinor: 11_500_00 });
    expect(await verifyJournalChain(ctx, CO)).toMatchObject({ ok: true });
  });

  it("numbers concurrent postings without gaps or clashes", async () => {
    const reqs = Array.from({ length: 8 }, (_, i) => invoiceRequest(`billing:invoice:c${i}:issue`, "2026-09-06"));
    const results = await Promise.all(reqs.map((r) => post(r)));
    expect(results.every((r) => r!.status === "posted")).toBe(true);
    const numbers = new Set(results.map((r) => r!.journalNumber));
    expect(numbers.size).toBe(8);
    const chain = await verifyJournalChain(ctx, CO);
    expect(chain.ok).toBe(true);
    const seqs = await q(`SELECT seq FROM ${NAMESPACE}.journals WHERE company_id = $1 ORDER BY seq`, [CO]);
    expect(seqs.map((s) => Number(s.seq))).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  });

  it("detects tampering", async () => {
    const [row] = await q(`SELECT id, memo FROM ${NAMESPACE}.journals WHERE company_id = $1 AND seq = 2`, [CO]);
    await q(`UPDATE ${NAMESPACE}.journals SET memo = 'edited' WHERE id = $1`, [row!.id]);
    const bad = await verifyJournalChain(ctx, CO);
    expect(bad).toMatchObject({ ok: false, firstBadSeq: 2 });
    await q(`UPDATE ${NAMESPACE}.journals SET memo = $2 WHERE id = $1`, [row!.id, row!.memo]);
    expect((await verifyJournalChain(ctx, CO)).ok).toBe(true);
  });

  it("keeps the open-item projection with last updatedAt winning", async () => {
    const item = { key: "invoice:inv1001", kind: "receivable", id: "inv1001", number: "INV-1001", counterpartyName: "Acme (Pty) Ltd", currency: "ZAR", totalMinor: 11_500_00, outstandingMinor: 11_500_00, issueDate: "2026-09-02", dueDate: "2026-09-16", references: ["ACME01"], status: "sent", updatedAt: "2026-09-02T10:00:00Z" };
    expect(await receiveOpenItem(ctx, CO, BILLING, item)).toBe(true);
    expect(await receiveOpenItem(ctx, CO, BILLING, { ...item, outstandingMinor: 0, updatedAt: "2026-09-01T10:00:00Z" })).toBe(false);
    expect((await db.getOpenItem(ctx.db, CO, "invoice:inv1001"))!.outstandingMinor).toBe(11_500_00);
    await receiveOpenItem(ctx, CO, BILLING, { key: "invoice:old", kind: "receivable", id: "old", number: "INV-0900", counterpartyName: "Beta", currency: "ZAR", totalMinor: 500_00, outstandingMinor: 500_00, issueDate: "2026-06-01", dueDate: "2026-06-15", references: [], status: "overdue", updatedAt: "2026-06-01T00:00:00Z" });
    const aged = await runReport(ctx, CO, "aged_receivables", { asOf: "2026-09-26" });
    expect((aged as { totals: Record<string, number> }).totals).toMatchObject({ "1_30": 11_500_00, over_90: 500_00 });
  });

  let bankId = "";
  it("imports statements, dedupes, suggests, matches and categorises", async () => {
    const bank = await saveBankAccount(ctx, CO, { name: "FNB Business", bankName: "FNB", numberLast4: "1234" });
    bankId = bank.id;
    expect(bank.accountCode).toBe("1000");
    await saveRule(ctx, CO, { name: "Bank fees", field: "description", operator: "contains", value: "account fee", accountCode: "6120", direction: "out" });
    const first = await importStatement(ctx, CO, user, { bankAccountId: bank.id, content: fixture("fnb.csv"), fileName: "sep.csv" });
    expect(first).toMatchObject({ added: 5, duplicates: 0, openingMinor: 10_000_00, closingMinor: 20_100_00 });
    expect((await importStatement(ctx, CO, user, { bankAccountId: bank.id, content: fixture("fnb.csv") })).duplicateFile).toBe(true);
    const overlap = fixture("fnb.csv").split("\n").filter((l, i) => i !== 3).join("\n");
    expect((await importStatement(ctx, CO, user, { bankAccountId: bank.id, content: overlap })).added).toBe(0);

    const lines = await db.listBankLines(ctx.db, CO, { bankAccountId: bank.id });
    const receipt = lines.find((l) => l.amountMinor === 11_500_00)!;
    expect(receipt.suggestions[0]).toMatchObject({ kind: "open_item", key: "invoice:inv1001", basis: "exact" });
    const fee = lines.find((l) => l.amountMinor === -150_00)!;
    expect(fee.suggestions[0]).toMatchObject({ kind: "category", source: "rule", accountCode: "6120" });

    // Agents may not accept unless the setting allows.
    await expect(acceptSuggestion(ctx, CO, agent, { lineId: fee.id })).rejects.toThrow(/board user/);
    await acceptSuggestion(ctx, CO, user, { lineId: fee.id });
    expect((await db.getBankLine(ctx.db, CO, fee.id))!.status).toBe("reconciled");

    // Invoice match → bank.matched to Billing (outbox) → result → payment journal with bankTxId → reconciled.
    await acceptSuggestion(ctx, CO, user, { lineId: receipt.id });
    expect((await db.getBankLine(ctx.db, CO, receipt.id))!.status).toBe("matching");
    const matched = emitted.find((e) => e.name === "bank.matched")!;
    expect(matched.payload).toMatchObject({ key: `bank:${receipt.id}:invoice:inv1001`, bankTxId: receipt.id, bankAccountCode: "1000", openItemKey: "invoice:inv1001", amountMinor: 11_500_00, basis: "exact", kind: "receivable" });
    await receiveMatchResult(ctx, CO, { key: matched.payload.key, status: "settled", paymentId: "pay1" });
    expect((await db.getBankLine(ctx.db, CO, receipt.id))!.note).toMatch(/waiting for its journal/);
    const payment = await post({
      key: "billing:payment:pay1",
      source: { plugin: BILLING, kind: "payment", id: "pay1" },
      date: "2026-09-02",
      memo: "Payment INV-1001",
      currency: "ZAR",
      lines: [
        { accountCode: "1000", debitMinor: 11_500_00, creditMinor: 0, dimensions: { bankTxId: receipt.id } },
        { role: "ar", debitMinor: 0, creditMinor: 11_500_00, dimensions: { bankTxId: receipt.id } },
      ],
    });
    const reconciled = (await db.getBankLine(ctx.db, CO, receipt.id))!;
    expect(reconciled).toMatchObject({ status: "reconciled", journalId: payment!.journalId });

    // Categorise with VAT split.
    const google = lines.find((l) => l.amountMinor === -1_150_00)!;
    await categorise(ctx, CO, user, { lineId: google.id, accountCode: "6130", taxCode: "za_std_15" });
    const gj = await db.journalById(ctx.db, CO, (await db.getBankLine(ctx.db, CO, google.id))!.journalId!);
    expect(gj!.lines.map((l) => [l.accountCode, l.debitMinor, l.creditMinor])).toEqual([["6130", 1_000_00, 0], ["1400", 150_00, 0], ["1000", 0, 1_150_00]]);

    // Undo reverses the category journal; categorise again posts a new one.
    await undoLine(ctx, CO, user, { lineId: google.id });
    expect((await db.getBankLine(ctx.db, CO, google.id))!.status).toBe("unreconciled");
    expect((await db.journalById(ctx.db, CO, gj!.id))!.status).toBe("reversed");
    await categorise(ctx, CO, user, { lineId: google.id, accountCode: "6130", taxCode: "za_std_15" });

    const coffees = lines.filter((l) => l.amountMinor === -50_00);
    expect(coffees).toHaveLength(2);
    await excludeLine(ctx, CO, user, { lineId: coffees[0]!.id, note: "Duplicate line on the statement" });
    await categorise(ctx, CO, user, { lineId: coffees[1]!.id, accountCode: "6160" });
    const r = await refreshSuggestions(ctx, CO, { bankAccountId: bank.id });
    expect(r.lines).toBe(0);
  });

  it("reconciles the statement period to a zero difference, then locks it", async () => {
    const wrong = await prepareReconciliation(ctx, CO, user, { bankAccountId: bankId, periodStart: "2026-09-01", periodEnd: "2026-09-03", openingMinor: 10_000_00, closingMinor: 20_000_00 });
    expect(wrong.summary.differenceMinor).toBe(-100_00);
    expect(wrong.summary.ready).toBe(false);
    const prepared = await prepareReconciliation(ctx, CO, user, { bankAccountId: bankId, periodStart: "2026-09-01", periodEnd: "2026-09-03" });
    expect(prepared.summary).toMatchObject({ openingMinor: 10_000_00, closingMinor: 20_100_00, differenceMinor: 0, unreconciledCount: 0, ready: true });
    const pending = await requestReconciliationApproval(ctx, CO, agent, prepared.reconciliation.id);
    expect(pending.status).toBe("pending_approval");
    await expect(approveReconciliation(ctx, CO, agent, pending.id)).rejects.toThrow(/board user/);
    const locked = await approveReconciliation(ctx, CO, user, pending.id);
    expect(locked.status).toBe("locked");
    const line = (await db.listBankLines(ctx.db, CO, { bankAccountId: bankId, statuses: ["reconciled"] }))[0]!;
    expect(line.reconciliationId).toBe(locked.id);
    await expect(undoLine(ctx, CO, user, { lineId: line.id })).rejects.toThrow(/locked reconciliation/);
  });

  it("depreciates monthly once, then disposes with a profit or loss", async () => {
    const asset = await saveAsset(ctx, CO, { name: "MacBook", costMinor: 36_000_00, lifeMonths: 36, acquiredDate: "2026-01-05", depreciationStart: "2026-01-01", assetAccountCode: "1510" });
    const run1 = await runDepreciation(ctx, CO, user, "2026-03");
    expect(run1.posted).toHaveLength(3);
    expect((await runDepreciation(ctx, CO, user, "2026-03")).posted).toHaveLength(0);
    const detail = await assetDetail(ctx, CO, asset.id);
    expect(detail.schedule.filter((s) => s.posted).map((s) => s.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    const disposal = await disposeAsset(ctx, CO, user, { assetId: asset.id, date: "2026-04-15", proceedsMinor: 30_000_00 });
    expect(disposal.accumulatedMinor).toBe(3_000_00);
    expect(disposal.gainMinor).toBe(-3_000_00);
    expect((await db.getAsset(ctx.db, CO, asset.id))!.status).toBe("disposed");
  });

  it("revalues open USD items at the month end and reverses next month", async () => {
    await post({
      key: "billing:invoice:usd1:issue",
      source: { plugin: BILLING, kind: "invoice", id: "usd1" },
      date: "2026-06-10",
      memo: "USD invoice",
      currency: "USD",
      fxRate: 17.5,
      lines: [
        { role: "ar", debitMinor: 1_000_00, creditMinor: 0 },
        { role: "revenue", debitMinor: 0, creditMinor: 1_000_00, taxCode: "za_export_zero" },
      ],
    });
    await receiveOpenItem(ctx, CO, BILLING, { key: "invoice:usd1", kind: "receivable", id: "usd1", number: "INV-USD1", counterpartyName: "US Co", currency: "USD", totalMinor: 1_000_00, outstandingMinor: 1_000_00, issueDate: "2026-06-10", dueDate: "2026-07-10", references: [], status: "sent", updatedAt: "2026-06-10T00:00:00Z" });
    await db.saveFxRates(ctx.db, "ZAR", "2026-06-30", new Map([["USD", 18]]), "test");
    const r = await revalueMonth(ctx, CO, user, "2026-06");
    expect(r.journal).toBeTruthy();
    expect(r.items[0]).toMatchObject({ bookedRate: 17.5, closingRate: 18, differenceMinor: 500_00 });
    expect(r.reversal!.date).toBe("2026-07-01");
    expect((await revalueMonth(ctx, CO, user, "2026-06")).already).toBe(true);
  });

  it("builds the VAT201 from journal lines, locks the period and refuses later postings in it", async () => {
    await post(invoiceRequest("billing:invoice:jul1:issue", "2026-07-15"));
    await post({
      key: "billing:bill:b1:issue",
      source: { plugin: BILLING, kind: "bill", id: "b1" },
      date: "2026-08-03",
      memo: "Software bill",
      currency: "ZAR",
      lines: [
        { role: "expense:software", debitMinor: 2_000_00, creditMinor: 0, taxCode: "za_std_15" },
        { role: "vat_input", debitMinor: 300_00, creditMinor: 0, taxCode: "za_std_15", taxBaseMinor: 2_000_00 },
        { role: "ap", debitMinor: 0, creditMinor: 2_300_00 },
      ],
    });
    const { vatReturn, warnings } = await prepareVatReturn(ctx, CO, agent, { periodStart: "2026-07-01", periodEnd: "2026-08-31" });
    expect(warnings).toEqual([]);
    expect(vatReturn.boxes).toMatchObject({ f1: 11_500_00, f4: 1_500_00, f2A: 0, f15: 300_00, f13: 1_500_00, f19: 300_00, f20: 1_200_00 });
    const pending = await requestVatApproval(ctx, CO, agent, vatReturn.id);
    expect(issues.get(pending.approvalIssueId!)!.title).toMatch(/Approve VAT201/);
    const locked = await approveVatReturn(ctx, CO, user, pending.id);
    expect(locked.status).toBe("locked");
    const late = await post(invoiceRequest("billing:invoice:late:issue", "2026-08-20"));
    expect(late).toMatchObject({ status: "rejected" });
    expect(late!.error).toMatch(/VAT period 2026-07-01 to 2026-08-31 is locked/);
    // The June export revenue sits in the May–June return.
    const mayJune = await prepareVatReturn(ctx, CO, user, { periodStart: "2026-05-01", periodEnd: "2026-06-30" });
    expect(mayJune.vatReturn.boxes.f2A).toBe(17_500_00);
  });

  it("reports balance: trial balance, balance sheet, cash flow", async () => {
    const tb = (await runReport(ctx, CO, "trial_balance", { asOf: "2026-09-30" })) as { balanced: boolean };
    expect(tb.balanced).toBe(true);
    const bs = (await runReport(ctx, CO, "balance_sheet", { asOf: "2026-09-30" })) as { balanced: boolean; totalAssetsMinor: number; totalLiabilitiesMinor: number; totalEquityMinor: number };
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssetsMinor).toBe(bs.totalLiabilitiesMinor + bs.totalEquityMinor);
    const cf = (await runReport(ctx, CO, "cash_flow", { from: "2026-03-01", to: "2026-09-30" })) as { reconciles: boolean; closingCashMinor: number };
    expect(cf.reconciles).toBe(true);
    const gl = (await runReport(ctx, CO, "general_ledger", { accountCode: "1000", from: "2026-09-01", to: "2026-09-30" })) as { closingMinor: number };
    expect(gl.closingMinor).toBe(cf.closingCashMinor);
    const pnl = (await runReport(ctx, CO, "profit_and_loss", { from: "2026-09-01", to: "2026-09-30" })) as { netProfitMinor: number };
    expect(typeof pnl.netProfitMinor).toBe("number");
    const cmp = (await runReport(ctx, CO, "comparison", { month: "2026-09" })) as { netProfit: number[] };
    expect(cmp.netProfit).toHaveLength(3);
  });

  it("posts opening balances once at cut-over and checks they balance", async () => {
    const csv = "code,name,debit,credit\n1000,Bank,50000.00,\n3100,Retained earnings,,50000.00\n";
    const preview = await previewCutover(ctx, CO, { csv });
    expect(preview).toMatchObject({ balanced: true, unknownCodes: [] });
    await expect(postCutover(ctx, CO, user, { csv: "code,balance\n1000,100\n", date: "2025-02-28" })).rejects.toThrow(/does not balance/);
    const { journal } = await postCutover(ctx, CO, user, { csv, date: "2025-02-28" });
    expect(journal.kind).toBe("opening");
    expect((await db.getBook(ctx.db, CO))!.openingJournalId).toBe(journal.id);
    await expect(postCutover(ctx, CO, user, { csv, date: "2025-02-28" })).rejects.toThrow(/already posted/);
  });

  it("builds the accountant pack and the close checklist", async () => {
    const pack = await buildPack(ctx, CO, user, { from: "2026-03-01", to: "2026-09-30" });
    expect(pack.url).toBeNull();
    const bytes = Buffer.from(pack.data!, "base64");
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(bytes.toString("latin1")).toContain("trial-balance.csv");
    expect(pack.audit.hashChain.ok).toBe(true);
    const check = await closeChecklist(ctx, CO, "2026-09");
    const byKey = Object.fromEntries(check.items.map((i) => [i.key, i.ok]));
    expect(byKey.trial_balance).toBe(true);
    expect(byKey.audit_chain).toBe(true);
    expect(byKey.bank_lines).toBe(true);
  });

  it("opens one issue per bank-statement email", async () => {
    const mail = { key: "gmail:m1", messageId: "m1", threadId: "t1", accountAddress: "peet@partnersinbiz.online", from: { email: "statements@fnb.co.za", name: "FNB" }, to: [], subject: "Your September statement", snippet: "", receivedAt: "2026-10-01T06:00:00Z", attachments: [{ attachmentId: "a1", filename: "sep.csv", mime: "text/csv", bytes: 2048 }], triage: { category: "bank_statement", urgency: null, needsReply: null, phishing: null, confidence: 0.9 } };
    expect(await receiveMail(ctx, CO, "plugin.partnersinbiz.mailbox.mail.received", mail)).toBe(true);
    expect(await receiveMail(ctx, CO, "plugin.partnersinbiz.mailbox.mail.received", mail)).toBe(false);
    expect(await receiveMail(ctx, CO, "plugin.partnersinbiz.mailbox.mail.received", { ...mail, key: "gmail:m2", triage: { ...mail.triage, category: "newsletter" } })).toBe(false);
    expect([...issues.values()].filter((i) => i.title.startsWith("Bank statement received"))).toHaveLength(1);
  });

  it("posts a Payroll run with every payroll role, then reverses it by reverseKey", async () => {
    const PAYROLL = "partnersinbiz.payroll";
    const run: LedgerPostRequested = {
      key: "payroll:run:r1",
      source: { plugin: PAYROLL, kind: "pay_run", id: "r1" },
      date: "2026-09-25",
      memo: "September 2026 pay run",
      currency: "ZAR",
      lines: [
        { role: "salaries", debitMinor: 50_000_00, creditMinor: 0, dimensions: { employeeId: "e1" } },
        { role: "employer_contributions", debitMinor: 1_000_00, creditMinor: 0 },
        { role: "paye_payable", debitMinor: 0, creditMinor: 9_000_00 },
        { role: "uif_payable", debitMinor: 0, creditMinor: 708_48 },
        { role: "sdl_payable", debitMinor: 0, creditMinor: 500_00 },
        { role: "deductions_payable", debitMinor: 0, creditMinor: 1_000_00 },
        { role: "net_pay_clearing", debitMinor: 0, creditMinor: 39_791_52 },
        { role: "paye_payable", debitMinor: 1_000_00, creditMinor: 0, memo: "ETI utilised" },
        { role: "revenue:employment_tax_incentive", debitMinor: 0, creditMinor: 1_000_00 },
      ],
    };
    const posted = await receivePostRequest(ctx, CO, `plugin.${PAYROLL}.ledger.post.requested`, run);
    expect(posted).toMatchObject({ status: "posted" });
    const journal = await db.journalById(ctx.db, CO, posted!.journalId!);
    expect(journal!.source.plugin).toBe(PAYROLL);
    expect(journal!.lines.map((l) => l.accountCode)).toEqual(["6000", "6010", "2200", "2210", "2220", "2240", "2230", "2200", "4300"]);
    const reversal = await receivePostRequest(ctx, CO, `plugin.${PAYROLL}.ledger.post.requested`, { ...run, key: "payroll:run:r1:reverse", date: "2026-09-26", memo: "Reverse September run", lines: [], reverseKey: "payroll:run:r1" });
    expect(reversal).toMatchObject({ status: "posted" });
    expect((await db.journalById(ctx.db, CO, journal!.id))!.status).toBe("reversed");
    expect(emitted.filter((e) => e.name === "ledger.post.result" && (e.payload.source as { plugin?: string })?.plugin === PAYROLL)).toHaveLength(2);
  });

  it("direct postJournal is idempotent by source key", async () => {
    const input = { sourceKey: "test:idem", source: { plugin: "t", kind: "t", id: "1" }, kind: "manual" as const, date: "2026-09-10", memo: "x", lines: [{ accountCode: "1000", debitMinor: 1, creditMinor: 0 }, { accountCode: "1990", debitMinor: 0, creditMinor: 1 }], postedBy: user };
    const a = await postJournal(ctx, CO, input);
    const b = await postJournal(ctx, CO, input);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.journal.id).toBe(a.journal.id);
  });
  it("worker: every action, tool, event and job runs under the manifest's capabilities", async () => {
    const { createTestHarness } = await import("@paperclipai/plugin-sdk/testing");
    const manifest = (await import("../src/manifest.js")).default;
    const plugin = (await import("../src/worker.js")).default;
    const { ACCOUNTING_TOOLS } = await import("../src/tools.js");
    const W = "co-w";
    const harness = createTestHarness({ manifest, config: { legalName: "PiB", vatNumber: "4000000000", vatCategory: "B", financialYearEndMonth: 2 } });
    harness.seed({ companies: [{ id: W, issuePrefix: "PIB", name: "PiB" } as never] });
    (harness.ctx as unknown as { db: unknown }).db = shimDb();
    await plugin.definition.setup(harness.ctx);
    const results: Array<Record<string, unknown>> = [];
    harness.ctx.events.on("plugin.partnersinbiz.accounting.ledger.post.result", async (e) => void results.push(e.payload as Record<string, unknown>));
    const asUser = { companyId: W, actor: { type: "user" as const, userId: "u-1" } };
    const load = await harness.performAction<{ settings: { saved: boolean }; roleGaps: string[]; book: { companyId: string } }>("accounting.load", {}, asUser);
    expect(load.settings.saved).toBe(true);
    expect(load.roleGaps).toEqual([]);

    await harness.emit(`plugin.${BILLING}.ledger.post.requested`, invoiceRequest("billing:invoice:w1:issue", "2026-09-20"), { companyId: W });
    expect(results.at(-1)).toMatchObject({ key: "billing:invoice:w1:issue", status: "posted", journalNumber: "JNL-000001" });
    await harness.emit(`plugin.${BILLING}.open-item.upserted`, { key: "invoice:w1", kind: "receivable", id: "w1", number: "INV-W1", counterpartyName: "Acme", currency: "ZAR", totalMinor: 11_500_00, outstandingMinor: 11_500_00, issueDate: "2026-09-20", dueDate: "2026-10-20", references: [], status: "sent", updatedAt: "2026-09-20T00:00:00Z" }, { companyId: W });

    const reads: Array<[string, Record<string, unknown>]> = [
      ["accounting.chart", {}],
      ["accounting.journals", { search: "invoice" }],
      ["accounting.periods", {}],
      ["accounting.drafts", {}],
      ["accounting.rejections", {}],
      ["accounting.bank", {}],
      ["accounting.bank-lines", {}],
      ["accounting.vat", {}],
      ["accounting.assets", {}],
      ["accounting.fx", {}],
      ["accounting.budgets", {}],
      ["accounting.forecast", { months: 3 }],
      ["accounting.decisions", {}],
      ["accounting.verify-chain", {}],
      ["accounting.close-checklist", { month: "2026-09" }],
      ["accounting.hire-options", {}],
      ...["trial_balance", "profit_and_loss", "balance_sheet", "cash_flow", "comparison", "budget_vs_actual", "forecast", "aged_receivables", "aged_payables"].map((kind) => ["accounting.report", { kind }] as [string, Record<string, unknown>]),
      ["accounting.report", { kind: "general_ledger", accountCode: "1100" }],
    ];
    for (const [key, params] of reads) await expect(harness.performAction(key, params, asUser), key).resolves.toBeDefined();
    const journals = await harness.performAction<{ total: number }>("accounting.journals", {}, asUser);
    expect(journals.total).toBe(1);

    // Writes through actions.
    const bank = await harness.performAction<{ id: string }>("accounting.save-bank-account", { name: "Main" }, asUser);
    const imported = await harness.performAction<{ added: number }>("accounting.import-statement", { bankAccountId: bank.id, content: fixture("statement.ofx"), fileName: "sep.ofx" }, asUser);
    expect(imported.added).toBe(2);
    await harness.performAction("accounting.save-budgets", { budgets: [{ accountCode: "4000", month: "2026-09", amountMinor: 10_000_00 }] }, asUser);
    await harness.performAction("accounting.save-forecast-line", { month: "2026-10", description: "Tax", amountMinor: -5_000_00 }, asUser);
    const csv = await harness.performAction<{ csv: string }>("accounting.vat-csv", { returnId: (await harness.performAction<{ vatReturn: { id: string } }>("accounting.prepare-vat", { periodStart: "2026-09-01", periodEnd: "2026-10-31" }, asUser)).vatReturn.id }, asUser);
    expect(csv.csv).toContain("Output tax on field 1");
    await expect(harness.performAction("accounting.set-period", { period: "2026-01", status: "closed" }, { companyId: W, actor: { type: "agent", agentId: "a-1" } })).rejects.toThrow(/board user/);

    // Tools, as an agent.
    const run = { companyId: W, agentId: "a-1", runId: "r-1", projectId: "p-1" };
    const toolParams: Record<string, unknown> = {
      "accept-categorisation": { lineId: "missing" },
      gl: { accountCode: "1100" },
      "create-manual-journal": { date: "2026-09-21", memo: "Accrual", lines: [{ accountCode: "6100", debitMinor: 1_000_00 }, { accountCode: "2300", creditMinor: 1_000_00 }] },
    };
    for (const tool of ACCOUNTING_TOOLS) {
      const result = await harness.executeTool<{ error?: string; data?: unknown }>(tool.name, toolParams[tool.name] ?? {}, run);
      if (tool.name === "accept-categorisation") expect(result.error).toMatch(/not found/);
      else expect(result.error, tool.name).toBeUndefined();
    }
    const tb = await harness.executeTool<{ data: { balanced: boolean } }>("trial-balance", {}, run);
    expect(tb.data.balanced).toBe(true);

    // The approval issue for the agent's journal: a person marks it done.
    const draft = (await harness.performAction<{ drafts: Array<{ id: string; approvalIssueId: string; status: string }> }>("accounting.drafts", {}, asUser)).drafts[0]!;
    expect(draft.status).toBe("pending_approval");
    await harness.ctx.issues.update(draft.approvalIssueId, { status: "done" }, W);
    await harness.emit("issue.updated", {}, { companyId: W, entityId: draft.approvalIssueId, actorType: "user", actorId: "u-1" });
    expect((await harness.performAction<{ total: number }>("accounting.journals", { kind: "manual" }, asUser)).total).toBe(1);

    await harness.emit("plugin.partnersinbiz.mailbox.mail.received", { key: "m-w", messageId: "m-w", threadId: "t", from: { email: "x@bank.co.za" }, to: [], subject: "Statement", snippet: "", receivedAt: "2026-10-01T00:00:00Z", attachments: [], triage: { category: "bank_statement" } }, { companyId: W });

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ base: "ZAR", date: "2026-09-25", rates: { USD: 0.055, EUR: 0.05 } }), { status: 200 })) as typeof fetch;
    try {
      await harness.runJob("fx-rates");
    } finally {
      globalThis.fetch = realFetch;
    }
    await harness.runJob("redeliver");
    await harness.runJob("month-end");
    expect(harness.logs.filter((l) => l.level === "error")).toEqual([]);
    expect(harness.logs.filter((l) => l.level === "warn" && /failed/.test(l.message))).toEqual([]);
  });

  const byKey = (items: SetupItem[]) => Object.fromEntries(items.map((i) => [i.key, i]));

  it("setup status: nothing configured yet", async () => {
    const S = "co-setup";
    const status = await setupStatus(ctx, S);
    expect(status).toMatchObject({ plugin: "partnersinbiz.accounting", module: "accounting", title: "Accounting", version: "0.1.2" });
    expect(Date.parse(status.checkedAt)).not.toBeNaN();
    const items = byKey(status.items);
    expect(status.items[0]!.key).toBe("settings");
    expect(items.settings).toMatchObject({ status: "missing", required: true, href: "/company/settings/instance/plugins" });
    for (const key of ["company_details", "chart", "roles", "bank_account", "opening_balances"]) expect(items[key], key).toMatchObject({ status: "missing", required: true });
    for (const key of ["first_statement", "bookkeeper", "private_storage", "accountant_review"]) expect(items[key], key).toMatchObject({ status: "optional", required: false });
    expect(items.chart!.action).toEqual({ plugin: "partnersinbiz.accounting", key: "accounting.chart", label: "Set up the chart" });
    expect(items.bank_account!.href).toBe("/accounting?tab=bank");
    expect(items.opening_balances).toMatchObject({ href: "/accounting?tab=cutover", blockedBy: ["chart", "roles"] });
    expect(items.opening_balances!.steps!.length).toBeGreaterThan(0);
    // A probe never writes: no book was created for the company.
    expect(await db.getBook(ctx.db, S)).toBeNull();
  });

  it("setup status: everything configured", async () => {
    const S = "co-setup";
    configs.set(S, {
      legalName: "Setup Co (Pty) Ltd",
      vatNumber: "4999999999",
      vatCategory: "C",
      financialYearEndMonth: 2,
      r2: { accountId: "acc", bucket: "books-private", accessKeyId: "AK", secretAccessKey: "secret-ref-1" },
    });
    await ensureBook(ctx, S);
    const bank = await saveBankAccount(ctx, S, { name: "Main" });
    await importStatement(ctx, S, user, { bankAccountId: bank.id, content: fixture("statement.ofx"), fileName: "sep.ofx" });
    await postCutover(ctx, S, user, { csv: "code,name,debit,credit\n1000,Bank,1000.00,\n3100,Retained earnings,,1000.00\n", date: "2025-02-28" });
    await rememberPluginUiBase(ctx, "/_plugins/0f3c1d2e-aaaa-4bbb-8ccc-123456789abc/ui/");
    const items = byKey((await setupStatus(ctx, S)).items);
    for (const key of ["settings", "company_details", "chart", "roles", "bank_account", "opening_balances", "first_statement", "private_storage"]) expect(items[key]!.status, key).toBe("done");
    expect(items.settings!.href).toBe("/company/settings/instance/plugins/0f3c1d2e-aaaa-4bbb-8ccc-123456789abc");
    expect(items.company_details!.href).toBe(items.settings!.href);
    expect(items.bookkeeper!.status).toBe("optional");
    expect(items.accountant_review!.status).toBe("optional");
  });

  it("setup status: partial settings and a failing check", async () => {
    const S = "co-setup-2";
    configs.set(S, { vatCategory: "B" });
    await ensureBook(ctx, S);
    const items = byKey((await setupStatus(ctx, S)).items);
    expect(items.settings!.status).toBe("done");
    expect(items.company_details).toMatchObject({ status: "missing" });
    expect(items.company_details!.detail).toMatch(/legal name, VAT number/);
    expect(items.chart!.status).toBe("done");
    expect(items.bank_account!.status).toBe("missing");
    expect(items.opening_balances!.status).toBe("missing");
    expect(items.private_storage!.status).toBe("optional");

    const broken = { ...ctx, db: { ...ctx.db, query: async (text: string, params?: unknown[]) => (text.includes(".bank_accounts") ? Promise.reject(new Error("boom")) : ctx.db.query(text, params)) } };
    const status = await setupStatus(broken, S);
    expect(byKey(status.items).bank_account!.status).toBe("unknown");
    expect(byKey(status.items).chart!.status).toBe("done");
  });

  it("module switched off: refuses postings, skips jobs; back on: posts the same key", async () => {
    const { createTestHarness } = await import("@paperclipai/plugin-sdk/testing");
    const manifest = (await import("../src/manifest.js")).default;
    const plugin = (await import("../src/worker.js")).default;
    const M = "co-m";
    const harness = createTestHarness({ manifest, config: { legalName: "PiB", vatNumber: "4000000000", vatCategory: "B", financialYearEndMonth: 2 } });
    harness.seed({ companies: [{ id: M, issuePrefix: "PIM", name: "PiM" } as never] });
    (harness.ctx as unknown as { db: unknown }).db = shimDb();
    await plugin.definition.setup(harness.ctx);
    const results: Array<Record<string, unknown>> = [];
    const statuses: Array<{ companyId: string; payload: Record<string, unknown> }> = [];
    harness.ctx.events.on("plugin.partnersinbiz.accounting.ledger.post.result", async (e) => void results.push(e.payload as Record<string, unknown>));
    harness.ctx.events.on("plugin.partnersinbiz.accounting.setup.status", async (e) => void statuses.push({ companyId: e.companyId, payload: e.payload as Record<string, unknown> }));
    await harness.performAction("accounting.load", {}, { companyId: M, actor: { type: "user" as const, userId: "u-1" } });

    // The status route.
    const route = await plugin.definition.onApiRequest!({ routeKey: "setup-status", method: "GET", path: "/setup-status", params: {}, query: { companyId: M }, body: null, actor: { actorType: "user", actorId: "u-1" }, companyId: M, headers: {} });
    expect(route.status).toBe(200);
    expect(route.body).toMatchObject({ plugin: "partnersinbiz.accounting", module: "accounting" });
    expect((await plugin.definition.onApiRequest!({ routeKey: "other", method: "GET", path: "/x", params: {}, query: {}, body: null, actor: { actorType: "user", actorId: "u-1" }, companyId: M, headers: {} })).status).toBe(404);

    await harness.emit("plugin.partnersinbiz.setup.modules.updated", { companyId: M, modules: { accounting: false, billing: true }, updatedAt: "2026-09-26T10:00:00Z" }, { companyId: M });
    const key = "billing:invoice:m1:issue";
    await harness.emit(`plugin.${BILLING}.ledger.post.requested`, invoiceRequest(key, "2026-09-20"), { companyId: M });
    expect(results.at(-1)).toEqual({ key, status: "rejected", journalId: null, journalNumber: null, error: "Accounting is switched off for this company", source: invoiceRequest(key, "2026-09-20").source });
    expect((await db.listJournals(ctx.db, M)).total).toBe(0);
    expect(await db.listRejections(ctx.db, M, "open")).toEqual([]);
    expect(await db.inboxResult(ctx.db, `ledger:${key}`)).toBeNull();

    await harness.runJob("month-end");
    await harness.runJob("redeliver");
    const monthEnd = harness.logs.filter((l) => l.message === "Accounting month-end").at(-1)!.meta as { depreciation: Record<string, unknown>; closeIssues: Record<string, unknown> };
    expect(Object.keys(monthEnd.depreciation)).not.toContain(M);
    expect(Object.keys(monthEnd.closeIssues)).not.toContain(M);
    expect(statuses.some((s) => s.companyId === M)).toBe(false);

    // Switched back on: the sender's retry with the same key posts.
    await harness.emit("plugin.partnersinbiz.setup.modules.updated", { companyId: M, modules: { accounting: true }, updatedAt: "2026-09-26T11:00:00Z" }, { companyId: M });
    await harness.emit(`plugin.${BILLING}.ledger.post.requested`, invoiceRequest(key, "2026-09-20"), { companyId: M });
    expect(results.at(-1)).toMatchObject({ key, status: "posted", error: null });
    expect((await db.listJournals(ctx.db, M)).total).toBe(1);

    await harness.runJob("month-end");
    await harness.runJob("redeliver");
    const monthEndOn = harness.logs.filter((l) => l.message === "Accounting month-end").at(-1)!.meta as { depreciation: Record<string, unknown> };
    expect(Object.keys(monthEndOn.depreciation)).toContain(M);
    const published = statuses.filter((s) => s.companyId === M);
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).toMatchObject({ plugin: "partnersinbiz.accounting", module: "accounting" });
    // Throttled: a second run within the hour does not publish again.
    await harness.runJob("redeliver");
    expect(statuses.filter((s) => s.companyId === M)).toHaveLength(1);

    // Off again: an already-posted key still gets its stored answer.
    await harness.emit("plugin.partnersinbiz.setup.modules.updated", { companyId: M, modules: { accounting: false }, updatedAt: "2026-09-26T12:00:00Z" }, { companyId: M });
    await harness.emit(`plugin.${BILLING}.ledger.post.requested`, invoiceRequest(key, "2026-09-20"), { companyId: M });
    expect(results.at(-1)).toMatchObject({ key, status: "posted" });
    expect(harness.logs.filter((l) => l.level === "error")).toEqual([]);
  });

  describe("cockpit snapshot", () => {
    const S = "co-ck";
    const kpi = (snap: CockpitSnapshot, key: string) => snap.kpis.find((k) => k.key === key);
    const check = (snap: CockpitSnapshot, key: string) => snap.health.find((c) => c.key === key)!;

    it("before anything is set up: warns about settings and the book, and never creates one", async () => {
      const snap = await cockpitSnapshot(ctx, "co-ck-none");
      expect(snap).toMatchObject({ plugin: "partnersinbiz.accounting", title: "Accounting" });
      expect(check(snap, "settings")).toMatchObject({ status: "warn", href: "/setup" });
      expect(check(snap, "book")).toMatchObject({ status: "warn" });
      expect(kpi(snap, "cash")).toBeUndefined();
      expect(kpi(snap, "unreconciled")).toMatchObject({ raw: 0, tone: "ok" });
      expect(check(snap, "job:redeliver")).toMatchObject({ status: "ok", detail: "Has not run yet." });
      expect(check(snap, "hash_chain")).toMatchObject({ status: "ok", detail: "Not checked yet (checked daily)." });
      expect(snap.waiting).toEqual([]);
      expect(snap.health.find((c) => c.key === "snapshot")).toBeUndefined();
      expect(await db.getBook(ctx.db, "co-ck-none")).toBeNull();
    });

    it("configured: cash, this month's P&L, VAT due, bank lines, approvals and problems", async () => {
      configs.set(S, { legalName: "Cockpit Co", vatNumber: "4111111111", vatCategory: "C", financialYearEndMonth: 2 });
      await ensureBook(ctx, S);
      const today = todayIso();
      const postS = (req: LedgerPostRequested) => receivePostRequest(ctx, S, `plugin.${BILLING}.ledger.post.requested`, req);
      expect(await postS(invoiceRequest("billing:invoice:ck1:issue", today))).toMatchObject({ status: "posted" });
      const bank = await saveBankAccount(ctx, S, { name: "Main" });
      await importStatement(ctx, S, user, { bankAccountId: bank.id, content: fixture("statement.ofx"), fileName: "ck.ofx" });
      await q(`UPDATE ${NAMESPACE}.bank_lines SET date = current_date - 30 WHERE company_id = $1`, [S]);
      // A rejected posting and one refused by a closed period.
      await postS(invoiceRequest("billing:invoice:ck-bad:issue", today, { lines: [{ role: "ar", debitMinor: 100, creditMinor: 0 }, { role: "revenue", debitMinor: 0, creditMinor: 99 }] }));
      await setPeriod(ctx, S, "2026-01", "closed", user);
      await postS(invoiceRequest("billing:invoice:ck-jan:issue", "2026-01-10"));
      const draft = await saveDraft(ctx, S, { date: today, memo: "Accrue audit fee", lines: [{ accountCode: "6100", debitMinor: 1_000_00 }, { accountCode: "2300", creditMinor: 1_000_00 }] }, agent);
      const pending = await requestDraftApproval(ctx, S, draft.id, agent);

      const snap = await cockpitSnapshot(ctx, S);
      expect(snap.health.find((c) => c.key === "settings")).toBeUndefined();
      expect(kpi(snap, "cash")).toMatchObject({ group: "money", href: "/accounting?tab=bank" });
      expect(kpi(snap, "month_revenue")).toMatchObject({ raw: 10_000_00, value: "R 10,000.00" });
      expect(kpi(snap, "month_profit")).toMatchObject({ raw: 10_000_00, tone: "ok" });
      expect(kpi(snap, "vat_due")).toMatchObject({ raw: 1_500_00, href: "/accounting?tab=vat" });
      expect(kpi(snap, "unreconciled")!.raw).toBeGreaterThan(0);
      expect(kpi(snap, "unreconciled")!.tone).toBe("warn");
      expect(check(snap, "unreconciled_old")).toMatchObject({ status: "warn" });
      expect(check(snap, "rejections")).toMatchObject({ status: "bad" });
      expect(check(snap, "closed_period")).toMatchObject({ status: "warn" });
      expect(check(snap, "opening_balances")).toMatchObject({ status: "warn", href: "/accounting?tab=cutover" });
      expect(check(snap, "outbox").status).toBe("ok");
      expect(snap.waiting).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: `approval:${pending.approvalIssueId}`, issueId: pending.approvalIssueId, kind: "money", href: `/issues/${pending.approvalIssueId}` }),
        expect.objectContaining({ kind: "judgement", title: "Fix 2 rejected postings" }),
      ]));
      expect(snap.activity[0]!.text).toMatch(/^(Posted JNL-|Imported statement)/);
      expect(snap.activity.some((a) => a.text.startsWith("Imported statement ck.ofx"))).toBe(true);
      expect(snap.quality.map((m) => m.key)).toEqual(["categorisation_corrected"]);
    });

    it("reports a broken audit chain from the daily check", async () => {
      expect((await recordChainCheck(ctx, S)).ok).toBe(true);
      expect(check(await cockpitSnapshot(ctx, S), "hash_chain")).toMatchObject({ status: "ok" });
      const [row] = await q(`SELECT id, memo FROM ${NAMESPACE}.journals WHERE company_id = $1 ORDER BY seq LIMIT 1`, [S]);
      await q(`UPDATE ${NAMESPACE}.journals SET memo = 'edited' WHERE id = $1`, [row!.id]);
      expect((await recordChainCheck(ctx, S)).ok).toBe(false);
      expect(check(await cockpitSnapshot(ctx, S), "hash_chain")).toMatchObject({ status: "bad" });
      await q(`UPDATE ${NAMESPACE}.journals SET memo = $2 WHERE id = $1`, [row!.id, row!.memo]);
      await recordChainCheck(ctx, S);
    });

    it("keeps the rest when one query fails", async () => {
      const broken = { ...ctx, db: { ...ctx.db, query: async (text: string, params?: unknown[]) => (text.includes(".bank_lines") ? Promise.reject(new Error("boom")) : ctx.db.query(text, params)) } };
      const snap = await cockpitSnapshot(broken, S);
      expect(kpi(snap, "unreconciled")).toBeUndefined();
      expect(kpi(snap, "month_revenue")).toBeDefined();
      expect(check(snap, "snapshot")).toMatchObject({ status: "warn" });
    });

    it("the route, job tracking and the hourly push (module on and settings saved only)", async () => {
      const { createTestHarness } = await import("@paperclipai/plugin-sdk/testing");
      const manifest = (await import("../src/manifest.js")).default;
      const plugin = (await import("../src/worker.js")).default;
      const C = "co-ck-w";
      const harness = createTestHarness({ manifest, config: { legalName: "PiB", vatNumber: "4000000000", vatCategory: "B", financialYearEndMonth: 2 } });
      harness.seed({ companies: [{ id: C, issuePrefix: "PCK", name: "PCK" } as never] });
      (harness.ctx as unknown as { db: unknown }).db = shimDb();
      await plugin.definition.setup(harness.ctx);
      const pushed: string[] = [];
      harness.ctx.events.on("plugin.partnersinbiz.accounting.cockpit.snapshot", async (e) => void pushed.push(e.companyId));
      await harness.performAction("accounting.load", {}, { companyId: C, actor: { type: "user" as const, userId: "u-1" } });
      const route = await plugin.definition.onApiRequest!({ routeKey: "cockpit", method: "GET", path: "/cockpit", params: {}, query: { companyId: C }, body: null, actor: { actorType: "user", actorId: "u-1" }, companyId: C, headers: {} });
      expect(route.status).toBe(200);
      expect(route.body).toMatchObject({ plugin: "partnersinbiz.accounting" });

      await harness.emit("plugin.partnersinbiz.setup.modules.updated", { companyId: C, modules: { accounting: false }, updatedAt: "2026-09-26T10:00:00Z" }, { companyId: C });
      await harness.runJob("redeliver");
      expect(pushed).not.toContain(C);
      resetCockpitThrottle();
      await harness.emit("plugin.partnersinbiz.setup.modules.updated", { companyId: C, modules: { accounting: true }, updatedAt: "2026-09-26T11:00:00Z" }, { companyId: C });
      await harness.runJob("redeliver");
      expect(pushed.filter((c) => c === C)).toHaveLength(1);
      await harness.runJob("redeliver");
      expect(pushed.filter((c) => c === C)).toHaveLength(1);

      const snap = (await plugin.definition.onApiRequest!({ routeKey: "cockpit", method: "GET", path: "/cockpit", params: {}, query: { companyId: C }, body: null, actor: { actorType: "user", actorId: "u-1" }, companyId: C, headers: {} })).body as CockpitSnapshot;
      const job = snap.health.find((c) => c.key === "job:redeliver")!;
      expect(job.status).toBe("ok");
      expect(job.detail).toBeUndefined();
    });
  });
});
