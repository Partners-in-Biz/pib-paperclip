/** Newsletter signup (plan PAR-10817 "Signup"): signed calls only, the limits, one confirmation mail per address and day, and nothing else written. */
import { describe, expect, it, vi } from "vitest";
import { CO, contact, crmIssues, NOW } from "./helpers/crm.js";
import { bootLeads, delivery, ip, lead, makeSource, makeSourceAsPerson, signedDelivery, type Booted } from "./helpers/leads.js";
import { handleLeadWebhook } from "../src/lead-capture.js";
import { PENDING_CONFIRMATION, SIGNUP_MAIL_PREFIX } from "../src/newsletter-signup.js";
import { verifyConfirmToken } from "../src/newsletter-token.js";

const SITE = "https://remotesaffa.co.za";
const NEWSLETTER = { label: "RemoteSaffa", intake: "newsletter", siteUrl: SITE, applyTags: ["remotesaffa-subscribers"], confirmUrl: `${SITE}/subscribe/confirm`, confirmFrom: "hello@remotesaffa.co.za", consentText: "Yes, send me the Friday list." };
const EMAIL = "thandi@example.co.za";

async function newsletter(booted: Booted, extra: Record<string, unknown> = {}) {
  return makeSourceAsPerson(booted, { ...NEWSLETTER, serverSecret: true, ...extra });
}

/** A signed signup as the RemoteSaffa server sends it: the visitor's address, its page and its IP. */
function signup(made: { serverSecret?: string; source: Record<string, any> }, extra: Record<string, unknown> = {}, n = 9) {
  return signedDelivery(made.serverSecret!, { key: made.source.key, email: EMAIL, pageUrl: `${SITE}/jobs?utm_source=x`, visitorIp: ip(n), ...extra }, { headers: { "x-real-ip": "198.51.100.1" } });
}

const refused = (promise: Promise<unknown>) => promise.then(() => "accepted", (error: unknown) => String(error));
const mails = (booted: Booted) => booted.store.outbox.filter((row) => String(row.key).startsWith(SIGNUP_MAIL_PREFIX));

function expectNothingElseWritten(booted: Booted, contacts: number) {
  expect(booted.store.contacts).toHaveLength(contacts);
  expect(booted.store.consent_records ?? []).toHaveLength(0);
  expect(booted.store.activities.filter((row) => row.kind !== "note")).toHaveLength(0);
  expect(booted.store.held_leads ?? []).toHaveLength(0);
  expect(booted.store.client_leads ?? []).toHaveLength(0);
}

