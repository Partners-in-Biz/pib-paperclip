/**
 * The ad account registry and the read-only sync, on a real Postgres: scopes and currencies, the daily rollups, the append-only spend ledger and
 * how it explains restated days, sign-ins that expire, and a broken sign-in becoming one issue for a person.
 */
import { sealJson } from "@partnersinbiz/pib-plugin-kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { discoverAccounts, registerAccount, removeAccount } from "../src/accounts.js";
import { refreshAllConnections, tokenFor } from "../src/connections.js";
import { budgetOverrides, dailyRows, getAccount, getConnection, getScope, insertAccount, insertConnection, listAccounts, listLedger, listCampaigns, setBudgetOverride, updateAccount } from "../src/db.js";
import { AdsError } from "../src/domain.js";
import { ProviderError } from "../src/providers/http.js";
import { summaryRecord } from "../src/records.js";
import { syncAccount, syncCompany } from "../src/sync.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { COMPANY, NOW, OWNER, world, type World } from "./helpers/world.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

const row = (campaign: string, day: string, spend: number, extra: Partial<{ impressions: number; clicks: number; conversions: number; valueMinor: number }> = {}) => ({
  campaignExternalId: campaign,
  campaignName: `Campaign ${campaign}`,
  day,
  spendMinor: spend,
  impressions: extra.impressions ?? 1000,
  clicks: extra.clicks ?? 50,
  conversions: extra.conversions ?? 2,
  valueMinor: extra.valueMinor ?? 20_000,
});

const campaign = (id: string, status: "active" | "paused" = "active", daily: number | null = 10_000) => ({ externalId: id, name: `Campaign ${id}`, status, rawStatus: status.toUpperCase(), objective: "OUTCOME_LEADS", channel: "mock", dailyBudgetMinor: daily, lifetimeBudgetMinor: null });

