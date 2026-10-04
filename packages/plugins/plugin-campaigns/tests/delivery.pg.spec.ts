/**
 * The 0.7.0 SQL against a real Postgres (embedded) with all fourteen migrations: the widened step event kinds, the delivery handler end to end
 * (once per send and kind, one suppression per address and sender, scoped stops), the per-step and per-campaign counts, and the lookup a reply
 * to a provider send is matched by (and that its index is the one the query uses).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { eventCounts, sendsToAddress, stepEventStats } from "../src/db.js";
import { asCampaignDelivery, handleDelivery } from "../src/delivery.js";
import { matchByReplyTo } from "../src/mail.js";
import { NAMESPACE } from "../src/namespace.js";
import { eventTotals } from "../src/series.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const CO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TEAM = "team@client.co.za";

describe.skipIf(!available)("campaigns 0.7.0 SQL (postgres)", () => {
  let h: PgHarness;
  let ctx: PluginContext;

  beforeAll(async () => {
    h = await startPg();
    ctx = h.ctx;
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });
  beforeEach(async () => {
    await h.reset();
    await q(`INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, emails, updated_at) VALUES ('ada', $1, 'Ada Lovelace', ARRAY['ada@acme.test'], now())`, [CO]);
    await campaign("camp-client", "company", "acme");
    await campaign("camp-own", null, null);
    await enroll("e-client", "camp-client");
    await enroll("e-own", "camp-own");
    for (const id of ["e-client", "e-own"]) await sent(id, { to: "ada@acme.test" });
  });

  const q = (sql: string, params: unknown[] = []) => h.client.query(sql, params);
  const rows = async (table: string) => (await q(`SELECT * FROM ${NAMESPACE}.${table} ORDER BY 1, 2`)).rows as Array<Record<string, any>>;
  const campaign = (id: string, kind: string | null, ref: string | null) =>
    q(`INSERT INTO ${NAMESPACE}.campaigns (id, company_id, name, status, client_kind, client_ref, client_name) VALUES ($1, $2, $1, 'active', $3, $4, $4)`, [id, CO, kind, ref]);
  const enroll = (id: string, campaignId: string) =>
    q(`INSERT INTO ${NAMESPACE}.campaign_enrollments (id, company_id, campaign_id, contact_id, status, step_position, next_due_at) VALUES ($1, $2, $3, 'ada', 'running', 1, now() + interval '3 days')`, [id, CO, campaignId]);
  const sent = (enrollmentId: string, over: { to?: string; replyTo?: string | null; subject?: string; at?: string; company?: string; position?: number } = {}) => {
    const position = over.position ?? 1;
    const key = `campaigns:step:${enrollmentId}:${position}`;
    const campaignId = enrollmentId === "e-own" ? "camp-own" : "camp-client";
    return q(
      `INSERT INTO ${NAMESPACE}.campaign_step_events (id, company_id, campaign_id, enrollment_id, step_position, event_type, variant, source_key, meta, occurred_at)
       VALUES ($1, $2, $3, $4, $5, 'sent', 'a', $6, $7::jsonb, $8::timestamptz)`,
      [`sent-${enrollmentId}-${position}-${over.company ?? "co"}`, over.company ?? CO, campaignId, enrollmentId, position, `sent:${key}:${over.company ?? "co"}`, JSON.stringify({ to: over.to ?? "ada@acme.test", key, ...(over.replyTo === null ? {} : { replyTo: over.replyTo ?? TEAM }), subject: over.subject ?? "Hi Ada", provider: "resend" }), over.at ?? "2026-10-01T08:00:00Z"],
    );
  };

  const delivery = (enrollmentId: string, type: string, over: Record<string, unknown> = {}) =>
    asCampaignDelivery({
      key: `esp:${type}-${enrollmentId}`, type, provider: "resend", sendKey: `campaigns:step:${enrollmentId}:1`, recipient: "ada@acme.test", at: "2026-10-04T09:00:00Z",
      context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: enrollmentId }, ...(type === "bounced" ? { bounce: { kind: "hard", subType: "General" } } : {}), ...over,
    })!;
  const handle = (enrollmentId: string, type: string, over: Record<string, unknown> = {}) => handleDelivery(ctx, CO, delivery(enrollmentId, type, over));

  it("migration 014 allows the two new kinds, keeps every old one and still refuses a kind it does not know", async () => {
    const insert = (type: string, n: number) =>
      q(`INSERT INTO ${NAMESPACE}.campaign_step_events (id, company_id, campaign_id, enrollment_id, step_position, event_type) VALUES ($1, $2, 'camp-client', 'e-client', 1, $3)`, [`kind-${n}`, CO, type]);
    let n = 0;
    for (const type of ["open", "click", "sent", "reply", "bounce", "unsubscribe", "skipped", "delivered", "failed", "soft_bounce", "complaint"]) await insert(type, n++);
    await expect(insert("teleported", n++)).rejects.toThrow();
  });

  it("a delivery, an open and a click each become one step event however often they are reported", async () => {
    expect(await handle("e-client", "delivered")).toMatchObject({ matched: true, recorded: true });
    expect(await handle("e-client", "delivered")).toMatchObject({ recorded: false });
    expect(await handle("e-client", "delivered", { key: "esp:another" })).toMatchObject({ recorded: false });
    for (const key of ["esp:o1", "esp:o2", "esp:o3"]) await handle("e-client", "opened", { key });
    for (const key of ["esp:c1", "esp:c2"]) await handle("e-client", "clicked", { key });
    const kinds = (await rows("campaign_step_events")).filter((row) => row.event_type !== "sent").map((row) => row.event_type).sort();
    expect(kinds).toEqual(["click", "delivered", "open"]);
    expect((await rows("campaign_step_events")).find((row) => row.event_type === "delivered")!.meta).toMatchObject({ sendKey: "campaigns:step:e-client:1", provider: "resend", to: "ada@acme.test" });
  });

  it("a hard bounce is one suppression for every sender with its reason, however often it is reported, and stops the contact's campaigns", async () => {
    expect(await handle("e-client", "bounced")).toMatchObject({ recorded: true, suppressed: true });
    expect(await handle("e-client", "bounced")).toMatchObject({ recorded: false, suppressed: false });
    expect(await handle("e-client", "bounced", { key: "esp:again" })).toMatchObject({ recorded: false, suppressed: false });
    expect(await rows("suppressions")).toEqual([expect.objectContaining({ company_id: CO, email: "ada@acme.test", reason: "bounce", scope: "all", sender_key: "", source: "partnersinbiz.mailbox", contact_id: "ada", campaign_id: "camp-client" })]);
    expect((await rows("campaign_enrollments")).map((row) => row.status)).toEqual(["stopped", "stopped"]);
    expect((await rows("campaign_step_events")).filter((row) => row.event_type === "bounce")).toHaveLength(1);
  });

  it("a complaint is the client's list only and stops only that client's campaigns", async () => {
    expect(await handle("e-client", "complained")).toMatchObject({ recorded: true, suppressed: true });
    expect(await handle("e-client", "complained", { key: "esp:again" })).toMatchObject({ recorded: false, suppressed: false });
    expect(await rows("suppressions")).toEqual([expect.objectContaining({ email: "ada@acme.test", reason: "complaint", scope: "marketing", sender_key: "company:acme" })]);
    const status = Object.fromEntries((await rows("campaign_enrollments")).map((row) => [row.id, row.status]));
    expect(status).toEqual({ "e-client": "stopped", "e-own": "running" });
    // PiB's own campaign for the same person is its own list: a complaint about it adds a second row, not a second one for the client.
    expect(await handle("e-own", "complained")).toMatchObject({ suppressed: true });
    expect((await rows("suppressions")).map((row) => row.sender_key).sort()).toEqual(["company:acme", "own"]);
  });

  it("a soft bounce is counted apart and suppresses nobody", async () => {
    expect(await handle("e-client", "soft_bounced", { bounce: { kind: "soft", subType: "MailboxFull" } })).toMatchObject({ event: "soft_bounce", recorded: true, suppressed: false });
    expect(await rows("suppressions")).toEqual([]);
  });

  it("the per-step and per-campaign counts carry delivered, hard and soft bounces, complaints, opens and clicks", async () => {
    await handle("e-client", "delivered");
    await handle("e-client", "opened");
    await handle("e-client", "clicked");
    await handle("e-own", "soft_bounced", { bounce: { kind: "soft", subType: "MailboxFull" } });
    await handle("e-own", "complained");
    await handle("e-own", "bounced", { key: "esp:own-bounce" });
    expect(await stepEventStats(ctx, "camp-client")).toEqual([{ stepPosition: 1, opens: 1, clicks: 1, sent: 1, delivered: 1, replies: 0, bounces: 0, softBounces: 0, complaints: 0, unsubscribes: 0 }]);
    expect(await stepEventStats(ctx, "camp-own")).toEqual([{ stepPosition: 1, opens: 0, clicks: 0, sent: 1, delivered: 0, replies: 0, bounces: 1, softBounces: 1, complaints: 1, unsubscribes: 0 }]);
    const totals = eventTotals(await eventCounts(ctx, CO));
    expect(totals["camp-client"]).toMatchObject({ sent: 1, delivered: 1, opens: 1, clicks: 1, bounces: 0, complaints: 0, softBounces: 0 });
    expect(totals["camp-own"]).toMatchObject({ sent: 1, delivered: 0, bounces: 1, complaints: 1, softBounces: 1 });
  });

  describe("finding the send a reply belongs to", () => {
    it("lists the emails sent to an address, case-insensitively, newest first, inside the window and for one company only", async () => {
      await sent("e-client", { position: 2, to: "ADA@acme.test", at: "2026-10-02T08:00:00Z" });
      await sent("e-client", { to: "ada@acme.test", company: OTHER });
      await sent("e-client", { position: 3, to: "bob@beta.test" });
      await q(`INSERT INTO ${NAMESPACE}.campaign_step_events (id, company_id, campaign_id, enrollment_id, step_position, event_type, meta, occurred_at) VALUES ('not-a-send', $1, 'camp-client', 'e-client', 1, 'delivered', '{"to":"ada@acme.test"}'::jsonb, '2026-10-03T08:00:00Z')`, [CO]);
      const found = await sendsToAddress(ctx, CO, " Ada@Acme.test ", "2026-09-01T00:00:00Z");
      const names = found.map((send) => `${send.enrollmentId}:${send.stepPosition}`);
      // The newest first; the two of the first of October share a time, so their order is not asserted. Bob's, the other company's and the delivered event are not here.
      expect(names[0]).toBe("e-client:2");
      expect(names.slice(1).sort()).toEqual(["e-client:1", "e-own:1"]);
      expect(found.map((send) => send.occurredAt)).toEqual([...found.map((send) => send.occurredAt)].sort().reverse());
      expect(await sendsToAddress(ctx, CO, "ada@acme.test", "2026-10-02T00:00:00Z")).toHaveLength(1);
      expect(await sendsToAddress(ctx, OTHER, "ada@acme.test", "2026-09-01T00:00:00Z")).toHaveLength(1);
      expect(await sendsToAddress(ctx, CO, "nobody@x.test", "2026-09-01T00:00:00Z")).toEqual([]);
    });

    it("the Reply-To match reads those rows: the mailbox, the person and the subject pick the send, on real data", async () => {
      await q(`UPDATE ${NAMESPACE}.campaign_step_events SET meta = jsonb_set(meta, '{replyTo}', '"sales@other.co.za"') WHERE enrollment_id = 'e-own'`);
      const mail = (over: Record<string, unknown> = {}) => ({
        key: "mail:m-1", accountAddress: TEAM, messageId: "m-1", threadId: "t-1", from: { email: "ada@acme.test", name: "Ada" }, to: [{ email: TEAM }], subject: "Re: Hi Ada", snippet: "yes",
        receivedAt: "2026-10-02T09:00:00Z", attachments: [], triage: { category: "reply", urgency: null, needsReply: null, phishing: null, confidence: null }, replyTo: null, ...over,
      });
      const hit = await matchByReplyTo(ctx, CO, mail() as never);
      expect(hit?.enrollment.id).toBe("e-client");
      expect(hit?.sent.meta).toMatchObject({ key: "campaigns:step:e-client:1", replyTo: TEAM });
      // The other campaign's mailbox is another mailbox.
      expect((await matchByReplyTo(ctx, CO, mail({ accountAddress: "sales@other.co.za", to: [{ email: "sales@other.co.za" }] }) as never))?.enrollment.id).toBe("e-own");
      expect(await matchByReplyTo(ctx, CO, mail({ accountAddress: "nobody@x.test", to: [] }) as never)).toBeNull();
      expect(await matchByReplyTo(ctx, OTHER, mail() as never)).toBeNull();
    });

    it("the lookup is served by the 014 index (the partial expression index on the address of a sent event)", async () => {
      await q("SET enable_seqscan = off");
      const plan = ((await q(
        `EXPLAIN SELECT enrollment_id FROM ${NAMESPACE}.campaign_step_events WHERE company_id = $1 AND event_type = 'sent' AND lower(meta ->> 'to') = $2 AND occurred_at >= $3::timestamptz ORDER BY occurred_at DESC LIMIT 20`,
        [CO, "ada@acme.test", "2026-09-01T00:00:00Z"],
      )).rows as Array<Record<string, string>>).map((row) => Object.values(row)[0]).join("\n");
      await q("RESET enable_seqscan");
      expect(plan).toContain("step_events_sent_to");
    });
  });
});
