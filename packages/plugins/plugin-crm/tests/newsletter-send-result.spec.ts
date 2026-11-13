/** The Mailbox's answer for a newsletter confirmation mail, and the outbox clean-up (plan PAR-10817 "Send result"). */
import { describe, expect, it } from "vitest";
import { CO } from "./helpers/crm.js";
import { MAILBOX } from "./helpers/care.js";
import { bootLeads, ip, makeSourceAsPerson, signedDelivery, type Booted } from "./helpers/leads.js";
import { handleLeadWebhook } from "../src/lead-capture.js";
import { PENDING_CONFIRMATION, SIGNUP_MAIL_PREFIX } from "../src/newsletter-signup.js";

const SITE = "https://remotesaffa.co.za";
const NEWSLETTER = { label: "RemoteSaffa", intake: "newsletter", siteUrl: SITE, applyTags: ["remotesaffa-subscribers"], confirmUrl: `${SITE}/subscribe/confirm`, confirmFrom: "hello@remotesaffa.co.za", consentText: "Yes, send me the Friday list.", serverSecret: true };
const EMAIL = "thandi@example.co.za";

/** A source and one signup: one pending capture and one queued confirmation mail. */
async function signedUp(): Promise<{ booted: Booted; captureKey: string; mailKey: string }> {
  const booted = await bootLeads();
  const made = await makeSourceAsPerson(booted, NEWSLETTER);
  await handleLeadWebhook(booted.harness.ctx, signedDelivery(made.serverSecret!, { key: made.source.key, email: EMAIL, pageUrl: `${SITE}/jobs`, visitorIp: ip(9) }));
  const captureKey = booted.store.lead_captures[0]!.key as string;
  return { booted, captureKey, mailKey: `${SIGNUP_MAIL_PREFIX}${captureKey}` };
}

async function answer(booted: Booted, key: string, status: "sent" | "failed", extra: Record<string, unknown> = {}, companyId = CO) {
  const context = { plugin: "partnersinbiz.crm", kind: "client_message", id: key.slice(SIGNUP_MAIL_PREFIX.length) };
  await booted.harness.emit(`${MAILBOX}.mail.send.result` as `plugin.${string}`, { key, status, messageId: null, threadId: null, sentAt: null, context, ...extra }, { companyId });
}

const outboxKeys = (booted: Booted) => booted.store.outbox.map((row) => row.key);
const counts = (booted: Booted) => ({ accepted: booted.store.lead_sources[0]!.accepted_count, rejected: booted.store.lead_sources[0]!.rejected_count });

describe("newsletter confirmation send result", () => {
  it("sent: the outbox row is deleted and the signup stays pending", async () => {
    const { booted, mailKey } = await signedUp();
    expect(outboxKeys(booted)).toEqual([mailKey]);
    await answer(booted, mailKey, "sent", { messageId: "resend:m-1", sentAt: new Date().toISOString() });
    expect(outboxKeys(booted)).toEqual([]);
    expect(booted.store.lead_captures[0]).toMatchObject({ outcome: PENDING_CONFIRMATION });
    expect(counts(booted)).toEqual({ accepted: 1, rejected: 0 });
  });

  it("failed for good: the signup becomes confirmation_failed, one rejection is counted, the row is deleted, and a repeated answer counts nothing", async () => {
    const { booted, mailKey } = await signedUp();
    await answer(booted, mailKey, "failed", { permanent: true, error: "No connected Gmail account" });
    expect(booted.store.lead_captures[0]).toMatchObject({ outcome: "confirmation_failed" });
    expect(counts(booted)).toEqual({ accepted: 1, rejected: 1 });
    expect(outboxKeys(booted)).toEqual([]);
    await answer(booted, mailKey, "failed", { permanent: true, error: "No connected Gmail account" });
    expect(counts(booted)).toEqual({ accepted: 1, rejected: 1 });
  });

  it("every recipient suppressed behaves like failed", async () => {
    const { booted, mailKey } = await signedUp();
    await answer(booted, mailKey, "failed", { permanent: true, error: `Not sent: ${EMAIL} bounced.`, suppressed: [{ email: EMAIL, scope: "all", reason: "bounced" }] });
    expect(booted.store.lead_captures[0]).toMatchObject({ outcome: "confirmation_failed" });
    expect(counts(booted)).toEqual({ accepted: 1, rejected: 1 });
    expect(outboxKeys(booted)).toEqual([]);
  });

  it("a failure a retry may fix leaves the signup and the row in place, and another company's answer changes nothing", async () => {
    const { booted, mailKey } = await signedUp();
    await answer(booted, mailKey, "failed", { permanent: false, error: "Rate limited" });
    expect(booted.store.outbox[0]).toMatchObject({ key: mailKey, status: "pending", last_error: "Rate limited" });
    await answer(booted, mailKey, "failed", { permanent: true, error: "x" }, "other-co");
    await answer(booted, mailKey, "sent", {}, "other-co");
    expect(outboxKeys(booted)).toEqual([mailKey]);
    expect(booted.store.lead_captures[0]).toMatchObject({ outcome: PENDING_CONFIRMATION });
    expect(counts(booted)).toEqual({ accepted: 1, rejected: 0 });
  });

});
