/**
 * "As at today": a journal or bank line dated after today counts in no
 * Overview figure (cash, receivables, this month's profit) and not in the
 * current month of the charts; it is listed for a person to check. A
 * statement import flags such lines, and agents may not reconcile them.
 * Pure helpers first, then the service on a real (embedded) Postgres.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LedgerPostRequested } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../src/db.js";
import { linesDatedAfter } from "../src/domain/statements.js";
import { addDays, dayText, todayIso } from "../src/domain/util.js";
import { NAMESPACE } from "../src/namespace.js";
import { acceptSuggestion, assertAgentMayTouchDate, importStatement, reconcileIssueText, saveBankAccount } from "../src/service/bank.js";
import { ensureBook } from "../src/service/books.js";
import { periodLabel } from "../src/domain/dates.js";
import { cleanMemo } from "../src/domain/memo.js";
import { cockpitSnapshot } from "../src/service/cockpit.js";
import { receivePostRequest } from "../src/service/ledger.js";
import { overview, trends } from "../src/service/reports.js";
import * as guard from "./helpers/sql-guard.js";
import { freePort } from "./helpers/free-port.js";

describe("as at today: pure rules", () => {
  it("finds statement lines dated after today, earliest first", () => {
    expect(linesDatedAfter([{ date: "2026-09-26" }, { date: "2026-09-30" }, { date: "2026-09-28" }], "2026-09-27")).toEqual({ count: 2, first: "2026-09-28" });
    expect(linesDatedAfter([{ date: "2026-09-27" }], "2026-09-27")).toEqual({ count: 0, first: null });
  });

  it("keeps agents off a bank line dated after today, not people", () => {
    const agent = { kind: "agent" as const, agentId: "a", runId: "r", userId: null };
    const person = { kind: "user" as const, userId: "u" };
    expect(() => assertAgentMayTouchDate(agent, { date: "2026-09-28" }, "2026-09-27")).toThrow(/28 Sep 2026, after today/);
    expect(() => assertAgentMayTouchDate(agent, { date: "2026-09-27" }, "2026-09-27")).not.toThrow();
    expect(() => assertAgentMayTouchDate(person, { date: "2026-09-28" }, "2026-09-27")).not.toThrow();
  });

  it("says so on the reconcile issue", () => {
    const text = reconcileIssueText({ id: "b1", name: "FNB Business" }, 2, "2026-09-26", "2026-09-28", { count: 1, first: "2026-09-28" });
    expect(text).toContain("FNB Business** (26 Sep 2026 to 28 Sep 2026)");
    expect(text).toContain("**1 line is dated after today (first 28 Sep 2026).**");
    expect(reconcileIssueText({ id: "b1", name: "FNB" }, 1, null, null)).not.toContain("after today");
  });

  it("writes memos and periods for people: no database ids, months in words", () => {
    expect(cleanMemo("Payment for NOR-002 (Payment ref NOR-002 thanks) bank tx 9a37a56a-073d-4804-acd3-2bc06e218a05")).toBe("Payment for NOR-002 (Payment ref NOR-002 thanks)");
    expect(cleanMemo("Opening balances 3347ba94-1711-4492-9f2b-3603232a3393")).toBe("Opening balances");
    expect(periodLabel("2026-09-01", "2026-10-31")).toBe("Sep–Oct 2026");
    expect(periodLabel("2026-09-01", "2026-09-30")).toBe("Sep 2026");
    expect(periodLabel("2026-11-01", "2027-02-28")).toBe("Nov 2026–Feb 2027");
    expect(dayText("2026-09-28")).toBe("28 Sep 2026");
  });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG = path.resolve(here, "../../../db/node_modules");
const available = existsSync(`${DB_PKG}/embedded-postgres/dist/index.js`) && existsSync(`${DB_PKG}/drizzle-orm/postgres-js/index.js`);
const CO = "co-asat";
const BILLING = "partnersinbiz.billing";

describe.skipIf(!available)("as at today (postgres)", () => {
  let pg: { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void>; createDatabase(n: string): Promise<void> };
  let client: { unsafe(q: string, p?: unknown[]): Promise<Array<Record<string, unknown>>>; end(): Promise<void> };
  let orm: { execute(q: unknown): Promise<unknown> };
  let sqlTag: { raw(s: string): unknown; join(chunks: unknown[], sep: unknown): unknown } & ((strings: TemplateStringsArray, ...values: unknown[]) => unknown);
  const dataDir = mkdtempSync(path.join(tmpdir(), "acct-asat-"));
  const issues = new Map<string, { id: string; title: string; description: string; status: string }>();
  const config: Record<string, unknown> = { legalName: "Partners in Biz (Pty) Ltd", vatNumber: "4123456789", vatCategory: "B", financialYearEndMonth: 2, agentsMayAcceptCategorisation: true };
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

  beforeAll(async () => {
    const { default: EmbeddedPostgres } = await import(`${DB_PKG}/embedded-postgres/dist/index.js`);
    const { drizzle } = await import(`${DB_PKG}/drizzle-orm/postgres-js/index.js`);
    sqlTag = (await import(`${DB_PKG}/drizzle-orm/sql/sql.js`)).sql;
    const postgres = (await import(`${DB_PKG}/postgres/src/index.js`)).default;
    const port = await freePort();
    pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "t", password: "t", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("asat");
    client = postgres({ host: "127.0.0.1", port, user: "t", password: "t", database: "asat", onnotice: () => {} });
    orm = drizzle(client);
    await client.unsafe(`CREATE SCHEMA ${NAMESPACE}`);
    const migrations = readdirSync(path.join(here, "../migrations")).filter((f) => f.endsWith(".sql")).sort();
    for (const file of migrations) {
      for (const statement of guard.splitSqlStatements(readFileSync(path.join(here, "../migrations", file), "utf8"))) await client.unsafe(statement);
    }
    let seq = 0;
    ctx = {
      db: {
        namespace: NAMESPACE,
        async query(text: string, params: unknown[] = []) {
          guard.validateRuntimeQuery(text, NAMESPACE, ["issues"]);
          guard.validateParams(text, params);
          return JSON.parse(JSON.stringify([...((await orm.execute(bindSql(text, JSON.parse(JSON.stringify(params))))) as Iterable<unknown>)]));
        },
        async execute(text: string, params: unknown[] = []) {
          guard.validateRuntimeExecute(text, NAMESPACE);
          guard.validateParams(text, params);
          const result = await orm.execute(bindSql(text, JSON.parse(JSON.stringify(params))));
          return { rowCount: Number((result as { count?: number }).count ?? 0) };
        },
      },
      config: { get: async () => config },
      secrets: { resolve: async () => undefined },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      state: { get: async () => null, set: async () => undefined },
      events: { emit: async () => undefined },
      agents: { list: async () => [], get: async () => null },
      authorization: { grants: { list: async () => [], set: async () => [] } },
      skills: { managed: { reconcile: async () => ({}), reset: async () => ({}) } },
      issues: {
        create: async (input: Record<string, unknown>) => {
          seq += 1;
          const issue = { id: `iss-${seq}`, identifier: `PIB-${seq}`, title: String(input.title), description: String(input.description ?? ""), status: "todo" };
          issues.set(issue.id, issue);
          return issue;
        },
        get: async (id: string) => issues.get(id) ?? null,
        update: async (id: string, patch: Record<string, unknown>) => Object.assign(issues.get(id)!, patch),
        requestWakeup: async () => ({ queued: true }),
        createComment: async () => ({ id: "c" }),
      },
    };
    await ensureBook(ctx, CO);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await pg?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const post = (req: LedgerPostRequested) => receivePostRequest(ctx, CO, `plugin.${BILLING}.ledger.post.requested`, req);
  const invoice = (id: string, date: string, grossMinor: number): LedgerPostRequested => ({
    key: `billing:invoice:${id}:issue`,
    source: { plugin: BILLING, kind: "invoice", id },
    date,
    memo: `Invoice ${id}`,
    currency: "ZAR",
    lines: [
      { role: "ar", debitMinor: grossMinor, creditMinor: 0, clientKind: "company", clientRef: "crm-north" },
      { role: "revenue", debitMinor: 0, creditMinor: Math.round(grossMinor / 1.15), taxCode: "za_std_15" },
      { role: "vat_output", debitMinor: 0, creditMinor: grossMinor - Math.round(grossMinor / 1.15), taxCode: "za_std_15", taxBaseMinor: Math.round(grossMinor / 1.15) },
    ],
  });
  const payment = (id: string, date: string, amountMinor: number): LedgerPostRequested => ({
    key: `billing:payment:${id}`,
    source: { plugin: BILLING, kind: "payment", id },
    date,
    memo: `Payment ${id}`,
    currency: "ZAR",
    lines: [
      { accountCode: "1000", debitMinor: amountMinor, creditMinor: 0 },
      { role: "ar", debitMinor: 0, creditMinor: amountMinor, clientKind: "company", clientRef: "crm-north" },
    ],
  });

  it("leaves a journal dated tomorrow out of cash, receivables, this month and the chart (the review's case)", async () => {
    const today = todayIso();
    const tomorrow = addDays(today, 1);
    await post(invoice("nor1", today, 11_500_00));
    await post(invoice("nor2", today, 5_750_00));
    await post(payment("p1", today, 4_000_00));
    await post(payment("p2", tomorrow, 5_750_00)); // a bank line dated tomorrow, matched and posted

    const o = await overview(ctx, CO, today);
    expect(o.asOf).toBe(today);
    expect(o.cashMinor).toBe(4_000_00);
    expect(o.receivablesMinor).toBe(13_250_00);
    expect(o.future).toMatchObject({ journals: 1, bankLines: 0 });
    expect(o.future.items[0]).toMatchObject({ kind: "journal", date: tomorrow });
    expect(o.journalCount).toBe(4);

    // The chart's current month ends today, so its closing cash is the tile's figure.
    const t = await trends(ctx, CO, 12, today);
    expect(t.months.at(-1)!.closingCashMinor).toBe(4_000_00);

    // The Cockpit says the same and flags the date.
    const snap = await cockpitSnapshot(ctx, CO);
    expect(snap.kpis.find((k) => k.key === "cash")).toMatchObject({ raw: 4_000_00, delta: expect.stringMatching(/^as at \d{1,2} [A-Z][a-z]{2}/) });
    expect(snap.health.find((h) => h.key === "future_dates")).toMatchObject({ status: "warn", href: "/accounting?tab=bank" });
  });

  it("flags statement lines dated after today on import and keeps the Bookkeeper off them", async () => {
    const today = todayIso();
    const tomorrow = addDays(today, 1);
    const bank = await saveBankAccount(ctx, CO, { name: "FNB Business" });
    const slash = (d: string) => d.replace(/-/g, "/");
    const csv = ["Date,Amount,Balance,Description,Reference", `${slash(today)},100.00,100.00,Deposit today,DEP1`, `${slash(tomorrow)},5750.00,5850.00,Payment ref NOR-002 thanks,NOR-002`].join("\n");
    const result = await importStatement(ctx, CO, { kind: "user", userId: "u" }, { bankAccountId: bank.id, content: csv, fileName: "sept.csv" });
    expect(result).toMatchObject({ added: 2, futureLines: 1, firstFutureDate: tomorrow });
    expect(issues.get(result.issueId!)!.description).toContain("dated after today");

    const later = (await db.listBankLines(ctx.db, CO, { bankAccountId: bank.id })).find((l) => l.date === tomorrow)!;
    await db.setLineSuggestions(ctx.db, CO, later.id, [{ kind: "category", source: "rule", accountCode: "4000", taxCode: null, counterparty: null, confidence: 1 }]);
    const agent = { kind: "agent" as const, agentId: "agent-books", runId: "r", userId: null };
    await expect(acceptSuggestion(ctx, CO, agent, { lineId: later.id })).rejects.toThrow(/after today/);
    expect((await overview(ctx, CO, today)).future.bankLines).toBe(1);
  });
});
