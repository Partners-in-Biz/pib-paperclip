/** Newsletter confirm (plan PAR-10817 "Confirm"): its own bucket, the token checks, the subscriber, the tag, the consent record, idempotence. */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contact, crmIssues } from "./helpers/crm.js";
import { bootLeads, ip, makeSourceAsPerson, signedDelivery, type Booted } from "./helpers/leads.js";
import { handleLeadWebhook, ipSalt } from "../src/lead-capture.js";
import { hashIp } from "../src/lead-form.js";
import { confirmBucket } from "../src/newsletter-confirm.js";
import { SIGNUP_MAIL_PREFIX } from "../src/newsletter-signup.js";
import { mintConfirmToken } from "../src/newsletter-token.js";

const SITE = "https://remotesaffa.co.za";
const TAG = "remotesaffa-subscribers";
const NEWSLETTER = { label: "RemoteSaffa", intake: "newsletter", siteUrl: SITE, applyTags: [TAG], confirmUrl: `${SITE}/subscribe/confirm`, confirmFrom: "hello@remotesaffa.co.za", consentText: "Yes, send me the Friday list." };
const EMAIL = "thandi@example.co.za";
type Made = { serverSecret?: string; source: Record<string, any> };

const refused = (promise: Promise<unknown>) => promise.then(() => "accepted", (error: unknown) => String(error));
const newsletter = (booted: Booted) => makeSourceAsPerson(booted, { ...NEWSLETTER, serverSecret: true }) as Promise<Made>;
const row = (booted: Booted) => booted.store.lead_sources[0]!;

/** A link as signup mints it, for any address, time or source. */
function token(booted: Booted, extra: { email?: string; issuedAt?: number; id?: string } = {}) {
  const source = row(booted);
  return mintConfirmToken({ id: extra.id ?? source.id, confirmSecret: source.confirm_secret, consentText: source.consent_text }, { email: extra.email ?? EMAIL, pagePath: "/jobs", issuedAt: extra.issuedAt ?? Date.now() });
}

function confirm(made: Made, tokenValue: string, n = 30) {
  return signedDelivery(made.serverSecret!, { key: made.source.key, action: "confirm", token: tokenValue, visitorIp: ip(n) }, { headers: { "x-real-ip": "198.51.100.1" } });
}

function signup(made: Made, email = EMAIL) {
  return signedDelivery(made.serverSecret!, { key: made.source.key, email, pageUrl: `${SITE}/jobs`, visitorIp: ip(9) }, { headers: { "x-real-ip": "198.51.100.1" } });
}

const snapshot = (booted: Booted) => JSON.stringify([booted.store.contacts, booted.store.consent_records ?? [], booted.store.activities, booted.store.lead_captures]);

afterEach(() => vi.useRealTimers());

