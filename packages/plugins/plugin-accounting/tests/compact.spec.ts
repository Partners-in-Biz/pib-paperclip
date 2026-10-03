/**
 * Accounting 0.4: small tool results (audit Q8-11), the erasure answer (audit Q10-13) and the chart top-up
 * that adds the payment provider clearing account. Real Postgres behind the host SQL guard.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { chartSeedRows, CHART_TEMPLATE_ID, ZA_CHART } from "../src/domain/chart.js";
import { BATCH_MAX, acceptMany, acceptOne, compactLine, listBankLinesTool, pickLineFields, requestedAccountCode, suggestionLabel } from "../src/service/compact.js";
import { importStatement, saveBankAccount, saveRule } from "../src/service/bank.js";
import { ensureBook, loadChart } from "../src/service/books.js";
import { newId } from "../src/service/common.js";
import { receivePostRequest } from "../src/service/ledger.js";
import { eraseFromBooks } from "../src/service/privacy.js";
import { pgAvailable, startPgCtx, type PgCtx } from "./helpers/pg-ctx.js";
import { NAMESPACE } from "../src/namespace.js";

const CO = "co-compact";
const user = { kind: "user" as const, userId: "user-1" };
const agent = { kind: "agent" as const, agentId: "agent-books", runId: "r1", userId: null };

const CSV = [
  "Date,Description,Reference,Amount,Balance",
  "2026-09-01,FNB Monthly account fee,FEE,-150.00,9850.00",
  "2026-09-02,Takealot coffee machine for the office kitchen and a long text that goes on and on and on past the limit,TKL,-50.00,9800.00",
  "2026-09-03,Google Workspace September,GW,-1150.00,8650.00",
  "2026-09-04,Unknown deposit,UD,200.00,8850.00",
].join("\n");

describe("suggestionLabel and compactLine (pure)", () => {
  const line = (over: Partial<db.BankLineRow> = {}): db.BankLineRow => ({
    id: "l1", bankAccountId: "b1", statementId: null, date: "2026-09-01", amountMinor: -15_000, description: "FNB fee", reference: null, counterparty: null, balanceMinor: null,
    status: "unreconciled", suggestions: [], jev: null, match: null, journalId: null, reconciliationId: null, note: null, ...over,
  });

  it("says in words what accepting the top suggestion would do", () => {
    expect(suggestionLabel({ kind: "category", source: "rule", accountCode: "6120", taxCode: null, counterparty: null, confidence: 1 })).toBe("categorise to 6120 (bank rule)");
    expect(suggestionLabel({ kind: "category", source: "jev", accountCode: "6130", taxCode: "za_std_15", counterparty: "Google", confidence: 0.9 })).toBe("categorise to 6130 with za_std_15 (Jev, Google)");
    expect(suggestionLabel({ kind: "open_item", basis: "exact", key: "invoice:1", itemKind: "receivable", number: "INV-1", counterparty: "Acme", outstandingMinor: 100, confidence: 1 })).toBe("invoice INV-1 (Acme), exact match");
    expect(suggestionLabel({ kind: "journal", journalId: "j", number: "JNL-000009", date: "2026-09-01", memo: "x", confidence: 1 })).toBe("journal JNL-000009 already in the books");
  });

  it("keeps the first suggestion and counts the rest, and cuts long text", () => {
    const s = { kind: "category" as const, source: "rule" as const, accountCode: "6120", taxCode: null, counterparty: null, confidence: 1 };
    const c = compactLine(line({ description: "x".repeat(200), suggestions: [s, { ...s, accountCode: "6500" }, { ...s, accountCode: "6200" }], note: "n".repeat(300) }));
    expect(c.description).toHaveLength(80);
    expect(c.top).toBe("categorise to 6120 (bank rule)");
    expect(c.more).toBe(2);
    expect(c.note).toHaveLength(160);
    expect(c).not.toHaveProperty("bankAccountId");
    expect(compactLine(line(), { withAccount: true }).bankAccountId).toBe("b1");
  });

  it("returns exactly the asked fields and refuses a typo", () => {
    expect(pickLineFields(line(), ["id", "amountMinor"])).toEqual({ id: "l1", amountMinor: -15_000 });
    expect(() => pickLineFields(line(), ["id", "amount"])).toThrow(/Unknown field amount/);
  });
});

describe.skipIf(!pgAvailable)("compact tools and the books on real Postgres", () => {
  let h: PgCtx;
  let bankId = "";

  beforeAll(async () => {
    h = await startPgCtx();
    h.configs.set(CO, { legalName: "Compact Co", vatCategory: "B", financialYearEndMonth: 2, agentsMayAcceptCategorisation: true });
    await ensureBook(h.ctx, CO);
    bankId = (await saveBankAccount(h.ctx, CO, { name: "Main" })).id;
    await saveRule(h.ctx, CO, { name: "Bank fees", field: "description", operator: "contains", value: "account fee", accountCode: "6120", direction: "out" });
    await saveRule(h.ctx, CO, { name: "Google", field: "description", operator: "contains", value: "google", accountCode: "6130", taxCode: "za_std_15", direction: "out" });
    expect((await importStatement(h.ctx, CO, user, { bankAccountId: bankId, content: CSV, fileName: "sep.csv" })).added).toBe(4);
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  const lineByText = async (text: string) => (await db.listBankLines(h.ctx.db, CO, { bankAccountId: bankId })).find((l) => l.description.includes(text))!;

  it("lists compact lines by default, much smaller than the full ones", async () => {
    // A line with many candidate invoices is what made the old answer 2.4 KB a line.
    const busy = await lineByText("Unknown deposit");
    const many = Array.from({ length: 8 }, (_, i) => ({ kind: "open_item" as const, basis: "amount" as const, key: `invoice:cand${i}`, itemKind: "receivable" as const, number: `INV-10${i}`, counterparty: `Customer number ${i} (Pty) Ltd`, outstandingMinor: 200_00, confidence: 0.4 }));
    await db.setLineSuggestions(h.ctx.db, CO, busy.id, many);
    const compact = await listBankLinesTool(h.ctx, CO, { status: "unreconciled" });
    expect(compact).toMatchObject({ mode: "compact", count: 4 });
    const fee = (compact.lines as Array<Record<string, unknown>>).find((l) => String(l.description).includes("account fee"))!;
    expect(Object.keys(fee).sort()).toEqual(["amountMinor", "bankAccountId", "date", "description", "id", "status", "top"]);
    expect(fee.top).toBe("categorise to 6120 (bank rule)");
    const crowded = (compact.lines as Array<Record<string, unknown>>).find((l) => l.id === busy.id)!;
    expect(crowded).toMatchObject({ top: "invoice INV-100 (Customer number 0 (Pty) Ltd), amount match", more: 7 });
    const long = (compact.lines as Array<Record<string, unknown>>).find((l) => String(l.description).startsWith("Takealot"))!;
    expect(String(long.description).length).toBe(80);
    const full = await listBankLinesTool(h.ctx, CO, { status: "unreconciled", compact: false });
    expect(full.mode).toBe("full");
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length * 0.5);
    // Filtered by bank account, the account id is not repeated on every line.
    const one = await listBankLinesTool(h.ctx, CO, { bankAccountId: bankId });
    expect((one.lines as Array<Record<string, unknown>>)[0]).not.toHaveProperty("bankAccountId");
  });

  it("keeps full detail reachable by id", async () => {
    const google = await lineByText("Google");
    const result = await listBankLinesTool(h.ctx, CO, { ids: [google.id], compact: false });
    expect(result.count).toBe(1);
    expect((result.lines as Array<{ suggestions: Array<Record<string, unknown>>; reference: string }>)[0]).toMatchObject({ reference: "GW", suggestions: [expect.objectContaining({ index: 0, kind: "category", accountCode: "6130", taxCode: "za_std_15", source: "rule" })] });
    const fields = await listBankLinesTool(h.ctx, CO, { ids: [google.id], fields: ["id", "balanceMinor", "match"] });
    expect(fields.lines).toEqual([{ id: google.id, balanceMinor: 865_000, match: null }]);
    await expect(listBankLinesTool(h.ctx, CO, { fields: ["nonsense"] })).rejects.toThrow(/Unknown field nonsense/);
  });

  it("caps the page and says there is more", async () => {
    const page = await listBankLinesTool(h.ctx, CO, { limit: 2 });
    expect(page).toMatchObject({ count: 2, more: true });
    expect(page.next).toMatch(/Narrow with bankAccountId/);
    // A full listing never exceeds 50 lines, a compact one 200, whatever is asked.
    const huge = await listBankLinesTool(h.ctx, CO, { limit: 5000, compact: false });
    expect(huge.count).toBe(4);
    expect(huge).not.toHaveProperty("more");
  });

  it("accepts one line with a short result", async () => {
    const fee = await lineByText("account fee");
    const outcome = await acceptOne(h.ctx, CO, agent, { lineId: fee.id });
    expect(outcome).toMatchObject({ ok: true, lineId: fee.id, status: "reconciled", matchedTo: "account 6120", journalNumber: expect.stringMatching(/^JNL-/) });
    expect(JSON.stringify(outcome).length).toBeLessThan(400);
    // The same line again is a clear refusal, not a crash.
    expect(await acceptOne(h.ctx, CO, agent, { lineId: fee.id })).toMatchObject({ ok: false, error: expect.stringMatching(/already reconciled/), code: "conflict" });
  });

  it("accepts many lines in one call, in order, with a result per line", async () => {
    const google = await lineByText("Google");
    const coffee = await lineByText("Takealot");
    const deposit = await lineByText("Unknown deposit");
    const result = await acceptMany(h.ctx, CO, agent, [
      { lineId: google.id },
      { lineId: "missing-line" },
      { lineId: coffee.id, accountCode: "6160", memo: "Kitchen coffee" },
      { lineId: deposit.id, accountCode: "9999" },
    ]);
    expect(result.accepted).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.results.map((r) => [r.lineId, r.ok])).toEqual([[google.id, true], ["missing-line", false], [coffee.id, true], [deposit.id, false]]);
    expect(result.results[1]).toMatchObject({ error: expect.stringMatching(/not found/), code: "not_found" });
    expect(result.results[3]).toMatchObject({ error: "Unknown account 9999", code: "unknown_account" });
    expect(result.next).toMatch(/unchanged/);
    // Journal numbers follow the order of the list.
    const numbers = result.results.filter((r) => r.ok).map((r) => ("journalNumber" in r ? r.journalNumber : null));
    expect(numbers[0]! < numbers[1]!).toBe(true);
    // The VAT split on the Google line is the one the rule asked for.
    const journal = await db.journalById(h.ctx.db, CO, (await db.getBankLine(h.ctx.db, CO, google.id))!.journalId!);
    expect(journal!.lines.map((l) => [l.accountCode, l.debitMinor, l.creditMinor])).toEqual([["6130", 1_000_00, 0], ["1400", 150_00, 0], ["1000", 0, 1_150_00]]);
    expect((await db.getBankLine(h.ctx.db, CO, deposit.id))!.status).toBe("unreconciled");
  });

  it("an account code that is not text is an error on that line, never read as 'no code' (which would accept the top suggestion)", async () => {
    expect(requestedAccountCode(undefined)).toBeNull();
    expect(requestedAccountCode(null)).toBeNull();
    expect(requestedAccountCode("   ")).toBeNull();
    expect(requestedAccountCode(" 6100 ")).toBe("6100");
    for (const bad of [6100, true, { code: "6100" }, ["6100"]]) expect(() => requestedAccountCode(bad)).toThrow(/accountCode must be text/);

    const deposit = await lineByText("Unknown deposit");
    const one = await acceptOne(h.ctx, CO, agent, { lineId: deposit.id, accountCode: 4100 });
    expect(one).toMatchObject({ ok: false, lineId: deposit.id, error: expect.stringMatching(/accountCode must be text, like "6100" \(it was number\)/) });
    const batch = await acceptMany(h.ctx, CO, agent, [{ lineId: deposit.id, accountCode: 4100 }]);
    expect(batch).toMatchObject({ accepted: 0, failed: 1 });
    expect(batch.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/accountCode must be text/) });
    // Nothing was accepted or categorised: the line is exactly as it was.
    expect(await db.getBankLine(h.ctx.db, CO, deposit.id)).toMatchObject({ status: "unreconciled", journalId: null });
  });

  it("refuses an empty or oversized batch, and an agent when the setting is off", async () => {
    await expect(acceptMany(h.ctx, CO, agent, [])).rejects.toThrow(/lines must be a list/);
    await expect(acceptMany(h.ctx, CO, agent, Array.from({ length: BATCH_MAX + 1 }, () => ({ lineId: "x" })))).rejects.toThrow(/At most 50 lines/);
    h.configs.set(CO, { ...h.configs.get(CO), agentsMayAcceptCategorisation: false });
    const deposit = await lineByText("Unknown deposit");
    const refused = await acceptMany(h.ctx, CO, agent, [{ lineId: deposit.id, accountCode: "4100" }]);
    expect(refused.accepted).toBe(0);
    expect(refused.results[0]).toMatchObject({ ok: false, code: "forbidden", error: expect.stringMatching(/board user must accept/) });
    // A person can, with the same call.
    expect((await acceptMany(h.ctx, CO, user, [{ lineId: deposit.id, accountCode: "4100" }])).accepted).toBe(1);
  });

  it("answers an erasure request with what it dropped and what the law makes it keep", async () => {
    const item = (key: string, outstanding: number) => ({ key, kind: "receivable", id: key, number: key.toUpperCase(), counterpartyName: "Jane Doe", clientKind: "contact", clientRef: "ct-erase", currency: "ZAR", totalMinor: 100_00, outstandingMinor: outstanding, issueDate: "2026-08-01", dueDate: "2026-08-15", references: ["JANE01"], status: "sent", updatedAt: "2026-08-01T00:00:00Z" });
    const { receiveOpenItem } = await import("../src/service/ledger.js");
    await receiveOpenItem(h.ctx, CO, "partnersinbiz.billing", item("invoice:paid1", 0));
    await receiveOpenItem(h.ctx, CO, "partnersinbiz.billing", item("invoice:owed1", 100_00));
    await receivePostRequest(h.ctx, CO, "plugin.partnersinbiz.billing.ledger.post.requested", {
      key: "billing:invoice:erase1:issue", source: { plugin: "partnersinbiz.billing", kind: "invoice", id: "erase1" }, date: "2026-08-01", memo: "Invoice for Jane", currency: "ZAR",
      lines: [{ role: "ar", debitMinor: 100_00, creditMinor: 0, clientKind: "contact", clientRef: "ct-erase" }, { role: "revenue", debitMinor: 0, creditMinor: 100_00 }],
    });
    await h.q(`UPDATE ${NAMESPACE}.bank_lines SET description = description || ' jane@example.com' WHERE description LIKE 'Unknown deposit%'`);
    const request = { key: "erase:r1", requestId: "r1", subject: { email: "jane@example.com", clientKind: "contact" as const, clientRef: "ct-erase" }, scope: "all" as const, reason: "data_subject_request" as const, approvedByUserId: "user-1", requestedAt: "2026-10-03T00:00:00Z", source: "partnersinbiz.crm" };
    const outcome = await eraseFromBooks(h.ctx, request, CO);
    expect(outcome.counts).toEqual({ open_items: 1 });
    expect(outcome.retained!.map((r) => r.what)).toEqual([
      "1 receivable or payable still owed",
      "1 posted journal naming the client",
      "1 bank statement line with the person's email or phone in the text",
    ]);
    expect(outcome.retained![1]!.why).toMatch(/Companies Act s24.*hash chain/);
    const items = await db.listOpenItems(h.ctx.db, CO, { openOnly: false });
    expect(items.find((i) => i.key === "invoice:paid1")).toMatchObject({ counterpartyName: "[erased]", refs: [] });
    expect(items.find((i) => i.key === "invoice:owed1")).toMatchObject({ counterpartyName: "Jane Doe" });
    // Idempotent: a second run finds nothing more to drop.
    expect((await eraseFromBooks(h.ctx, request, CO)).counts).toEqual({});
    // A subject with no client reference and no data touches nothing.
    expect(await eraseFromBooks(h.ctx, { ...request, subject: { email: "nobody@example.com" } }, CO)).toEqual({ counts: {}, retained: [] });
  });

  it("tops an older book up with the payment provider clearing account, nothing else touched", async () => {
    const old = "co-old-chart";
    h.configs.set(old, { legalName: "Old Co" });
    await db.seedAccounts(h.ctx.db, old, chartSeedRows(newId).filter((a) => a.code !== "1020"));
    await db.seedRoles(h.ctx.db, old, []);
    await db.insertBook(h.ctx.db, old, "ZAR", "za-ifrs-sme-v1");
    expect((await loadChart(h.ctx, old)).byCode.has("1020")).toBe(false);
    await ensureBook(h.ctx, old);
    const chart = await loadChart(h.ctx, old);
    expect(chart.byCode.get("1020")).toMatchObject({ name: "Payment provider clearing (PayFast, Stripe)", type: "asset", subtype: "current_asset", active: true });
    expect(chart.accounts).toHaveLength(ZA_CHART.length);
    expect((await db.getBook(h.ctx.db, old))!.chartTemplate).toBe(CHART_TEMPLATE_ID);
    expect(CHART_TEMPLATE_ID).toBe("za-ifrs-sme-v2");
  });
});