describe.skipIf(!available)("registering ad accounts", () => {
  let w: World;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    w.mock.accounts = [
      { externalId: "ext-1", name: "Acme ads", currency: "ZAR", timezone: "Africa/Johannesburg", status: "active" },
      { externalId: "ext-2", name: "Acme US", currency: "USD", timezone: "America/New_York", status: "active" },
    ];
  });

  it("only a person's connection can see accounts, and an account the connection cannot see is refused", async () => {
    const { connectionId } = await w.account({ scope: "own", externalId: "something-else" });
    const found = await discoverAccounts(w.rt(), connectionId);
    expect(found.map((a) => a.externalId)).toEqual(["ext-1", "ext-2"]);
    await expect(registerAccount(w.rt(), { userId: OWNER }, { connectionId, externalId: "not-visible", scopeKey: "own" })).rejects.toThrow(/not one this connection can see/);
  });

  it("registers an account under PiB's own ads, takes its currency for the new scope, and is read-only", async () => {
    const { connectionId } = await w.account({ scope: "company:zzz", externalId: "placeholder" });
    const res = await registerAccount(w.rt(), { userId: OWNER }, { connectionId, externalId: "ext-1", scopeKey: "own" });
    expect(res.created).toBe(true);
    expect(res.scope).toMatchObject({ scope_key: "own", currency: "ZAR", allow_writes: false, monthly_cap_minor: null, signoffs: "owner" });
    expect(res.account).toMatchObject({ currency: "ZAR", scope_key: "own", status: "active" });
    // Registering again is an update, not a second account.
    const again = await registerAccount(w.rt(), { userId: OWNER }, { connectionId, externalId: "ext-1", scopeKey: "own" });
    expect(again.created).toBe(false);
    expect((await listAccounts(w.ctx, COMPANY)).filter((a) => a.external_id === "ext-1")).toHaveLength(1);
  });

  it("a client's scope needs a client the CRM knows, and asks for the client's own yes by default", async () => {
    const { connectionId } = await w.account({ scope: "own", externalId: "placeholder" });
    await expect(registerAccount(w.rt(), { agentId: "a1" }, { connectionId, externalId: "ext-1", scopeKey: "company:acme" })).rejects.toThrow(/CRM has no client company:acme/);
    await w.harness.emit("plugin.partnersinbiz.crm.company.upserted", { id: "acme", name: "Acme Ltd", domain: null, lifecycle: "customer", updatedAt: "2026-10-01T00:00:00Z" }, { companyId: COMPANY });
    const res = await registerAccount(w.rt(), { agentId: "a1" }, { connectionId, externalId: "ext-1", scopeKey: "company:acme" });
    expect(res.scope).toMatchObject({ scope_key: "company:acme", client_kind: "company", client_ref: "acme", signoffs: "owner_client" });
  });

  it("an account belongs to one scope, and a scope has one currency so its cap adds up", async () => {
    const { connectionId } = await w.account({ scope: "own", externalId: "placeholder" });
    await w.harness.emit("plugin.partnersinbiz.crm.company.upserted", { id: "acme", name: "Acme Ltd", domain: null, lifecycle: null, updatedAt: "2026-10-01T00:00:00Z" }, { companyId: COMPANY });
    await registerAccount(w.rt(), { userId: OWNER }, { connectionId, externalId: "ext-1", scopeKey: "own" });
    await expect(registerAccount(w.rt(), { userId: OWNER }, { connectionId, externalId: "ext-1", scopeKey: "company:acme" })).rejects.toThrow(/already registered under PiB/);
    await expect(registerAccount(w.rt(), { userId: OWNER }, { connectionId, externalId: "ext-2", scopeKey: "own" })).rejects.toThrow(/budgets in ZAR, and this account is in USD/);
    expect(await listAccounts(w.ctx, COMPANY, { scopeKey: "own" })).toHaveLength(2); // the placeholder + ext-1, not ext-2
  });

  it("moving a scope to another currency clears its cap (a ZAR cap is not the same number of USD cents): a person may, an agent may not", async () => {
    const { connectionId, accountId } = await w.account({ scope: "own", externalId: "placeholder", cap: 500_000, allowWrites: true });
    await setBudgetOverride(w.ctx, COMPANY, "own", "2026-11", 900_000, null, `user:${OWNER}`);
    await updateAccount(w.ctx, COMPANY, accountId, { status: "disabled" });
    await expect(registerAccount(w.rt(), { agentId: "a1" }, { connectionId, externalId: "ext-2", scopeKey: "own" })).rejects.toThrow(/Only a person can move a scope to another currency/);
    expect(await getScope(w.ctx, COMPANY, "own")).toMatchObject({ currency: "ZAR", monthly_cap_minor: 500_000, allow_writes: true });
    const moved = await registerAccount(w.rt(), { userId: OWNER }, { connectionId, externalId: "ext-2", scopeKey: "own" });
    expect(moved.scope).toMatchObject({ currency: "USD", monthly_cap_minor: null, allow_writes: false, allow_writes_by: `user:${OWNER}` });
    expect(moved.capCleared).toBe(true);
    expect(await budgetOverrides(w.ctx, COMPANY, "own")).toEqual([]);
    const audited = (await pg.client.query(`SELECT actor, detail FROM ${w.ctx.db.namespace}.audit WHERE action = 'scope.currency_changed'`)).rows as Array<{ actor: string; detail: Record<string, unknown> }>;
    expect(audited).toEqual([{ actor: `user:${OWNER}`, detail: { from: "ZAR", to: "USD", capCleared: true, previousCapMinor: 500_000 } }]);
  });

  it("a scope with no cap yet simply takes the new currency, for an agent too", async () => {
    const { connectionId, accountId } = await w.account({ scope: "own", externalId: "placeholder", cap: null });
    await updateAccount(w.ctx, COMPANY, accountId, { status: "disabled" });
    const res = await registerAccount(w.rt(), { agentId: "a1" }, { connectionId, externalId: "ext-2", scopeKey: "own" });
    expect(res.scope).toMatchObject({ currency: "USD", monthly_cap_minor: null });
  });

  it("a refused registration changes nothing (not even the currency step)", async () => {
    const { connectionId, accountId } = await w.account({ scope: "own", externalId: "placeholder", cap: 500_000 });
    await updateAccount(w.ctx, COMPANY, accountId, { status: "disabled" });
    await w.harness.emit("plugin.partnersinbiz.crm.company.upserted", { id: "acme", name: "Acme Ltd", domain: null, lifecycle: null, updatedAt: "2026-10-01T00:00:00Z" }, { companyId: COMPANY });
    // ext-2 is in USD: had the registration under PiB's own ads gone ahead, it would have turned that scope's ZAR cap into USD.
    await registerAccount(w.rt(), { userId: OWNER }, { connectionId, externalId: "ext-2", scopeKey: "company:acme" });
    await expect(registerAccount(w.rt(), { userId: OWNER }, { connectionId, externalId: "ext-2", scopeKey: "own" })).rejects.toThrow(/already registered under/);
    expect(await getScope(w.ctx, COMPANY, "own")).toMatchObject({ currency: "ZAR", monthly_cap_minor: 500_000 });
  });

  it("an agent cannot bring back an account a person removed: its spend would count in the budget again without the person's say", async () => {
    const { connectionId } = await w.account({ scope: "own", externalId: "placeholder" });
    const first = await registerAccount(w.rt(), { userId: OWNER }, { connectionId, externalId: "ext-1", scopeKey: "own" });
    await removeAccount(w.ctx, COMPANY, { userId: OWNER }, first.account.id);
    expect((await getAccount(w.ctx, COMPANY, first.account.id))!.status).toBe("disabled");
    await expect(registerAccount(w.rt(), { agentId: "a1" }, { connectionId, externalId: "ext-1", scopeKey: "own" })).rejects.toThrow(/A person removed this ad account/);
    expect((await getAccount(w.ctx, COMPANY, first.account.id))!.status).toBe("disabled");
    const back = await registerAccount(w.rt(), { userId: OWNER }, { connectionId, externalId: "ext-1", scopeKey: "own" });
    expect(back.account.status).toBe("active");
    // An agent may still refresh an account that is active.
    expect((await registerAccount(w.rt(), { agentId: "a1" }, { connectionId, externalId: "ext-1", scopeKey: "own" })).created).toBe(false);
  });

  it("refuses a malformed scope", async () => {
    const { connectionId } = await w.account({ scope: "own", externalId: "placeholder" });
    await expect(registerAccount(w.rt(), { userId: OWNER }, { connectionId, externalId: "ext-1", scopeKey: "everyone" })).rejects.toBeInstanceOf(AdsError);
  });
});

