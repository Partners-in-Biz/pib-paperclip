import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decisionsMigration, inboxMigration, outboxMigration } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { splitSqlStatements, validateMigrationStatement, validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

const migrationsDir = new URL("../migrations/", import.meta.url);

describe("migrations", () => {
  it("use the accounting namespace and pass the host migration guard", () => {
    expect(NAMESPACE).toBe("plugin_accounting_03d0185a67");
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    expect(files[0]).toBe("001_accounting.sql");
    let statements = 0;
    for (const file of files) {
      for (const statement of splitSqlStatements(readFileSync(new URL(file, migrationsDir), "utf8"))) {
        expect(() => validateMigrationStatement(statement, NAMESPACE), `${file}: ${statement.slice(0, 80)}`).not.toThrow();
        statements += 1;
      }
    }
    expect(statements).toBeGreaterThan(30);
  });

  it("contain the kit outbox, inbox and decisions tables as the kit defines them", () => {
    const sql = readFileSync(new URL("001_accounting.sql", migrationsDir), "utf8").replace(/\s+/g, " ");
    for (const kit of [outboxMigration(NAMESPACE), inboxMigration(NAMESPACE), decisionsMigration(NAMESPACE)]) {
      for (const statement of splitSqlStatements(kit)) expect(sql).toContain(statement.replace(/\s+/g, " ").trim());
    }
  });
});

describe("runtime SQL", () => {
  it("every statement in db.ts passes the host guard with JSON-safe params", async () => {
    const seen: string[] = [];
    const check = (kind: "query" | "execute") => async (sql: string, params: unknown[] = []) => {
      if (kind === "query") validateRuntimeQuery(sql, NAMESPACE, ["issues"]);
      else validateRuntimeExecute(sql, NAMESPACE);
      validateParams(sql, params);
      seen.push(sql.slice(0, 40));
      return kind === "query" ? [] : { rowCount: 1 };
    };
    const d = { namespace: NAMESPACE, query: check("query"), execute: check("execute") } as unknown as db.Db;
    const c = "co";
    const journal = {
      id: "j", companyId: c, seq: 1, number: "JNL-000001", date: "2026-09-01", memo: "m", kind: "event" as const, currency: "ZAR", fxRate: 18.5, bookCurrency: "ZAR",
      totalMinor: 100, lines: [], sourceKey: "k", source: { plugin: "p", kind: "k", id: "i" }, status: "posted" as const, reversesId: null, reversedById: null,
      postedBy: {}, prevHash: "0", hash: "h",
    };
    await db.getBook(d, c);
    await db.insertBook(d, c, "ZAR", "t");
    await db.setRejectionIssue(d, c, null);
    await db.setCutover(d, c, "2026-02-28", "j");
    await db.bookCompanies(d);
    await db.seedAccounts(d, c, [{ id: "a" }]);
    await db.listAccounts(d, c);
    await db.insertAccount(d, c, { id: "a", code: "1", name: "n", type: "asset", subtype: "bank", cashFlow: "cash", description: "" });
    await db.updateAccount(d, c, "a", { code: "1", name: "n", type: "asset", subtype: "bank", cashFlow: "cash", description: "", active: true });
    await db.accountHasPostings(d, c, "a");
    await db.seedRoles(d, c, [{ role: "ar", account_code: "1100" }]);
    await db.listRoles(d, c);
    await db.setRole(d, c, "ar", "1100");
    await db.deleteRole(d, c, "expense:x");
    await db.periodStatus(d, c, "2026-09");
    await db.listPeriods(d, c);
    await db.setPeriodStatus(d, c, "2026-09", "closed", "u");
    await db.seedTaxRates(d, c, [{ code: "za_std_15" }]);
    await db.listTaxRates(d, c);
    await db.lastJournal(d, c);
    await db.insertJournal(d, journal);
    await db.journalBySourceKey(d, c, "k");
    await db.journalById(d, c, "j");
    await db.journalsByIds(d, c, ["j"]);
    await db.reversalOf(d, c, "j");
    await db.markReversed(d, c, "j", "r");
    await db.listJournals(d, c, { from: "2026-01-01", to: "2026-12-31", kind: "event", search: "x", accountId: "a", limit: 10, offset: 5 });
    await db.listJournals(d, c);
    await db.journalsForChain(d, c, 0, 500);
    await db.journalsInRange(d, c, "2026-01-01", "2026-12-31");
    await db.journalsWithSourcePrefix(d, c, "depreciation:a:");
    await db.bookedRateFor(d, c, "inv");
    await db.accountTotals(d, c, { from: "2026-01-01", to: "2026-12-31" });
    await db.accountTotals(d, c, { to: "2026-12-31" });
    await db.accountTotals(d, c);
    await db.monthlyTotals(d, c, "2026-01-01", "2026-12-31");
    await db.glEntries(d, c, "a", "2026-01-01", "2026-12-31");
    await db.vatLines(d, c, "2026-01-01", "2026-02-28", ["a"]);
    await db.unlinkedBankJournals(d, c, "a", "2026-01-01", "2026-12-31");
    const draft = { id: "d", companyId: c, date: "2026-09-01", memo: "", currency: "ZAR", fxRate: null, lines: [], status: "draft", approvalIssueId: null, createdBy: {}, approvedBy: null, journalId: null, error: null, createdAt: null };
    await db.insertDraft(d, draft);
    await db.updateDraftContent(d, c, "d", { date: "2026-09-01", memo: "", currency: "ZAR", fxRate: null, lines: [] });
    await db.setDraftStatus(d, c, "d", ["draft"], { status: "pending_approval", approvalIssueId: "i" });
    await db.getDraft(d, c, "d");
    await db.listDrafts(d, c);
    await db.pendingDrafts(d);
    await db.upsertRejection(d, c, { key: "k", event: "e", source: {}, payload: {}, error: "x" });
    await db.resolveRejection(d, c, "k", "resolved", "j");
    await db.listRejections(d, c);
    await db.getRejection(d, c, "k");
    await db.inboxResult(d, "k");
    await db.deleteInbox(d, "k");
    await db.setInboxResult(d, c, "k", "e", {});
    await db.upsertOpenItem(d, c, { key: "invoice:1", kind: "receivable", itemId: "1", number: "INV-1", counterpartyName: "A", clientKind: null, clientRef: null, currency: "ZAR", totalMinor: 1, outstandingMinor: 1, issueDate: "2026-09-01", dueDate: null, refs: ["x"], status: "sent", sourcePlugin: "b", updatedAt: "2026-09-01T00:00:00Z" });
    await db.listOpenItems(d, c, { kind: "receivable", currency: "ZAR" });
    await db.listOpenItems(d, c, { openOnly: false });
    await db.getOpenItem(d, c, "invoice:1");
    const bank = { id: "b", name: "n", accountCode: "1000", bankName: "", numberLast4: "", currency: "ZAR", active: true };
    await db.insertBankAccount(d, c, bank);
    await db.updateBankAccount(d, c, bank);
    await db.listBankAccounts(d, c);
    await db.getBankAccount(d, c, "b");
    const statement = { id: "s", bankAccountId: "b", fileName: "", format: "csv", objectKey: null, digest: "x", lineCount: 1, newCount: 1, duplicateCount: 0, periodStart: null, periodEnd: null, openingMinor: null, closingMinor: null, createdAt: null };
    await db.insertStatement(d, c, statement, {});
    await db.updateStatementCounts(d, c, "s", 1, 0);
    await db.statementByDigest(d, "b", "x");
    await db.listStatements(d, c, "b");
    await db.listStatements(d, c);
    await db.insertBankLines(d, c, [{ id: "l" }]);
    await db.listBankLines(d, c, { bankAccountId: "b", statuses: ["unreconciled"], statementId: "s", from: "2026-01-01", to: "2026-12-31", ids: ["l"], limit: 10 });
    await db.getBankLine(d, c, "l");
    await db.setLineSuggestions(d, c, "l", []);
    await db.setLineSuggestions(d, c, "l", [], { x: 1 });
    await db.setSuggestionsBatch(d, c, [{ id: "l", suggestions: [] }, { id: "m", suggestions: [], jev: { a: 1 } }]);
    await db.setLineState(d, c, "l", ["unreconciled"], { status: "reconciled", match: {}, journalId: "j", note: null });
    await db.lockLinesToReconciliation(d, c, "b", "2026-01-01", "2026-01-31", "r");
    await db.lineCounts(d, c);
    await db.unreconciledInMonth(d, c, "2026-01-01", "2026-01-31");
    await db.listRules(d, c);
    await db.upsertRule(d, c, { id: "r", name: "n", priority: 1, active: true, field: "description", operator: "contains", value: "x", amountMinMinor: null, amountMaxMinor: null, direction: "any", accountCode: "6120", taxCode: null, counterparty: null });
    await db.deleteRule(d, c, "r");
    await db.upsertReconciliation(d, c, { id: "r", bankAccountId: "b", periodStart: "2026-01-01", periodEnd: "2026-01-31", openingMinor: 0, closingMinor: 0, linesTotalMinor: 0, differenceMinor: 0, unreconciledCount: 0, glBalanceMinor: 0 }, {});
    await db.reconciliationByPeriod(d, c, "b", "2026-01-01", "2026-01-31");
    await db.getReconciliation(d, c, "r");
    await db.listReconciliations(d, c, "b");
    await db.pendingReconciliations(d);
    await db.setReconciliationStatus(d, c, "r", "draft", { status: "pending_approval", approvalIssueId: "i" });
    await db.lockedReconciliationOverlaps(d, c, "b", "2026-01-01", "2026-01-31");
    await db.upsertVatReturn(d, c, { id: "v", periodStart: "2026-01-01", periodEnd: "2026-02-28", boxes: {}, detail: [], adjustments: {} }, {});
    await db.vatReturnByPeriod(d, c, "2026-01-01", "2026-02-28");
    await db.getVatReturn(d, c, "v");
    await db.listVatReturns(d, c);
    await db.pendingVatReturns(d);
    await db.setVatStatus(d, c, "v", "pending_approval", { status: "locked", lock: true, approvedBy: "u" });
    await db.lockedVatPeriodFor(d, c, "2026-02-01");
    await db.saveBudgets(d, c, [{ account_code: "4000", month: "2026-09", amount_minor: 1 }]);
    await db.listBudgets(d, c, "2026-01", "2026-12");
    await db.listForecastLines(d, c);
    await db.insertForecastLine(d, c, { id: "f", month: "2026-09", description: "x", amountMinor: 1, repeat: "none", untilMonth: null });
    await db.deleteForecastLine(d, c, "f");
    const asset = { id: "as", companyId: c, name: "n", category: "", assetAccountCode: "1510", accumulatedAccountCode: "1590", expenseAccountCode: "6150", costMinor: 1, residualMinor: 0, lifeMonths: 1, acquiredDate: "2026-01-01", depreciationStart: "2026-01-01", openingAccumulatedMinor: 0, openingThrough: null, status: "active" as const, disposedDate: null, disposalProceedsMinor: null, disposalAccountCode: null, disposalJournalId: null };
    await db.insertAsset(d, asset);
    await db.listAssets(d, c);
    await db.listAssets(d, null);
    await db.getAsset(d, c, "as");
    await db.markAssetDisposed(d, c, "as", { date: "2026-09-01", proceedsMinor: 0, accountCode: "1000", journalId: "j" });
    await db.saveFxRates(d, "ZAR", "2026-09-01", new Map([["USD", 18.2]]), "test");
    await db.ratesOnOrBefore(d, "ZAR", "2026-09-01", ["USD"]);
    await db.latestRates(d, "ZAR");
    await db.setMark(d, c, "m");
    await db.getMark(d, c, "m");
    await db.clearMark(d, c, "m");
    expect(seen.length).toBeGreaterThan(100);
  });
});
