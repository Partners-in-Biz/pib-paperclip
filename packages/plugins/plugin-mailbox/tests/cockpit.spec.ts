import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { HANDOFF_EVENTS, trackJob, type CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { accountHealth, cockpitSnapshot, COCKPIT_SYNC_STALE_MS, pluginLabel } from "../src/cockpit.js";
import { isLeadCandidate, leadCapturedFrom, syncAccount, type SyncStats } from "../src/gmail/sync.js";
import { CO } from "./helpers/memory.js";
import { setup } from "./helpers/setup.js";
import { validateParams, validateRuntimeQuery } from "./helpers/sql-guard.js";

const NOW = Date.parse("2026-09-26T10:00:00Z");
const FULL = {
  publicBaseUrl: "https://paperclip.example.com",
  encryptionKey: { type: "secret_ref", secretId: "sec-enc" },
  google: { clientId: "client-id", clientSecret: { type: "secret_ref", secretId: "sec-google" } },
};

interface Data {
  counts?: Record<string, string | null>;
  accounts?: Array<Record<string, unknown>>;
  sends?: Array<Record<string, unknown>>;
  decisions?: Array<Record<string, unknown>>;
  fail?: RegExp;
}

/** Guarded fake db answering the cockpit's SELECTs. */
function cockpitDb(data: Data) {
  const sql: string[] = [];
  return {
    sql,
    db: {
      namespace: NAMESPACE,
      async query(text: string, params: unknown[] = []) {
        validateRuntimeQuery(text, NAMESPACE);
        validateParams(text, params);
        sql.push(text);
        if (data.fail?.test(text)) throw new Error("boom");
        if (/SELECT DISTINCT company_id FROM/.test(text)) return [{ company_id: CO }];
        if (text.includes("AS needs_reply")) return data.counts ? [data.counts] : [];
        if (text.includes(`FROM ${NAMESPACE}.accounts WHERE company_id = $1 AND status IN`)) return data.accounts ?? [];
        if (text.includes(`FROM ${NAMESPACE}.send_requests`) && text.includes("ORDER BY sent_at DESC")) return data.sends ?? [];
        if (text.includes(`FROM ${NAMESPACE}.decisions`)) return data.decisions ?? [];
        return [];
      },
      async execute() {
        return { rowCount: 0 };
      },
    },
  };
}

const COUNTS = {
  needs_reply: "3",
  sent_today: "2",
  sent_7d: "9",
  failed_7d: "1",
  failed_24h: "1",
  retrying_stuck: "0",
  oldest_failed: "2026-09-26T08:00:00Z",
  triaged_24h: "12",
  last_triaged_at: "2026-09-26T09:58:00Z",
};

async function boot(data: Data, config: Record<string, unknown> = FULL) {
  const harness = createTestHarness({ manifest, config });
  const fake = cockpitDb(data);
  (harness.ctx as unknown as { db: typeof fake.db }).db = fake.db;
  await plugin.definition.setup(harness.ctx);
  const emit = vi.spyOn(harness.ctx.events, "emit");
  return { harness, emit, sql: fake.sql };
}

const check = (snap: CockpitSnapshot, key: string) => snap.health.find((h) => h.key === key)!;

describe("Mailbox cockpit snapshot", () => {
  it("unconfigured company: zero KPIs, only job checks, nothing waiting", async () => {
    const { harness } = await boot({ counts: { needs_reply: "0", sent_today: "0", sent_7d: "0", failed_7d: "0", failed_24h: "0", retrying_stuck: "0", oldest_failed: null, triaged_24h: "0", last_triaged_at: null } }, {});
    const snap = await cockpitSnapshot(harness.ctx, CO, NOW);
    expect(snap).toMatchObject({ plugin: "partnersinbiz.mailbox", title: "Mailbox", waiting: [], activity: [] });
    expect(snap.kpis.map((k) => [k.key, k.raw, k.tone])).toEqual([
      ["mail_needs_reply", 0, "ok"],
      ["mail_sent_today", 0, "neutral"],
      ["mail_sent_7d", 0, "neutral"],
      ["mail_send_failures", 0, "ok"],
    ]);
    expect(snap.health.map((h) => [h.key, h.status])).toEqual([
      ["mailbox:send-queue", "ok"],
      ["job:sync-mailbox", "ok"],
      ["job:setup-status", "ok"],
    ]);
  });

  it("configured company: KPIs, per-account health, reconnect waiting, activity and quality", async () => {
    const { harness, sql } = await boot({
      counts: COUNTS,
      accounts: [
        { id: "acc-1", address: "peet@partnersinbiz.online", status: "connected", last_sync_at: new Date(NOW - 60_000).toISOString(), last_error: null, alert_issue_id: null, connected_at: "2026-09-01T00:00:00Z", updated_at: null },
        { id: "acc-2", address: "ops@partnersinbiz.online", status: "needs_reconnect", last_sync_at: null, last_error: "invalid_grant", alert_issue_id: "iss-9", connected_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-26T07:00:00Z" },
      ],
      sends: [
        { source_plugin: "partnersinbiz.billing", subject: "Invoice INV-7", sent_at: "2026-09-26T09:00:00Z" },
        { source_plugin: "partnersinbiz.mailbox", subject: "Re: hello", sent_at: "2026-09-26T08:00:00Z" },
      ],
      decisions: [{ purpose: "mail-triage", question_key: "category", total: "40", corrected: "6", avg_confidence: "0.8" }],
    });
    const snap = await cockpitSnapshot(harness.ctx, CO, NOW);
    expect(snap.kpis.find((k) => k.key === "mail_needs_reply")).toMatchObject({ value: "3", tone: "warn", href: "/mailbox", group: "delivery" });
    expect(snap.kpis.find((k) => k.key === "mail_send_failures")).toMatchObject({ raw: 1, tone: "bad" });
    expect(check(snap, "mailbox:sync:acc-1").status).toBe("ok");
    expect(check(snap, "mailbox:sync:acc-2")).toMatchObject({ status: "bad", detail: "Needs reconnecting. invalid_grant" });
    expect(check(snap, "mailbox:send-queue")).toMatchObject({ status: "bad", since: "2026-09-26T08:00:00Z" });
    expect(snap.waiting).toEqual([expect.objectContaining({ key: "mailbox:reconnect:acc-2", issueId: "iss-9", kind: "grant" })]);
    expect(snap.activity.map((a) => a.text)).toEqual(["Triaged 12 new messages in the last day", 'Sent "Invoice INV-7" for Billing', 'Sent "Re: hello"']);
    expect(snap.quality.find((q) => q.key === "triage_corrected_rate")).toMatchObject({ value: "15% (6 of 40)", raw: 0.15, tone: "warn" });
    expect(snap.quality.find((q) => q.key === "send_failures")).toMatchObject({ value: "1 of 10", tone: "bad" });
    expect(sql.length).toBeLessThanOrEqual(5);
  });

  it("one failing query does not break the snapshot", async () => {
    const { harness } = await boot({ counts: COUNTS, accounts: [], fail: /AS needs_reply/ });
    const snap = await cockpitSnapshot(harness.ctx, CO, NOW);
    expect(snap.kpis).toEqual([]);
    expect(snap.health.map((h) => h.key)).toEqual(["job:sync-mailbox", "job:setup-status"]);
  });

  it("a connected account with no sync for over 30 minutes is bad; a recent error is a warning", () => {
    const base = { id: "a", address: "a@b.co", status: "connected", alert_issue_id: null, connected_at: "2026-09-01T00:00:00Z", updated_at: null };
    expect(accountHealth({ ...base, last_sync_at: new Date(NOW - COCKPIT_SYNC_STALE_MS - 60_000).toISOString(), last_error: "Gmail 500" }, NOW)).toMatchObject({ status: "bad", detail: "Last sync 31 minutes ago. Last error: Gmail 500" });
    expect(accountHealth({ ...base, last_sync_at: new Date(NOW - 60_000).toISOString(), last_error: "Gmail 500" }, NOW)).toMatchObject({ status: "warn" });
    expect(accountHealth({ ...base, connected_at: new Date(NOW - 60_000).toISOString(), last_sync_at: null, last_error: null }, NOW).status).toBe("ok");
    expect(accountHealth({ ...base, last_sync_at: null, last_error: null }, NOW).status).toBe("bad");
  });

  it("the sync job's failures show up as job health", async () => {
    const { harness } = await boot({ counts: COUNTS });
    for (let i = 0; i < 3; i += 1) await trackJob(harness.ctx, "sync-mailbox", async () => { throw new Error("gmail down"); }).catch(() => undefined);
    const snap = await cockpitSnapshot(harness.ctx, CO, NOW);
    expect(check(snap, "job:sync-mailbox")).toMatchObject({ status: "bad", detail: "Last error: gmail down" });
  });

  it("serves GET /cockpit and pushes the snapshot from the hourly job", async () => {
    await boot({ counts: COUNTS });
    const response = await plugin.definition.onApiRequest!({
      routeKey: "cockpit", method: "GET", path: "/cockpit", params: {}, query: { companyId: CO }, body: null,
      actor: { actorType: "user", actorId: "local-board", userId: "local-board" }, companyId: CO, headers: {},
    });
    expect(response.status).toBe(200);
    expect((response.body as CockpitSnapshot).plugin).toBe("partnersinbiz.mailbox");
    const { harness, emit: emit2 } = await boot({ counts: COUNTS });
    await harness.runJob("setup-status");
    expect(emit2).toHaveBeenCalledWith("cockpit.snapshot", CO, expect.objectContaining({ plugin: "partnersinbiz.mailbox" }));
  });

  it("skips the push when the settings were never saved", async () => {
    const { harness, emit } = await boot({ counts: COUNTS }, {});
    await harness.runJob("setup-status");
    expect(emit).not.toHaveBeenCalledWith("cockpit.snapshot", expect.anything(), expect.anything());
  });

  it("labels source plugins", () => {
    expect(pluginLabel("partnersinbiz.billing")).toBe("Billing");
    expect(pluginLabel(null)).toBe("a plugin");
  });
});

describe("lead.captured hand-off", () => {
  const leads = (emitted: Array<{ name: string; companyId: string; payload: Record<string, unknown> }>) => emitted.filter((e) => e.name === HANDOFF_EVENTS.leadCaptured);

  it("emits a lead from a sender who is not a CRM contact, and re-emits it in the 30-minute window", async () => {
    const { gmail, env, account, loaded, run, host } = setup();
    gmail.addMessage({ id: "m1", headers: { From: "Ann Smith <Ann@newco.co.za>", To: "peet@partnersinbiz.online", Subject: "Website quote?" }, snippet: "Can you quote us for a new site? ".repeat(20) });
    gmail.addMessage({ id: "m2", headers: { From: "news@list.co", To: "peet@partnersinbiz.online", Subject: "Weekly digest", "List-Unsubscribe": "<mailto:u@list.co>" }, snippet: "This week" });
    const stats = (await syncAccount(env, await loaded(), account, await run())) as SyncStats;
    expect(stats.leads).toBe(1);
    const [event] = leads(host.emitted);
    expect(event!.companyId).toBe(CO);
    expect(event!.payload).toMatchObject({ key: "mail:m1", source: "email", name: "Ann Smith", email: "ann@newco.co.za", clientKind: null, clientRef: null });
    expect(String(event!.payload.text).length).toBeLessThanOrEqual(300);
    expect(String(event!.payload.text)).toMatch(/^Website quote\?: Can you quote us/);

    await syncAccount(env, await loaded(), account, await run());
    expect(leads(host.emitted).map((e) => e.payload.key)).toEqual(["mail:m1", "mail:m1"]);
  });

  it("does not emit when the sender is already a CRM contact", async () => {
    const { gmail, env, account, loaded, run, host, store } = setup();
    store.crm.push({ kind: "contact", id: "c1", name: "Ann", domain: null, emails: ["ann@newco.co.za"], accountIds: [] });
    gmail.addMessage({ id: "m1", headers: { From: "Ann <ann@newco.co.za>", To: "peet@partnersinbiz.online", Subject: "Website quote?" }, snippet: "Can you quote us?" });
    await syncAccount(env, await loaded(), account, await run());
    expect(leads(host.emitted)).toEqual([]);
  });

  it("only real leads qualify", () => {
    const row = {
      id: "r", direction: "inbound", gmail_message_id: "g1", category: "lead", bulk: false, bounce: null, phishing: null,
      from_addr: { email: "x@y.co", name: null }, subject: "Hi", snippet: "", received_at: "2026-09-26T09:00:00Z", created_at: "2026-09-26T09:00:00Z",
      triage: { category: "lead", phishing: 0.95, clientKind: "company", clientRef: "co-9", confidence: 0.8 },
    } as unknown as Parameters<typeof isLeadCandidate>[0];
    expect(isLeadCandidate(row)).toBe(false);
    const safe = { ...row, triage: { ...(row.triage as object), phishing: 0.1 } } as typeof row;
    expect(isLeadCandidate(safe)).toBe(true);
    expect(leadCapturedFrom(safe)).toMatchObject({ key: "mail:g1", clientKind: "company", clientRef: "co-9", confidence: 0.8, text: "Hi", capturedAt: "2026-09-26T09:00:00Z" });
  });
});