describe("newsletter signup", () => {
  it("refuses an unsigned call and writes nothing", async () => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    expect(await refused(handleLeadWebhook(booted.harness.ctx, delivery({ key: made.source.key, email: EMAIL, t: 9000 })))).toMatch(/signed calls only/);
    expect(booted.store.lead_captures).toHaveLength(0);
    expect(booted.store.outbox).toHaveLength(0);
  });

  it("the first signup queues exactly one confirmation mail: from the source, not marketing, kind client_message, a valid link and nothing the visitor typed", async () => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    const contacts = booted.store.contacts.length;
    const answer = await handleLeadWebhook(booted.harness.ctx, signup(made, { name: "<b>Win a prize</b>", message: "click evil.example" }));
    expect(answer).toMatchObject({ status: "stored", contactId: null, client: null });

    expect(booted.store.lead_captures).toHaveLength(1);
    const capture = booted.store.lead_captures[0]!;
    expect(capture).toMatchObject({ outcome: PENDING_CONFIRMATION, contact_id: null, consent: false });
    expect(mails(booted)).toHaveLength(1);
    const mail = mails(booted)[0]!.payload;
    expect(mail.key).toBe(`${SIGNUP_MAIL_PREFIX}${capture.key}`);
    expect(mail).toMatchObject({ from: "hello@remotesaffa.co.za", fromName: "RemoteSaffa", to: [{ email: EMAIL }], context: { plugin: "partnersinbiz.crm", kind: "client_message", id: capture.key } });
    expect(mail.marketing).toBeUndefined();
    expect(`${mail.text}${mail.html}${mail.subject}`).not.toMatch(/prize|evil|Thandi/i);

    const link = /https:\/\/\S+#t=(\S+)/.exec(mail.text)!;
    expect(link[0].startsWith(`${NEWSLETTER.confirmUrl}#t=`)).toBe(true);
    const row = booted.store.lead_sources[0]!;
    const check = verifyConfirmToken({ id: row.id, confirmSecret: row.confirm_secret, consentText: row.consent_text }, link[1], Date.now());
    expect(check).toMatchObject({ ok: true, claims: { email: EMAIL, pagePath: "/jobs" } });

    expectNothingElseWritten(booted, contacts);
    expect(await crmIssues(booted.harness)).toHaveLength(0);
    expect(booted.store.lead_sources[0]).toMatchObject({ accepted_count: 1 });
  });

  it("a second signup for the same address the same day sends nothing and answers the same", async () => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    const first = await handleLeadWebhook(booted.harness.ctx, signup(made));
    const second = await handleLeadWebhook(booted.harness.ctx, signup(made, { email: EMAIL.toUpperCase() }, 10));
    expect(second).toEqual(first);
    expect(booted.store.lead_captures).toHaveLength(1);
    expect(mails(booted)).toHaveLength(1);
  });

  it("when the mail cannot be queued the capture is removed and the call fails, so a retry sends", async () => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    const execute = booted.harness.ctx.db.execute.bind(booted.harness.ctx.db);
    const spy = vi.spyOn(booted.harness.ctx.db, "execute").mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/\.outbox\b/.test(sql) && /^\s*INSERT/i.test(sql)) throw new Error("outbox down");
      return execute(sql, params);
    });
    expect(await refused(handleLeadWebhook(booted.harness.ctx, signup(made)))).toMatch(/Something went wrong|outbox down/);
    expect(booted.store.lead_captures).toHaveLength(0);
    expect(mails(booted)).toHaveLength(0);
    spy.mockRestore();
    expect(await handleLeadWebhook(booted.harness.ctx, signup(made, {}, 11))).toMatchObject({ status: "stored" });
    expect(mails(booted)).toHaveLength(1);
  });

  it.each([
    ["unsubscribed", { email_status: "unsubscribed" }],
    ["bounced", { email_status: "bounced" }],
    ["already tagged (any case)", { tags: ["vip", "RemoteSaffa-Subscribers"] }],
  ])("a contact that is %s gets nothing and the same success", async (_label, extra) => {
    const booted = await bootLeads();
    booted.store.contacts.push(contact("known", "Thandi", { emails: [EMAIL], ...extra }));
    const made = await newsletter(booted);
    const before = JSON.stringify(booted.store.contacts);
    expect(await handleLeadWebhook(booted.harness.ctx, signup(made))).toMatchObject({ status: "stored", contactId: null });
    expect(booted.store.lead_captures).toHaveLength(0);
    expect(mails(booted)).toHaveLength(0);
    expect(JSON.stringify(booted.store.contacts)).toBe(before);
  });

  it("a contact on the list without every tag still gets the mail, and is not changed", async () => {
    const booted = await bootLeads();
    booted.store.contacts.push(contact("known", "Thandi", { emails: [EMAIL], tags: ["remotesaffa-subscribers"] }));
    const made = await newsletter(booted, { applyTags: ["remotesaffa-subscribers", "jobs"] });
    const before = JSON.stringify(booted.store.contacts);
    await handleLeadWebhook(booted.harness.ctx, signup(made));
    expect(mails(booted)).toHaveLength(1);
    expect(JSON.stringify(booted.store.contacts)).toBe(before);
  });

  it("refuses the signup past the daily ceiling (the 301st in 24 hours), and counts only the last 24 hours", async () => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    const capture = (minutesAgo: number, i: number) => ({ id: `c${minutesAgo}-${i}`, company_id: CO, source_id: made.source.id, key: `form:${made.source.id}:h${minutesAgo}-${i}:x`, outcome: PENDING_CONFIRMATION, created_at: new Date(NOW - minutesAgo * 60_000).toISOString() });
    for (let i = 0; i < 299; i += 1) booted.store.lead_captures.push(capture(60, i));
    booted.store.lead_captures.push(capture(25 * 60, 0));
    expect(await handleLeadWebhook(booted.harness.ctx, signup(made))).toMatchObject({ status: "stored" });
    expect(mails(booted)).toHaveLength(1);
    expect(await refused(handleLeadWebhook(booted.harness.ctx, signup(made, { email: "sipho@example.co.za" }, 12)))).toMatch(/all the confirmation emails it may today/);
    expect(mails(booted)).toHaveLength(1);
  });

  it.each([
    ["confirm_url", { confirm_url: "https://evil.example/confirm" }],
    ["confirm_from", { confirm_from: "not an address" }],
  ])("a %s changed directly in the database is refused as bad_source_config, sends nothing, logs no address", async (_column, change) => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    Object.assign(booted.store.lead_sources[0]!, change);
    const warn = vi.spyOn(booted.harness.ctx.logger, "warn");
    expect(await refused(handleLeadWebhook(booted.harness.ctx, signup(made)))).toMatch(/temporarily unavailable/);
    expect(booted.store.lead_captures).toHaveLength(0);
    expect(booted.store.outbox).toHaveLength(0);
    expect(booted.store.lead_hits.map((row) => row.outcome)).toContain("bad_source_config");
    expect(warn.mock.calls.filter(([, meta]) => (meta as { event?: string })?.event === "bad_source_config")).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(EMAIL);
  });

  it("refuses an action other than confirm on a newsletter form and writes nothing", async () => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    expect(await refused(handleLeadWebhook(booted.harness.ctx, signup(made, { action: "subscribe" })))).toMatch(/does not take that action/);
    expect(booted.store.lead_captures).toHaveLength(0);
    expect(booted.store.outbox).toHaveLength(0);
  });

  it("a canary address (.invalid) is captured but no mail is queued for it", async () => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    booted.store.lead_sources[0]!.canary = true;
    expect(await handleLeadWebhook(booted.harness.ctx, signup(made, { email: "probe@canary.invalid" }))).toMatchObject({ status: "stored" });
    expect(booted.store.lead_captures).toHaveLength(1);
    expect(booted.store.outbox).toHaveLength(0);
  });

  it("still refuses disposable addresses", async () => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    expect(await refused(handleLeadWebhook(booted.harness.ctx, signup(made, { email: "x@mailinator.com" })))).toMatch(/permanent email address/);
    expect(booted.store.outbox).toHaveLength(0);
  });

  it("lead and report forms ignore an action field and behave as before, with the new columns at their defaults", async () => {
    const booted = await bootLeads();
    const plain = await makeSource(booted, { label: "Contact" });
    expect(await handleLeadWebhook(booted.harness.ctx, delivery(lead(plain.source.key, { action: "confirm" }), { "x-real-ip": ip(20) }))).toMatchObject({ status: "stored" });
    booted.harness.seed({ projects: [{ id: "proj-1", companyId: CO, name: "RemoteSaffa" } as never] });
    const report = await makeSource(booted, { label: "Reports", intake: "issue", projectId: "proj-1" });
    expect(await handleLeadWebhook(booted.harness.ctx, delivery({ ...lead(report.source.key), action: "confirm" }, { "x-real-ip": ip(21) }))).toMatchObject({ status: "stored" });
    expect(mails(booted)).toHaveLength(0);
    for (const row of booted.store.lead_sources) expect(row).toMatchObject({ apply_tags: [], confirm_url: null, confirm_from: null, confirm_secret: null, confirm_daily_cap: 300 });
  });
});