describe("newsletter confirm", () => {
  it("creates the contact with the source's tags, lifecycle lead, custom.origin and a newsletter consent record; marks the capture confirmed", async () => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    await handleLeadWebhook(booted.harness.ctx, signup(made));
    const mail = booted.store.outbox.find((r) => String(r.key).startsWith(SIGNUP_MAIL_PREFIX))!.payload;
    const link = /#t=(\S+)/.exec(mail.text)![1]!;
    const contacts = booted.store.contacts.length;

    expect(await handleLeadWebhook(booted.harness.ctx, confirm(made, link))).toMatchObject({ status: "stored", contactId: null });

    expect(booted.store.contacts).toHaveLength(contacts + 1);
    const subscriber = booted.store.contacts.find((c) => c.emails.includes(EMAIL))!;
    expect(subscriber).toMatchObject({ lifecycle: "lead", tags: [TAG], custom: { origin: "newsletter" } });
    expect(subscriber.lead_scored_at ?? null).toBeNull();
    expect(booted.store.consent_records).toHaveLength(1);
    expect(booted.store.consent_records![0]).toMatchObject({
      purpose: "newsletter", basis: "consent", source: "form", granted: true, wording: NEWSLETTER.consentText, url: "/jobs",
      form_id: row(booted).id, contact_id: subscriber.id, ip_hash: hashIp(await ipSalt(booted.harness.ctx), ip(30)),
    });
    expect(booted.store.lead_captures[0]).toMatchObject({ outcome: "confirmed", contact_id: subscriber.id });
    expect(booted.store.activities.filter((a) => a.kind === "newsletter_confirmed")).toHaveLength(1);
    expect(await crmIssues(booted.harness)).toHaveLength(0);
    // Hits go to the confirm bucket only.
    expect(booted.store.lead_hits.filter((h) => h.outcome === "confirmed").map((h) => h.source_id)).toEqual([confirmBucket(row(booted).id)]);
  });

  it("a second confirm changes nothing and answers success", async () => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    const link = token(booted);
    await handleLeadWebhook(booted.harness.ctx, confirm(made, link));
    const before = snapshot(booted);
    expect(await handleLeadWebhook(booted.harness.ctx, confirm(made, link, 31))).toMatchObject({ status: "stored" });
    expect(snapshot(booted)).toBe(before);
  });

  it("an unsubscribed contact is left unchanged and the confirm is refused", async () => {
    const booted = await bootLeads();
    booted.store.contacts.push(contact("known", "Thandi", { emails: [EMAIL], email_status: "unsubscribed" }));
    const made = await newsletter(booted);
    const before = snapshot(booted);
    expect(await refused(handleLeadWebhook(booted.harness.ctx, confirm(made, token(booted))))).toMatch(/not valid/);
    expect(snapshot(booted)).toBe(before);
  });

  it("a person-owned tags field still gets the tag; the other tags, lifecycle and fields stay verbatim", async () => {
    const booted = await bootLeads();
    booted.store.contacts.push(contact("known", "Thandi M", { emails: [EMAIL], lifecycle: "customer", tags: ["VIP", "Mixed Case"], human_owned_fields: ["tags"], custom: { note: "x" } }));
    const made = await newsletter(booted);
    await handleLeadWebhook(booted.harness.ctx, confirm(made, token(booted)));
    expect(booted.store.contacts.find((c) => c.id === "known")).toMatchObject({ name: "Thandi M", lifecycle: "customer", tags: ["VIP", "Mixed Case", TAG], human_owned_fields: ["tags"], custom: { note: "x" } });
    expect(booted.store.consent_records).toHaveLength(1);
  });

  it("200 bad-token confirms do not block a signup (own bucket); the next confirm is rate limited", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const booted = await bootLeads();
    const made = await newsletter(booted);
    row(booted).rate_limit_per_hour = 20; // the live setting: 100 signed calls an hour on the source bucket
    for (let i = 0; i < 200; i += 1) {
      vi.setSystemTime(start + i * 2_500);
      expect(await refused(handleLeadWebhook(booted.harness.ctx, confirm(made, `${token(booted)}x`)))).toMatch(/not valid/);
    }
    expect(booted.store.lead_hits.filter((h) => h.source_id === confirmBucket(row(booted).id))).toHaveLength(200);
    vi.setSystemTime(start + 200 * 2_500);
    expect(await handleLeadWebhook(booted.harness.ctx, signup(made))).toMatchObject({ status: "stored" });
    expect(booted.store.lead_captures).toHaveLength(1);
    expect(row(booted).rejected_count ?? 0).toBe(0);
    expect(await refused(handleLeadWebhook(booted.harness.ctx, confirm(made, token(booted))))).toMatch(/Too many confirmations/);
  });

  it.each([
    ["expired", (b: Booted) => token(b, { issuedAt: Date.now() - 8 * 86_400_000 })],
    ["tampered", (b: Booted) => { const [payload, mac] = token(b).split("."); return `${payload!.slice(0, -2)}AA.${mac}`; }],
    ["wrong-source", (b: Booted) => token(b, { id: randomUUID() })],
    ["changed-wording", (b: Booted) => { const t = token(b); row(b).consent_text = "New wording."; return t; }],
  ])("a %s token is refused and nothing is written", async (_label, make) => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    const link = make(booted);
    const before = snapshot(booted);
    expect(await refused(handleLeadWebhook(booted.harness.ctx, confirm(made, link)))).toMatch(/not valid/);
    expect(snapshot(booted)).toBe(before);
    expect(booted.store.lead_hits.at(-1)).toMatchObject({ source_id: confirmBucket(row(booted).id) });
  });
});
