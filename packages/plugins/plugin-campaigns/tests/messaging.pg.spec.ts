/**
 * The 0.6 SQL against a real Postgres (embedded): the migration, the per-sender
 * suppression keys, the SMS and WhatsApp tables and the erasure statements, so
 * what the in-memory fake cannot judge (constraints, ON CONFLICT, array
 * parameters, regexp) is checked for real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  addChannelSuppression,
  addSuppression,
  addressHash,
  blockedAddresses,
  claimMessage,
  consentedAddresses,
  crmContactsByPhone,
  deleteSenderIdentity,
  getMessage,
  insertCampaign,
  insertStep,
  isSuppressed,
  liftChannelSuppression,
  listSenderIdentityRows,
  listSteps,
  messagesAwaitingStatus,
  stopEnrollmentsForSender,
  suppressedEmails,
  updateMessage,
  upsertConsent,
  upsertSenderIdentity,
} from "../src/db.js";
import { createCampaign } from "../src/domain.js";
import { eraseSubject } from "../src/privacy.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const CO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADA = "+27821234567";

describe.skipIf(!available)("campaigns 0.6 SQL (postgres)", () => {
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
  });

  const q = (sql: string, params: unknown[] = []) => h.client.query(sql, params);
  const rows = async (table: string) => (await q(`SELECT * FROM ${NAMESPACE}.${table} ORDER BY 1, 2`)).rows as Array<Record<string, any>>;
  const suppress = (email: string, senderKey: string, scope: "marketing" | "all" = "marketing", company = CO) =>
    addSuppression(ctx, { companyId: company, email, reason: scope === "all" ? "bounce" : "unsubscribe", scope, source: "partnersinbiz.campaigns", contactId: null, campaignId: null, senderKey });

  it("the migration moved the suppression key to (company, address, sender) and kept old rows on every list", async () => {
    // A row written the way 0.5 wrote it has no sender and takes the empty default.
    await q(`INSERT INTO ${NAMESPACE}.suppressions (company_id, email, reason, scope, source) VALUES ($1, 'old@acme.test', 'unsubscribe', 'marketing', 'partnersinbiz.crm')`, [CO]);
    expect((await rows("suppressions"))[0]).toMatchObject({ sender_key: "" });
    for (const sender of ["own", "company:acme"]) expect(await isSuppressed(ctx, CO, "old@acme.test", sender), sender).toBe(true);
    // The same address on two senders is two rows; the same sender twice is one.
    expect(await suppress("ada@acme.test", "company:acme")).toBe(true);
    expect(await suppress("ada@acme.test", "company:acme")).toBe(false);
    expect(await suppress("ada@acme.test", "own")).toBe(true);
    expect((await rows("suppressions")).filter((r) => r.email === "ada@acme.test")).toHaveLength(2);
  });

  it("applies each sender's list, a hard bounce to every sender, and never crosses companies", async () => {
    await suppress("ada@acme.test", "company:acme");
    await suppress("bob@beta.test", "company:acme", "all");
    await suppress("uma@x.test", "own", "marketing", OTHER);
    expect([...(await suppressedEmails(ctx, CO, ["ada@acme.test", "bob@beta.test", "uma@x.test"], "own"))]).toEqual(["bob@beta.test"]);
    expect([...(await suppressedEmails(ctx, CO, ["ada@acme.test", "bob@beta.test"], "company:acme"))].sort()).toEqual(["ada@acme.test", "bob@beta.test"]);
    // A bounce widens an existing marketing row for the address.
    await suppress("ada@acme.test", "company:beta", "all");
    expect((await rows("suppressions")).every((r) => r.email !== "ada@acme.test" || r.scope === "all")).toBe(true);
    expect(await isSuppressed(ctx, CO, "ada@acme.test", "own")).toBe(true);
  });

  it("a text number is blocked per sender and channel, and START lifts only the person's own opt-out", async () => {
    const add = (address: string, senderKey: string, reason: "stop_keyword" | "manual" | "invalid_number", scope: "marketing" | "all" = "marketing", channel: "sms" | "whatsapp" = "sms") =>
      addChannelSuppression(ctx, { companyId: CO, channel, address, senderKey, reason, scope, source: "partnersinbiz.campaigns" });
    expect(await add(ADA, "company:acme", "stop_keyword")).toBe(true);
    expect(await add(ADA, "company:acme", "stop_keyword")).toBe(false);
    expect(await add("+27835550001", "own", "invalid_number", "all")).toBe(true);
    expect(await add("+27835550002", "own", "manual")).toBe(true);
    expect([...(await blockedAddresses(ctx, CO, "sms", [ADA, "+27835550001"], "own"))]).toEqual(["+27835550001"]);
    expect([...(await blockedAddresses(ctx, CO, "sms", [ADA], "company:acme"))]).toEqual([ADA]);
    expect((await blockedAddresses(ctx, CO, "whatsapp", [ADA], "company:acme")).size).toBe(0);
    expect(await liftChannelSuppression(ctx, CO, "sms", ADA, "company:acme")).toBe(1);
    expect(await liftChannelSuppression(ctx, CO, "sms", "+27835550002", "own")).toBe(0);
    expect((await rows("channel_suppressions")).map((r) => r.address)).toEqual(["+27835550001", "+27835550002"]);
    // The table refuses a channel it does not know.
    await expect(q(`INSERT INTO ${NAMESPACE}.channel_suppressions (company_id, channel, address, reason, source) VALUES ($1, 'fax', 'x', 'manual', 'x')`, [CO])).rejects.toThrow();
  });

  it("consent: a granted opt-in counts for its sender and channel only, and an older record never overwrites a newer", async () => {
    const consent = (over: Record<string, unknown>) => upsertConsent(ctx, { companyId: CO, channel: "sms", address: ADA, senderKey: "own", granted: true, basis: "consent", source: "form", evidence: "form", recordedAt: "2026-10-02T08:00:00Z", ...over } as never);
    expect(await consent({})).toBe(true);
    expect(await consent({ recordedAt: "2026-10-01T08:00:00Z", granted: false })).toBe(false);
    expect([...(await consentedAddresses(ctx, CO, "sms", [ADA], "own"))]).toEqual([ADA]);
    expect((await consentedAddresses(ctx, CO, "sms", [ADA], "company:acme")).size).toBe(0);
    expect((await consentedAddresses(ctx, CO, "whatsapp", [ADA], "own")).size).toBe(0);
    expect(await consent({ recordedAt: "2026-10-03T08:00:00Z", granted: false })).toBe(true);
    expect((await consentedAddresses(ctx, CO, "sms", [ADA], "own")).size).toBe(0);
    await expect(q(`INSERT INTO ${NAMESPACE}.channel_consents (company_id, channel, address, granted, basis, source, recorded_at) VALUES ($1, 'carrier-pigeon', 'x', true, 'consent', 'x', now())`, [CO])).rejects.toThrow();
  });

  it("a message is claimed once per step, updated in place, and found when its status is awaited", async () => {
    const base = { key: "campaigns:msg:e1:1", company_id: CO, campaign_id: "c1", enrollment_id: "e1", step_position: 1, channel: "sms" as const, to_address: ADA, contact_id: "ada", sender_key: "own", body: "Hi", segments: 1 };
    expect(await claimMessage(ctx, base)).toBe(true);
    expect(await claimMessage(ctx, base)).toBe(false);
    expect(await getMessage(ctx, base.key)).toMatchObject({ status: "sending", attempts: 1, provider_id: null });
    await updateMessage(ctx, base.key, { status: "sent", provider_id: "SMabc", provider_status: "queued" });
    await updateMessage(ctx, base.key, { provider_status: "sent" });
    expect(await getMessage(ctx, base.key)).toMatchObject({ status: "sent", provider_id: "SMabc", provider_status: "sent", segments: 1 });
    expect((await messagesAwaitingStatus(ctx, CO, new Date(Date.now() - 86_400_000).toISOString())).map((m) => m.provider_id)).toEqual(["SMabc"]);
    expect(await messagesAwaitingStatus(ctx, OTHER, new Date(Date.now() - 86_400_000).toISOString())).toEqual([]);
    expect(await messagesAwaitingStatus(ctx, CO, new Date(Date.now() + 86_400_000).toISOString())).toEqual([]);
    await expect(q(`UPDATE ${NAMESPACE}.channel_messages SET status = 'teleported' WHERE key = $1`, [base.key])).rejects.toThrow();
  });

  it("awaiting-status messages come newest first, so ones a carrier never confirms cannot crowd out newer ones", async () => {
    const base = { company_id: CO, campaign_id: "c1", step_position: 1, channel: "sms" as const, contact_id: "ada", sender_key: "own", body: "Hi", segments: 1 };
    for (const [i, hours] of [[1, 60], [2, 30], [3, 5], [4, 1]] as const) {
      await claimMessage(ctx, { ...base, key: `campaigns:msg:e${i}:1`, enrollment_id: `e${i}`, to_address: ADA });
      await updateMessage(ctx, `campaigns:msg:e${i}:1`, { status: "sent", provider_id: `SM${i}` });
      await q(`UPDATE ${NAMESPACE}.channel_messages SET created_at = now() - ($2 || ' hours')::interval WHERE key = $1`, [`campaigns:msg:e${i}:1`, String(hours)]);
    }
    // A poll that touched the oldest ones recently (updated_at) must not put them first.
    await q(`UPDATE ${NAMESPACE}.channel_messages SET updated_at = now() + interval '1 minute' WHERE key = 'campaigns:msg:e4:1'`);
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect((await messagesAwaitingStatus(ctx, CO, since)).map((m) => m.provider_id)).toEqual(["SM4", "SM3", "SM2", "SM1"]);
    expect((await messagesAwaitingStatus(ctx, CO, since, 2)).map((m) => m.provider_id)).toEqual(["SM4", "SM3"]);
  });

  it("finds contacts by the last nine digits of a number written any way, as text[] arrays", async () => {
    await q(`INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, phones, updated_at) VALUES ('ada', $1, 'Ada', ARRAY['082 123 4567','011 000 0000'], now()), ('bob', $1, 'Bob', ARRAY['+27 83 555 0001'], now()), ('gone', $1, 'Gone', ARRAY['082 123 4567'], now()), ('other', $2, 'Other', ARRAY['082 123 4567'], now())`, [CO, OTHER]);
    await q(`UPDATE ${NAMESPACE}.crm_contacts SET deleted = true WHERE id = 'gone'`);
    expect((await crmContactsByPhone(ctx, CO, "821234567")).map((c) => c.id)).toEqual(["ada"]);
    expect((await crmContactsByPhone(ctx, CO, "835550001")).map((c) => c.id)).toEqual(["bob"]);
    expect(await crmContactsByPhone(ctx, CO, "999999999")).toEqual([]);
  });

  it("steps keep their channel and WhatsApp template, and delivery auto is accepted", async () => {
    const draft = createCampaign({ companyId: CO, name: "Texts", delivery: "auto" });
    await insertCampaign(ctx, draft);
    await insertStep(ctx, { companyId: CO, campaignId: draft.id, step: { position: 1, delayDays: 0, subject: "", body: "Hi {{first_name}}", htmlBody: null, variant: "a", channel: "whatsapp", templateRef: "HX0123456789abcdef0123456789abcdef", templateVars: ["{{first_name}}", "{{company}}"] } });
    await insertStep(ctx, { companyId: CO, campaignId: draft.id, step: { position: 2, delayDays: 1, subject: "Hello", body: "Email", htmlBody: null, variant: "a" } });
    expect(await listSteps(ctx, draft.id)).toEqual([
      expect.objectContaining({ position: 1, channel: "whatsapp", templateRef: "HX0123456789abcdef0123456789abcdef", templateVars: ["{{first_name}}", "{{company}}"] }),
      expect.objectContaining({ position: 2, channel: "email", templateRef: null, templateVars: [] }),
    ]);
    await expect(q(`UPDATE ${NAMESPACE}.campaign_steps SET channel = 'fax' WHERE campaign_id = $1`, [draft.id])).rejects.toThrow();
    await expect(q(`UPDATE ${NAMESPACE}.campaigns SET delivery = 'carrier' WHERE id = $1`, [draft.id])).rejects.toThrow();
    expect((await rows("campaigns"))[0]).toMatchObject({ delivery: "auto" });
  });

  it("step events accept skipped, delivered and failed", async () => {
    const draft = createCampaign({ companyId: CO, name: "x" });
    await insertCampaign(ctx, draft);
    await q(`INSERT INTO ${NAMESPACE}.campaign_enrollments (id, company_id, campaign_id, contact_id, status, step_position) VALUES ('e1', $1, $2, 'ada', 'running', 1)`, [CO, draft.id]);
    for (const type of ["skipped", "delivered", "failed"]) {
      await q(`INSERT INTO ${NAMESPACE}.campaign_step_events (id, company_id, campaign_id, enrollment_id, step_position, event_type) VALUES ($1, $2, $3, 'e1', 1, $4)`, [`ev-${type}`, CO, draft.id, type]);
    }
    await expect(q(`INSERT INTO ${NAMESPACE}.campaign_step_events (id, company_id, campaign_id, enrollment_id, step_position, event_type) VALUES ('bad', $1, $2, 'e1', 1, 'teleported')`, [CO, draft.id])).rejects.toThrow();
  });

  it("sender identities upsert in place and delete", async () => {
    const identity = { company_id: CO, sender_key: "company:acme", from_address: "hello@acme.test", from_name: "Acme", reply_to: null, sms_from: "+27820000001", whatsapp_from: null, updated_by: "agent:a" };
    await upsertSenderIdentity(ctx, identity);
    await upsertSenderIdentity(ctx, { ...identity, from_name: "Acme Plumbing", sms_from: null });
    expect(await listSenderIdentityRows(ctx, CO)).toEqual([expect.objectContaining({ from_name: "Acme Plumbing", sms_from: null, from_address: "hello@acme.test" })]);
    expect(await listSenderIdentityRows(ctx, OTHER)).toEqual([]);
    expect(await deleteSenderIdentity(ctx, CO, "company:acme")).toBe(true);
    expect(await deleteSenderIdentity(ctx, CO, "company:acme")).toBe(false);
  });

  it("stopping a sender's running campaigns for a contact leaves the other senders' running", async () => {
    const own = createCampaign({ companyId: CO, name: "own" });
    const acme = createCampaign({ companyId: CO, name: "acme", client: { kind: "company", id: "acme", name: "Acme" } });
    await insertCampaign(ctx, own);
    await insertCampaign(ctx, acme);
    for (const [id, campaignId] of [["e-own", own.id], ["e-acme", acme.id]] as const) {
      await q(`INSERT INTO ${NAMESPACE}.campaign_enrollments (id, company_id, campaign_id, contact_id, status, step_position, open_issue_id) VALUES ($1, $2, $3, 'ada', 'running', 1, $4)`, [id, CO, campaignId, `issue-${id}`]);
    }
    expect((await stopEnrollmentsForSender(ctx, CO, "ada", "company:acme")).map((r) => r.id)).toEqual(["e-acme"]);
    expect((await rows("campaign_enrollments")).map((r) => [r.id, r.status])).toEqual([["e-acme", "stopped"], ["e-own", "running"]]);
    expect((await stopEnrollmentsForSender(ctx, CO, "ada", "")).map((r) => r.id)).toEqual(["e-own"]);
  });

  it("erasure runs as real SQL: deletes the person's rows, hashes their opt-outs, blanks the contact copy, and leaves others alone", async () => {
    const draft = createCampaign({ companyId: CO, name: "x" });
    await insertCampaign(ctx, draft);
    await insertStep(ctx, { companyId: CO, campaignId: draft.id, step: { position: 1, delayDays: 0, subject: "Hi", body: "Hello", htmlBody: null, variant: "a" } });
    await q(`INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, emails, phones, tags, updated_at) VALUES ('ada', $1, 'Ada', ARRAY['ada@acme.test'], ARRAY['082 123 4567'], ARRAY['vip'], now()), ('bob', $1, 'Bob', ARRAY['bob@beta.test'], ARRAY['083 555 0001'], ARRAY['vip'], now())`, [CO]);
    for (const [e, c] of [["e-ada", "ada"], ["e-bob", "bob"]]) {
      await q(`INSERT INTO ${NAMESPACE}.campaign_enrollments (id, company_id, campaign_id, contact_id, status, step_position) VALUES ($1, $2, $3, $4, 'running', 1)`, [e, CO, draft.id, c]);
      await q(`INSERT INTO ${NAMESPACE}.campaign_step_events (id, company_id, campaign_id, enrollment_id, step_position, event_type, source_key) VALUES ($1, $2, $3, $4, 1, 'reply', $5)`, [`ev-${e}`, CO, draft.id, e, `reply:m-${e}`]);
      await q(`INSERT INTO ${NAMESPACE}.reply_log (id, company_id, message_id, enrollment_id, outcome) VALUES ($1, $2, $3, $4, 'answered')`, [`rl-${e}`, CO, `m-${e}`, e]);
      await q(`INSERT INTO ${NAMESPACE}.outbox (key, company_id, event, payload) VALUES ($1, $2, 'mail.send.requested', '{}'::jsonb)`, [`campaigns:step:${e}:1`, CO]);
    }
    await claimMessage(ctx, { key: "campaigns:msg:e-ada:1", company_id: CO, campaign_id: draft.id, enrollment_id: "e-ada", step_position: 1, channel: "sms", to_address: ADA, contact_id: "ada", sender_key: "own", body: "Hi", segments: 1 });
    await upsertConsent(ctx, { companyId: CO, channel: "sms", address: ADA, senderKey: "own", granted: true, basis: "consent", source: "form", recordedAt: "2026-10-01T08:00:00Z" });
    await suppress("ada@acme.test", "own");
    await suppress("bob@beta.test", "own");
    await addChannelSuppression(ctx, { companyId: CO, channel: "sms", address: ADA, senderKey: "own", reason: "stop_keyword", scope: "marketing", source: "partnersinbiz.campaigns" });
    const issues: string[] = [];
    const withIssues = { ...ctx, issues: { get: async () => null, list: async () => [], update: async (id: string) => { issues.push(id); return {}; } } } as unknown as PluginContext;

    const outcome = await eraseSubject(withIssues, { key: "erase:r1", requestId: "r1", subject: { email: "ada@acme.test", contactId: "ada" }, scope: "all", reason: "data_subject_request", approvedByUserId: "user-peet", requestedAt: new Date().toISOString(), source: "partnersinbiz.crm" }, CO);
    expect(outcome.errors).toBeUndefined();
    expect(outcome.counts).toMatchObject({ enrollments: 1, step_events: 1, reply_log: 1, messages: 1, mail_requests: 1, consents: 1, contact_copies: 1 });
    expect((await rows("campaign_enrollments")).map((r) => r.id)).toEqual(["e-bob"]);
    expect((await rows("campaign_step_events")).map((r) => r.enrollment_id)).toEqual(["e-bob"]);
    expect((await rows("reply_log")).map((r) => r.id)).toEqual(["rl-e-bob"]);
    expect((await rows("outbox")).map((r) => r.key)).toEqual(["campaigns:step:e-bob:1"]);
    expect(await rows("channel_messages")).toEqual([]);
    expect(await rows("channel_consents")).toEqual([]);
    expect((await rows("suppressions")).map((r) => r.email).sort()).toEqual([addressHash("ada@acme.test"), "bob@beta.test"].sort());
    expect((await rows("channel_suppressions")).map((r) => r.address)).toEqual([addressHash(ADA)]);
    expect(await isSuppressed(ctx, CO, "ada@acme.test", "own")).toBe(true);
    expect((await blockedAddresses(ctx, CO, "sms", [ADA], "own")).has(ADA)).toBe(true);
    const copies = await rows("crm_contacts");
    expect(copies.find((c) => c.id === "ada")).toMatchObject({ name: "[erased]", emails: [], phones: [], tags: [], deleted: true });
    expect(copies.find((c) => c.id === "bob")).toMatchObject({ name: "Bob", emails: ["bob@beta.test"], deleted: false });
  });

  it("erasing a person who already has a hash entry for the sender folds the old entry in (the key would refuse a second one)", async () => {
    await suppress(addressHash("ada@acme.test"), "own");
    await suppress(addressHash("ada@acme.test"), "company:acme");
    await suppress("ada@acme.test", "own", "all");
    await suppress("ada@acme.test", "company:beta");
    await addChannelSuppression(ctx, { companyId: CO, channel: "sms", address: addressHash(ADA), senderKey: "own", reason: "stop_keyword", scope: "marketing", source: "partnersinbiz.campaigns" });
    await addChannelSuppression(ctx, { companyId: CO, channel: "sms", address: ADA, senderKey: "own", reason: "invalid_number", scope: "all", source: "partnersinbiz.campaigns" });
    await addChannelSuppression(ctx, { companyId: CO, channel: "whatsapp", address: ADA, senderKey: "own", reason: "stop_keyword", scope: "marketing", source: "partnersinbiz.campaigns" });
    const withIssues = { ...ctx, issues: { get: async () => null, list: async () => [], update: async () => ({}) } } as unknown as PluginContext;
    const outcome = await eraseSubject(withIssues, { key: "erase:r2", requestId: "r2", subject: { email: "ada@acme.test", phone: ADA }, scope: "all", reason: "data_subject_request", approvedByUserId: "user-peet", requestedAt: new Date().toISOString(), source: "partnersinbiz.crm" }, CO);
    expect(outcome.errors).toBeUndefined();
    const hash = addressHash("ada@acme.test");
    expect((await rows("suppressions")).map((r) => [r.email, r.sender_key, r.scope])).toEqual([[hash, "company:acme", "marketing"], [hash, "company:beta", "marketing"], [hash, "own", "all"]]);
    expect((await rows("channel_suppressions")).map((r) => [r.address, r.channel, r.scope])).toEqual([[addressHash(ADA), "sms", "all"], [addressHash(ADA), "whatsapp", "marketing"]]);
  });
});
