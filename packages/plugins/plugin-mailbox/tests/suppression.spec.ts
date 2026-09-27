import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { HANDOFF_EVENTS, MAIL_EVENTS, pluginEvent, PIB_PLUGINS, type MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import { handleSendRequested, normaliseRequest } from "../src/gmail/send.js";
import { syncAccount, type SyncStats } from "../src/gmail/sync.js";
import { firstLine, isOptOutRequest, onContactSuppressed, reannounceSuppressions, REANNOUNCE_HOURS } from "../src/suppression.js";
import { SqlStore } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { CO } from "./helpers/memory.js";
import { setup } from "./helpers/setup.js";
import { validateParams, validateRuntimeExecute } from "./helpers/sql-guard.js";

const CAMPAIGNS = pluginEvent(PIB_PLUGINS.campaigns, MAIL_EVENTS.sendRequested);
const BILLING = pluginEvent(PIB_PLUGINS.billing, MAIL_EVENTS.sendRequested);

function request(overrides: Partial<MailSendRequested> = {}): MailSendRequested {
  return {
    key: "campaigns:step:e1:1",
    to: [{ email: "ann@client.co.za", name: "Ann" }],
    subject: "Spring offer",
    text: "Hi Ann. Reply STOP to stop these emails.",
    context: { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "e1" },
    marketing: true,
    ...overrides,
  };
}

function event(payload: unknown, eventType: string): PluginEvent {
  return { eventId: crypto.randomUUID(), eventType: eventType as PluginEvent["eventType"], occurredAt: new Date().toISOString(), companyId: CO, payload };
}

const announced = (emitted: Array<{ name: string; payload: Record<string, unknown> }>) => emitted.filter((e) => e.name === HANDOFF_EVENTS.contactSuppressed).map((e) => e.payload);

describe("sending respects the do-not-email list", () => {
  it("a marketing send to an unsubscribed address fails for good, lists it, and never reaches Gmail", async () => {
    const { env, gmail, store, host } = setup();
    store.addSuppression(CO, "ann@client.co.za", "marketing");
    const result = await handleSendRequested(env, event(request(), CAMPAIGNS));
    expect(result).toMatchObject({ status: "failed", permanent: true, suppressed: [{ email: "ann@client.co.za", scope: "marketing", reason: "unsubscribed" }] });
    expect(result!.error).toBe("Not sent: ann@client.co.za unsubscribed from marketing email. Marketing email never goes to a suppressed address.");
    expect(gmail.sent).toHaveLength(0);
    expect(store.sends.get(request().key)).toMatchObject({ status: "failed", permanent: true, skipped: [{ email: "ann@client.co.za" }] });
    expect(host.emitted.find((e) => e.name === MAIL_EVENTS.sendResult)!.payload).toMatchObject({ status: "failed", suppressed: [{ email: "ann@client.co.za" }] });
  });

  it("transactional mail still goes to a marketing opt-out, but never to a hard bounce", async () => {
    const { env, gmail, store } = setup();
    store.addSuppression(CO, "ann@client.co.za", "marketing");
    const invoice = request({ key: "billing:invoice:1:send", marketing: undefined, context: { plugin: PIB_PLUGINS.billing, kind: "invoice", id: "1" } });
    expect(await handleSendRequested(env, event(invoice, BILLING))).toMatchObject({ status: "sent" });
    store.addSuppression(CO, "gone@client.co.za", "all");
    const bounced = await handleSendRequested(env, event({ ...invoice, key: "billing:invoice:2:send", to: [{ email: "gone@client.co.za" }] }, BILLING));
    expect(bounced).toMatchObject({ status: "failed", permanent: true });
    expect(bounced!.error).toMatch(/gone@client\.co\.za bounced before .* Correct the address in the CRM/);
    expect(gmail.sent).toHaveLength(1);
  });

  it("leaves a suppressed copy out and sends to the rest, recording who was skipped", async () => {
    const { env, gmail, store } = setup();
    store.addSuppression(CO, "old@client.co.za", "all");
    const result = await handleSendRequested(env, event(request({ key: "billing:quote:1:send", marketing: false, cc: [{ email: "old@client.co.za" }], context: { plugin: PIB_PLUGINS.billing, kind: "quote", id: "1" } }), BILLING));
    expect(result).toMatchObject({ status: "sent", suppressed: [{ email: "old@client.co.za", scope: "all" }] });
    expect(gmail.sent[0]!.mime).not.toContain("old@client.co.za");
    expect(gmail.sent[0]!.mime).toContain("To: Ann <ann@client.co.za>");
    expect(store.sends.get("billing:quote:1:send")).toMatchObject({ status: "sent", skipped: [{ email: "old@client.co.za", scope: "all", reason: "bounced" }] });
  });

  it("marketing mail carries List-Unsubscribe to the sending account; transactional mail does not", async () => {
    const { env, gmail } = setup();
    await handleSendRequested(env, event(request(), CAMPAIGNS));
    expect(gmail.sent[0]!.mime).toContain("List-Unsubscribe: <mailto:peet@partnersinbiz.online?subject=unsubscribe>");
    await handleSendRequested(env, event(request({ key: "billing:invoice:9:send", marketing: undefined, context: { plugin: PIB_PLUGINS.billing, kind: "invoice", id: "9" } }), BILLING));
    expect(gmail.sent[1]!.mime).not.toContain("List-Unsubscribe");
  });

  it("keeps the marketing flag when it cleans a request", () => {
    expect(normaliseRequest({ ...request(), marketing: true }, "x")!.request.marketing).toBe(true);
    expect(normaliseRequest({ ...request(), marketing: "yes" }, "x")!.request.marketing).toBe(false);
  });
});

describe("opt-out messages", () => {
  it("reads the first line from a snippet and matches only a plain stop or unsubscribe", () => {
    expect(firstLine("STOP On Sat, 27 Sep 2026 at 10:00, Partners in Biz &lt;peet@partnersinbiz.online&gt; wrote: &gt; Hi")).toBe("STOP");
    expect(firstLine("Unsubscribe me please -- Ann")).toBe("Unsubscribe me please");
    expect(isOptOutRequest("Re: Spring offer", "Stop On Mon, 1 Sep 2026 Peet wrote: > Hi")).toBe(true);
    expect(isOptOutRequest("unsubscribe", "This message was automatically generated by Gmail.")).toBe(true);
    expect(isOptOutRequest("Re: unsubscribe", "")).toBe(true);
    expect(isOptOutRequest("Re: Spring offer", "Please unsubscribe")).toBe(true);
    expect(isOptOutRequest("Re: Spring offer", "Stop by our shop tomorrow for coffee")).toBe(false);
    expect(isOptOutRequest("Stop the press", "We have news")).toBe(false);
    expect(isOptOutRequest("Re: Spring offer", "Thanks, keep me posted")).toBe(false);
  });

  it("a STOP reply puts the sender on the list for marketing and tells the CRM and Campaigns", async () => {
    const { gmail, env, account, loaded, run, store, host } = setup();
    gmail.addMessage({ id: "s1", headers: { From: "Ann <Ann@Client.co.za>", Subject: "Re: Spring offer" }, snippet: "STOP On Sat, 27 Sep 2026 at 10:00, Peet wrote: &gt; Hi Ann" });
    gmail.addMessage({ id: "s2", headers: { From: "bob@client.co.za", Subject: "Re: Spring offer" }, snippet: "Stop by our office on Friday" });
    const stats = (await syncAccount(env, await loaded(), account, await run())) as SyncStats;
    expect(stats.suppressed).toBe(1);
    expect([...store.suppressions.values()]).toEqual([expect.objectContaining({ email: "ann@client.co.za", scope: "marketing", reason: "unsubscribed", source: "partnersinbiz.mailbox" })]);
    expect(announced(host.emitted)).toEqual([expect.objectContaining({ key: "suppress:ann@client.co.za:unsubscribed", email: "ann@client.co.za", reason: "unsubscribed", scope: "marketing", source: "partnersinbiz.mailbox" })]);
  });
});

describe("hard bounces", () => {
  function sentTo(store: ReturnType<typeof setup>["store"], key: string, email: string, rfc: string) {
    store.sends.set(key, {
      key, company_id: CO, source_plugin: PIB_PLUGINS.billing, account_id: "acc-1", from_address: "peet@partnersinbiz.online", to_addrs: [{ email }], subject: "Invoice",
      status: "sent", permanent: false, attempts: 1, gmail_message_id: `g-${key}`, gmail_thread_id: `t-${key}`, rfc_message_id: rfc, error: null,
      context: { plugin: PIB_PLUGINS.billing, kind: "invoice", id: key }, request: { key, to: [{ email }], subject: "Invoice", context: { plugin: PIB_PLUGINS.billing, kind: "invoice", id: key } },
      claimed_at: null, sent_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  }

  it("suppress an address we emailed for all mail; delay notices and strangers do not", async () => {
    const { gmail, env, account, loaded, run, store, host } = setup();
    sentTo(store, "inv-1", "gone@prospect.com", "<pib.inv1@partnersinbiz.online>");
    sentTo(store, "inv-2", "slow@prospect.com", "<pib.inv2@partnersinbiz.online>");
    gmail.addMessage({ id: "b1", headers: { From: "postmaster@outlook.com", Subject: "Undeliverable: Invoice", "X-Failed-Recipients": "Gone@Prospect.com" } });
    gmail.addMessage({ id: "b2", headers: { From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", Subject: "Delivery Status Notification (Delay)", "X-Failed-Recipients": "slow@prospect.com" } });
    gmail.addMessage({ id: "b3", headers: { From: "mailer-daemon@googlemail.com", Subject: "Delivery Status Notification (Failure)", "X-Failed-Recipients": "stranger@x.com" } });
    sentTo(store, "inv-3", "full@prospect.com", "<pib.inv3@partnersinbiz.online>");
    gmail.addMessage({ id: "b4", headers: { From: "mailer-daemon@googlemail.com", Subject: "Delivery Status Notification (Failure)", "X-Failed-Recipients": "full@prospect.com" }, snippet: "The recipient's inbox is out of storage space." });
    await syncAccount(env, await loaded(), account, await run());
    expect([...store.suppressions.values()].map((row) => [row.email, row.scope, row.reason])).toEqual([["gone@prospect.com", "all", "bounced"]]);
    expect(announced(host.emitted)).toEqual([expect.objectContaining({ email: "gone@prospect.com", reason: "bounced", scope: "all" })]);
  });

  it("without X-Failed-Recipients, uses the one recipient of the bounced message", async () => {
    const { gmail, env, account, loaded, run, store } = setup();
    sentTo(store, "seq-9", "lead@prospect.com", "<pib.seq@partnersinbiz.online>");
    gmail.addMessage({
      id: "dsn1",
      headers: { From: "Mail Delivery System <MAILER-DAEMON@mx.remote.net>", Subject: "Undelivered Mail Returned to Sender", "Content-Type": 'multipart/report; report-type=delivery-status; boundary="x"' },
      payload: { mimeType: "multipart/report", parts: [{ mimeType: "message/rfc822", parts: [{ mimeType: "text/plain", headers: { "Message-ID": "<pib.seq@partnersinbiz.online>" } }] }] },
    });
    await syncAccount(env, await loaded(), account, await run());
    expect([...store.suppressions.values()]).toEqual([expect.objectContaining({ email: "lead@prospect.com", scope: "all" })]);
  });
});

describe("the shared list", () => {
  it("stores contact.suppressed from the CRM and Campaigns, widening to all on a hard bounce", async () => {
    const { env, store } = setup();
    const crm = pluginEvent(PIB_PLUGINS.crm, HANDOFF_EVENTS.contactSuppressed);
    await onContactSuppressed(env, event({ email: " Ann@Client.co.za ", reason: "unsubscribed", scope: "marketing", source: "partnersinbiz.crm" }, crm));
    expect(store.suppressions.get(`${CO}:ann@client.co.za`)).toMatchObject({ scope: "marketing", reason: "unsubscribed", source: "partnersinbiz.crm" });
    await onContactSuppressed(env, event({ email: "ann@client.co.za", reason: "bounced" }, pluginEvent(PIB_PLUGINS.campaigns, HANDOFF_EVENTS.contactSuppressed)));
    expect(store.suppressions.get(`${CO}:ann@client.co.za`)).toMatchObject({ scope: "all", reason: "bounced", source: "partnersinbiz.campaigns" });
    await onContactSuppressed(env, event({ email: "nope", reason: "bounced" }, crm));
    await onContactSuppressed(env, event({ email: "x@y.co", reason: "because" }, crm));
    expect(store.suppressions.size).toBe(1);
  });

  it("announces the Mailbox's own finds from the last 3 days again", async () => {
    const now = Date.now();
    const { env, store, host } = setup();
    store.addSuppression(CO, "new@x.co", "marketing", "unsubscribed", "partnersinbiz.mailbox");
    store.addSuppression(CO, "crm@x.co", "marketing", "unsubscribed", "partnersinbiz.crm");
    store.suppressions.set(`${CO}:old@x.co`, { company_id: CO, email: "old@x.co", scope: "all", reason: "bounced", source: "partnersinbiz.mailbox", detail: null, created_at: new Date(now - (REANNOUNCE_HOURS + 1) * 3_600_000).toISOString(), updated_at: new Date(now - (REANNOUNCE_HOURS + 1) * 3_600_000).toISOString() });
    expect(await reannounceSuppressions(env, now)).toBe(1);
    expect(announced(host.emitted).map((payload) => payload.email)).toEqual(["new@x.co"]);
  });

  it("the widening UPDATE passes the host SQL guard", async () => {
    const statements: string[] = [];
    const store = new SqlStore({
      namespace: NAMESPACE,
      query: async () => [],
      execute: async (sql: string, params: unknown[] = []) => {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        statements.push(sql);
        return { rowCount: sql.trim().startsWith("INSERT") ? 0 : 1 };
      },
    });
    expect(await store.upsertSuppression({ companyId: CO, email: "A@b.co", scope: "all", reason: "bounced", source: "partnersinbiz.mailbox" })).toEqual({ created: false, widened: true, scope: "all" });
    expect(statements[1]).toContain("SET scope = 'all'");
  });
});