describe.skipIf(!available)("the read-only sync", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await w.account({ externalId: "ext-1" }));
    w.mock.campaigns["ext-1"] = [campaign("c1"), campaign("c2", "paused", 5000)];
    w.mock.insightRows["ext-1"] = [row("c1", "2026-10-13", 10_000), row("c1", "2026-10-14", 12_000), row("c2", "2026-10-14", 3000)];
  });

  it("reads campaigns and daily numbers, writes the rollups and a ledger entry per changed day, and re-reads 30 days the first time", async () => {
    const account = (await getAccount(w.ctx, COMPANY, accountId))!;
    const result = await syncAccount(w.rt(), account);
    expect(result).toMatchObject({ ok: true, campaigns: 2, days: 30, ledgerEntries: 3 });
    expect(w.mock.reads).toContain("insights:ext-1:2026-09-16:2026-10-15");
    expect((await dailyRows(w.ctx, COMPANY, "2026-10-01")).map((r) => [r.campaign_external_id, r.day, r.spend])).toEqual([["c1", "2026-10-13", 10_000], ["c1", "2026-10-14", 12_000], ["c2", "2026-10-14", 3000]]);
    expect((await listLedger(w.ctx, COMPANY, {})).map((e) => [e.campaign_external_id, e.day, e.delta_minor, e.total_minor, e.kind]).sort()).toEqual([["c1", "2026-10-13", 10_000, 10_000, "first"], ["c1", "2026-10-14", 12_000, 12_000, "first"], ["c2", "2026-10-14", 3000, 3000, "first"]]);
    expect((await listCampaigns(w.ctx, COMPANY)).map((c) => [c.external_id, c.status, c.daily_budget_minor])).toEqual([["c1", "active", 10_000], ["c2", "paused", 5000]]);
    expect((await getAccount(w.ctx, COMPANY, accountId))).toMatchObject({ last_sync_error: null, consecutive_failures: 0 });
  });

  it("a second read of the same numbers adds nothing; a restated day adds one ledger entry that explains the change", async () => {
    const rt = w.rt();
    await syncAccount(rt, (await getAccount(w.ctx, COMPANY, accountId))!);
    const second = await syncAccount(rt, (await getAccount(w.ctx, COMPANY, accountId))!);
    expect(second).toMatchObject({ ok: true, days: 3, ledgerEntries: 0 });
    w.mock.insightRows["ext-1"] = [row("c1", "2026-10-13", 10_000), row("c1", "2026-10-14", 15_500), row("c2", "2026-10-14", 3000)];
    const third = await syncAccount(rt, (await getAccount(w.ctx, COMPANY, accountId))!);
    expect(third.ledgerEntries).toBe(1);
    const entries = (await listLedger(w.ctx, COMPANY, {})).filter((e) => e.campaign_external_id === "c1" && e.day === "2026-10-14");
    expect(entries.map((e) => [e.seq, e.delta_minor, e.total_minor, e.kind]).sort()).toEqual([[1, 12_000, 12_000, "first"], [2, 3500, 15_500, "restatement"]]);
    // The day's total is the latest entry; the ledger sums to what the rollup holds.
    expect(entries.reduce((sum, e) => sum + e.delta_minor, 0)).toBe(15_500);
    expect((await dailyRows(w.ctx, COMPANY, "2026-10-14")).find((r) => r.campaign_external_id === "c1")!.spend).toBe(15_500);
  });

  it("a day the platform stops returning is set to zero and the ledger shows the drop", async () => {
    const rt = w.rt();
    await syncAccount(rt, (await getAccount(w.ctx, COMPANY, accountId))!);
    w.mock.insightRows["ext-1"] = [row("c1", "2026-10-13", 10_000), row("c2", "2026-10-14", 3000)];
    await syncAccount(rt, (await getAccount(w.ctx, COMPANY, accountId))!);
    expect((await dailyRows(w.ctx, COMPANY, "2026-10-14")).find((r) => r.campaign_external_id === "c1")).toMatchObject({ spend: 0, impressions: 0, clicks: 0 });
    const last = (await listLedger(w.ctx, COMPANY, {})).filter((e) => e.campaign_external_id === "c1" && e.day === "2026-10-14").sort((a, b) => b.seq - a.seq)[0]!;
    expect(last).toMatchObject({ delta_minor: -12_000, total_minor: 0, kind: "restatement" });
  });

  it("an empty answer for the whole window never wipes the numbers we hold (a permission gone quiet is not a restatement to zero)", async () => {
    const rt = w.rt();
    await syncAccount(rt, (await getAccount(w.ctx, COMPANY, accountId))!);
    const before = (await listLedger(w.ctx, COMPANY, {})).length;
    w.mock.insightRows["ext-1"] = [];
    const result = await syncAccount(rt, (await getAccount(w.ctx, COMPANY, accountId))!);
    expect(result).toMatchObject({ ok: true, ledgerEntries: 0 });
    expect((await dailyRows(w.ctx, COMPANY, "2026-10-01")).map((r) => [r.campaign_external_id, r.day, r.spend])).toEqual([["c1", "2026-10-13", 10_000], ["c1", "2026-10-14", 12_000], ["c2", "2026-10-14", 3000]]);
    expect(await listLedger(w.ctx, COMPANY, {})).toHaveLength(before);
  });

  describe("after the sync could not run for a while", () => {
    const acct = async () => (await getAccount(w.ctx, COMPANY, accountId))!;
    const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-10-${String(from + i).padStart(2, "0")}`);
    const platformRows = (from: number, to: number) => days(from, to).map((d) => row("c1", d, 10_000 + Number(d.slice(8)) * 100));
    const at = (day: string) => new Date(`${day}T10:00:00Z`);

    it("reads back every day since the last good read, so the month-to-date matches the platform (a lapsed sign-in must not leave a hole)", async () => {
      w.mock.insightRows["ext-1"] = platformRows(10, 15);
      await syncAccount(w.rt(), await acct());
      // Six days pass with no good read; the platform kept counting.
      w.mock.insightRows["ext-1"] = platformRows(10, 21);
      const result = await syncAccount(w.rt(undefined, at("2026-10-21")), await acct());
      expect(result).toMatchObject({ ok: true, days: 9, gapDays: 6 });
      expect(w.mock.reads).toContain("insights:ext-1:2026-10-13:2026-10-21");
      const held = await dailyRows(w.ctx, COMPANY, "2026-10-01");
      expect(held.map((r) => r.day)).toEqual(days(10, 21));
      expect(held.reduce((sum, r) => sum + r.spend, 0)).toBe(platformRows(10, 21).reduce((sum, r) => sum + r.spendMinor, 0));
      // The ledger explains every day it added, and says an outage was read back.
      expect((await listLedger(w.ctx, COMPANY, {})).filter((e) => e.day >= "2026-10-16").map((e) => e.day).sort()).toEqual(days(16, 21));
      const audited = (await pg.client.query(`SELECT detail FROM ${w.ctx.db.namespace}.audit WHERE action = 'sync.backfilled'`)).rows as Array<{ detail: { gapDays: number; readDays: number } }>;
      expect(audited).toHaveLength(1);
      expect(audited[0]!.detail).toMatchObject({ gapDays: 6, readDays: 9 });
      // Back to normal afterwards.
      expect(await syncAccount(w.rt(undefined, at("2026-10-21")), await acct())).toMatchObject({ days: 3 });
    });

    it("a read that failed does not count as the last good read, so the next good one still reaches back", async () => {
      w.mock.insightRows["ext-1"] = platformRows(10, 15);
      await syncAccount(w.rt(), await acct());
      w.mock.insightRows["ext-1"] = platformRows(10, 19);
      w.mock.failNext.insights = new ProviderError("Meta is down (HTTP 503)", { retryable: true, status: 503 });
      expect(await syncAccount(w.rt(undefined, at("2026-10-18")), await acct())).toMatchObject({ ok: false });
      const result = await syncAccount(w.rt(undefined, at("2026-10-19")), await acct());
      expect(result).toMatchObject({ ok: true, days: 7, gapDays: 4 });
      expect((await dailyRows(w.ctx, COMPANY, "2026-10-01")).map((r) => r.day)).toEqual(days(10, 19));
    });

    it("a short read (an agent asking for 1 day, or the look after a change) never hides the gap: the next full read still backfills", async () => {
      w.mock.insightRows["ext-1"] = platformRows(10, 15);
      await syncAccount(w.rt(), await acct());
      w.mock.insightRows["ext-1"] = platformRows(10, 19);
      const short = await syncAccount(w.rt(undefined, at("2026-10-19")), await acct(), { days: 1 });
      expect(short).toMatchObject({ ok: true, days: 1, partial: true });
      const after = await acct();
      expect(Date.parse(after.last_sync_ok_at!)).toBe(NOW.getTime());
      expect(after).toMatchObject({ last_sync_error: null, consecutive_failures: 0 });
      expect((await dailyRows(w.ctx, COMPANY, "2026-10-01")).map((r) => r.day)).toEqual([...days(10, 15), "2026-10-19"]);
      const full = await syncAccount(w.rt(undefined, at("2026-10-19")), await acct());
      expect(full).toMatchObject({ days: 7, gapDays: 4 });
      expect(full.partial).toBeUndefined();
      expect((await dailyRows(w.ctx, COMPANY, "2026-10-01")).map((r) => r.day)).toEqual(days(10, 19));
      // A short read asked for a window as long as the one needed is a full read.
      expect(await syncAccount(w.rt(undefined, at("2026-10-19")), await acct(), { days: 30 })).not.toHaveProperty("partial");
    });

    it("a gap longer than a read can go back reads what it can and says the oldest days are missing", async () => {
      await syncAccount(w.rt(), await acct());
      const later = new Date(NOW.getTime() + 120 * 86_400_000);
      const result = await syncAccount(w.rt(undefined, later), await acct());
      expect(result).toMatchObject({ ok: true, days: 90, truncated: true, gapDays: 120 });
      const audited = (await pg.client.query(`SELECT detail FROM ${w.ctx.db.namespace}.audit WHERE action = 'sync.gap_truncated'`)).rows as Array<{ detail: { gapDays: number; wantedDays: number; readDays: number } }>;
      expect(audited).toHaveLength(1);
      expect(audited[0]!.detail).toMatchObject({ gapDays: 120, wantedDays: 123, readDays: 90 });
    });
  });

  it("repairs a ledger that fell behind (a crash between the two writes) on the next read", async () => {
    await pg.client.query(`INSERT INTO ${w.ctx.db.namespace}.daily (company_id, account_id, campaign_external_id, day, spend_minor, currency) VALUES ($1, $2, 'c1', '2026-10-14', 12000, 'ZAR')`, [COMPANY, accountId]);
    expect(await listLedger(w.ctx, COMPANY, {})).toEqual([]);
    await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, accountId))!);
    const entries = (await listLedger(w.ctx, COMPANY, {})).filter((e) => e.campaign_external_id === "c1" && e.day === "2026-10-14");
    expect(entries.reduce((sum, e) => sum + e.delta_minor, 0)).toBe(12_000);
  });

  it("an unlisted campaign keeps its numbers under its own name", async () => {
    w.mock.campaigns["ext-1"] = [campaign("c1")];
    await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, accountId))!);
    expect((await listCampaigns(w.ctx, COMPANY)).find((c) => c.external_id === "c2")).toMatchObject({ status: "archived", name: "Campaign c2" });
  });

  it("a failing read is recorded on the account, never throws, and counts up", async () => {
    w.mock.failNext.insights = new ProviderError("Meta is down (HTTP 503)", { retryable: true, status: 503 });
    const result = await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, accountId))!);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Meta is down") });
    expect(await getAccount(w.ctx, COMPANY, accountId)).toMatchObject({ consecutive_failures: 1, last_sync_error: expect.stringContaining("Meta is down") });
    w.mock.failNext.insights = new ProviderError("again", { retryable: true });
    await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, accountId))!);
    expect((await getAccount(w.ctx, COMPANY, accountId))!.consecutive_failures).toBe(2);
    await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, accountId))!);
    expect(await getAccount(w.ctx, COMPANY, accountId)).toMatchObject({ consecutive_failures: 0, last_sync_error: null });
  });

  it("a sign-in the platform rejects becomes ONE issue for the owner, the account says so, and a good read closes it again", async () => {
    w.mock.failNext.insights = new ProviderError("Invalid OAuth access token", { tokenInvalid: true, status: 401 });
    const rt = w.rt();
    const result = await syncAccount(rt, (await getAccount(w.ctx, COMPANY, accountId))!);
    expect(result).toMatchObject({ ok: false, needsReconnect: true });
    const account = (await getAccount(w.ctx, COMPANY, accountId))!;
    const conn = (await getConnection(w.ctx, COMPANY, account.connection_id!))!;
    expect(conn).toMatchObject({ status: "needs_reconnect", reconnect_issue_id: expect.any(String) });
    const issues = (await w.issues()).filter((i) => i.originId?.startsWith("ads-reconnect:"));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ assigneeUserId: OWNER, status: "todo" });
    expect(issues[0]!.description).toContain("only a person can give");
    // A second sync of the broken connection is skipped, and opens nothing more.
    const company = await syncCompany(rt);
    expect(company).toMatchObject({ skipped: 1, ok: 0 });
    expect((await w.issues()).filter((i) => i.originId?.startsWith("ads-reconnect:"))).toHaveLength(1);
  });

  it("the company read skips accounts that are off, and reports ok and failed counts", async () => {
    const other = await insertAccount(w.ctx, { companyId: COMPANY, platform: "mock", externalId: "ext-9", name: "Off", currency: "ZAR", timezone: "UTC", scopeKey: "own", connectionId: (await getAccount(w.ctx, COMPANY, accountId))!.connection_id, loginCustomerId: null, createdBy: "t" });
    await updateAccount(w.ctx, COMPANY, other, { status: "disabled" });
    const res = await syncCompany(w.rt());
    expect(res).toMatchObject({ accounts: 1, ok: 1, failed: 0 });
  });

  it("a short read (an agent asking) stops after the limit it was given, however many accounts exist", async () => {
    const connectionId = (await getAccount(w.ctx, COMPANY, accountId))!.connection_id;
    await insertAccount(w.ctx, { companyId: COMPANY, platform: "mock", externalId: "ext-2", name: "Second", currency: "ZAR", timezone: "UTC", scopeKey: "own", connectionId, loginCustomerId: null, createdBy: "t" });
    expect(await syncCompany(w.rt(), { limit: 1 })).toMatchObject({ accounts: 1, ok: 1 });
    expect(await syncCompany(w.rt())).toMatchObject({ accounts: 2 });
  });
});

describe.skipIf(!available)("sign-in tokens", () => {
  let w: World;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
  });

  async function oauthConnection(platform: "google" | "meta", expiresInMs: number) {
    const rt = w.rt();
    const keyring = await rt.config.keyring();
    const expiresAt = new Date(NOW.getTime() + expiresInMs).toISOString();
    const id = await insertConnection(w.ctx, { companyId: COMPANY, platform, label: `${platform} sign-in`, mode: "oauth", tokenEnc: sealJson({ accessToken: "old-access", refreshToken: "r", expiresAt }, keyring), keyVersion: keyring.currentVersion, expiresAt, scopes: ["x"], canWrite: false, externalUserId: "u", createdBy: OWNER });
    return (await getConnection(w.ctx, COMPANY, id))!;
  }

  it("opens a token that is still good without calling the platform, and refreshes one that is about to lapse", async () => {
    const good = await oauthConnection("google", 30 * 60_000);
    expect((await tokenFor(w.rt(), good)).accessToken).toBe("old-access");
    expect(w.mock.refreshed).toBe(0);
    const soon = await oauthConnection("google", 2 * 60_000);
    expect((await tokenFor(w.rt(), soon)).accessToken).toBe("mock-access-1");
    // The new token is stored sealed: opening it again gives the refreshed one with no further call.
    expect((await tokenFor(w.rt(), (await getConnection(w.ctx, COMPANY, soon.id))!)).accessToken).toBe("mock-access-1");
    expect(w.mock.refreshed).toBe(1);
  });

  it("renews Meta's long-lived token only when it is within ten days of the end", async () => {
    const far = await oauthConnection("meta", 40 * 86_400_000);
    await tokenFor(w.rt(), far);
    expect(w.mock.refreshed).toBe(0);
    const near = await oauthConnection("meta", 8 * 86_400_000);
    await tokenFor(w.rt(), near);
    expect(w.mock.refreshed).toBe(1);
  });

  it("the hourly keep-alive renews what is due and flags a sign-in that can no longer be renewed, with an issue for the owner", async () => {
    const due = await oauthConnection("google", 60_000);
    const fresh = await oauthConnection("google", 3 * 3_600_000);
    const outcomes = await refreshAllConnections(w.rt());
    expect(outcomes.find((o) => o.connectionId === due.id)?.result).toBe("refreshed");
    expect(outcomes.find((o) => o.connectionId === fresh.id)?.result).toBe("fresh");
    const dead = await oauthConnection("google", 60_000);
    w.mock.failNext.refresh = new ProviderError("Token has been expired or revoked.", { tokenInvalid: true, status: 400 });
    const second = await refreshAllConnections(w.rt());
    expect(second.find((o) => o.connectionId === dead.id || o.connectionId === due.id)?.result).toBeDefined();
    const flagged = (await w.issues()).filter((i) => i.originId?.startsWith("ads-reconnect:"));
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(flagged.every((i) => i.assigneeUserId === OWNER)).toBe(true);
  });

  it("a saved system-user token is read from the settings each time and nothing is stored", async () => {
    const raw = { ...(await w.harness.ctx.config.get(COMPANY)), platforms: { meta: { enabled: true, systemUserToken: "SYSTEM-USER-TOKEN-0123456789" } } } as Record<string, unknown>;
    const rt = w.rt(raw);
    const id = await insertConnection(w.ctx, { companyId: COMPANY, platform: "meta", label: "Meta (system user)", mode: "token", tokenEnc: null, keyVersion: null, expiresAt: null, scopes: ["ads_read"], canWrite: false, externalUserId: "system-user", createdBy: OWNER });
    expect((await tokenFor(rt, (await getConnection(w.ctx, COMPANY, id))!)).accessToken).toBe("SYSTEM-USER-TOKEN-0123456789");
    const stored = (await pg.client.query(`SELECT token_enc FROM ${w.ctx.db.namespace}.connections WHERE id = $1`, [id])).rows[0] as { token_enc: string | null };
    expect(stored.token_enc).toBeNull();
    await expect(tokenFor(w.rt({ platforms: { meta: { enabled: true } } }), (await getConnection(w.ctx, COMPANY, id))!)).rejects.toThrow(/no longer saved/);
  });

  it("never stores a token in the clear", async () => {
    const conn = await oauthConnection("google", 3_600_000);
    expect(conn.token_enc).toMatch(/^v1\./);
    expect(conn.token_enc).not.toContain("old-access");
    const dump = JSON.stringify((await pg.client.query(`SELECT * FROM ${w.ctx.db.namespace}.connections`)).rows);
    expect(dump).not.toContain("old-access");
  });
});

describe.skipIf(!available)("summaries", () => {
  it("groups by platform, campaign and day, derives the ratios and keeps currencies apart", async () => {
    await pg.reset();
    const w = await world(pg);
    const a = await w.account({ externalId: "ext-1", currency: "ZAR" });
    w.mock.campaigns["ext-1"] = [campaign("c1")];
    w.mock.insightRows["ext-1"] = [row("c1", "2026-10-13", 10_000, { clicks: 100, conversions: 4, valueMinor: 40_000 }), row("c1", "2026-10-14", 5000, { clicks: 50, conversions: 1, valueMinor: 10_000 })];
    await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, a.accountId))!);
    // A second scope in dollars.
    await w.harness.emit("plugin.partnersinbiz.crm.company.upserted", { id: "usa", name: "US Client", domain: null, lifecycle: null, updatedAt: "2026-10-01T00:00:00Z" }, { companyId: COMPANY });
    const b = await w.account({ scope: "company:usa", currency: "USD", externalId: "ext-us" });
    w.mock.campaigns["ext-us"] = [campaign("u1")];
    w.mock.insightRows["ext-us"] = [row("u1", "2026-10-14", 7000, { clicks: 70, conversions: 2, valueMinor: 14_000 })];
    await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, b.accountId))!);

    const all = await summaryRecord(w.rt(), { period: "last_7d", groupBy: "platform" });
    expect(all.totals.map((t) => t.currency).sort()).toEqual(["USD", "ZAR"]);
    expect(all.totals.find((t) => t.currency === "ZAR")).toMatchObject({ spendMinor: 15_000, clicks: 150, conversions: 5, cpa: "ZAR 30.00", roas: 3.33 });
    expect(all.note).toMatch(/never added together/);
    const own = await summaryRecord(w.rt(), { period: "last_7d", groupBy: "day", client: "own" });
    expect(own.groups.map((g) => [g.key, g.spendMinor])).toEqual([["2026-10-13", 10_000], ["2026-10-14", 5000]]);
    const byCampaign = await summaryRecord(w.rt(), { period: "last_7d", groupBy: "campaign", client: "company:usa" });
    expect(byCampaign.groups).toMatchObject([{ label: "Campaign u1", spendMinor: 7000, cpc: "USD 1.00" }]);
    expect((await summaryRecord(w.rt(), { period: "last_7d", groupBy: "platform", client: "company:nobody" })).hasData).toBe(false);
    await expect(summaryRecord(w.rt(), { period: "last_7d", since: "2026-10-01", until: "2025-01-01" })).rejects.toThrow(/before since/);
  });
});
