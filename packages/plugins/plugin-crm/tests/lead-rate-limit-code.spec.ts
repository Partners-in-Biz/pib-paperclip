/**
 * PAR-11278: every rate-limited refusal from the lead webhook carries the SDK's RATE_LIMITED code (the host answers 429);
 * any other refusal carries none (the host keeps 502). Covers the four rate-limited paths of `handleLeadWebhook`.
 */
import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { generateLeadKey } from "../src/lead-form.js";
import { handleLeadWebhook, LeadRejected, RATE } from "../src/lead-capture.js";
import { CONFIRM_RATE, confirmBucket } from "../src/newsletter-confirm.js";
import { PENDING_CONFIRMATION } from "../src/newsletter-signup.js";
import { CO } from "./helpers/crm.js";
import { bootLeads, delivery, ip, lead, makeSource, makeSourceAsPerson, signedDelivery, type Booted } from "./helpers/leads.js";

const SITE = "https://remotesaffa.co.za";
const NEWSLETTER = { label: "RemoteSaffa", intake: "newsletter", siteUrl: SITE, applyTags: ["remotesaffa-subscribers"], confirmUrl: `${SITE}/subscribe/confirm`, confirmFrom: "hello@remotesaffa.co.za", consentText: "Yes, send me the Friday list." };
const withTurnstile = { timezone: "Africa/Johannesburg", leads: { turnstileSiteKey: "0x4AAAAAAA", turnstileSecret: { type: "secret_ref", secretId: "sec-turnstile" } } };

/** The error a refused call threw (fails the test when the call was accepted). */
async function refusal(promise: Promise<unknown>): Promise<LeadRejected> {
  const error = await promise.then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(LeadRejected);
  return error as LeadRejected;
}

const recent = () => new Date(Date.now() - 10_000).toISOString();
const seedHits = (booted: Booted, sourceId: string, n: number, extra: Record<string, unknown> = {}) =>
  booted.store.lead_hits.push(...Array.from({ length: n }, (_, i) => ({ id: `seed-${sourceId}-${i}`, source_id: sourceId, ip_hash: `h${i}`, outcome: "stored", created_at: recent(), ...extra })));

describe("rate-limited lead refusals carry RATE_LIMITED", () => {
  it("sets the code from the outcome, so every rate_limited refusal carries it and no other does", () => {
    expect(new LeadRejected("Too many.", "rate_limited").code).toBe(PLUGIN_RPC_ERROR_CODES.RATE_LIMITED);
    for (const outcome of ["bad_signature", "inactive", "invalid", "error", "bot_check"]) expect(new LeadRejected("No.", outcome).code).toBeUndefined();
  });

  it("the per-visitor and per-form limits", async () => {
    const booted = await bootLeads();
    const { source } = await makeSource(booted, {});
    const send = (n: number) => handleLeadWebhook(booted.harness.ctx, delivery(lead(source.key, { email: `p${n}@smith-plumbing.test` }), { "x-real-ip": ip(40) }));
    for (let n = 0; n < RATE.ipPerMinute; n += 1) await send(n);
    const error = await refusal(send(99));
    expect(error.message).toMatch(/Too many submissions/);
    expect(error.code).toBe(PLUGIN_RPC_ERROR_CODES.RATE_LIMITED);
  });

  it("the allowance while Cloudflare is unreachable", async () => {
    const booted = await bootLeads({ config: withTurnstile });
    const { source } = await makeSource(booted, {});
    vi.spyOn(booted.harness.ctx.http, "fetch").mockRejectedValue(new Error("network down"));
    seedHits(booted, source.id, RATE.degradedSourcePerHour, { outcome: "unverified" });
    const error = await refusal(handleLeadWebhook(booted.harness.ctx, delivery(lead(source.key, { email: "b@smith-plumbing.test", turnstileToken: "tok" }), { "x-real-ip": ip(94) })));
    expect(error.message).toMatch(/Too many submissions/);
    expect(error.code).toBe(PLUGIN_RPC_ERROR_CODES.RATE_LIMITED);
  });

  it("the newsletter confirm bucket", async () => {
    const booted = await bootLeads();
    const made = await makeSourceAsPerson(booted, { ...NEWSLETTER, serverSecret: true });
    seedHits(booted, confirmBucket(made.source.id), CONFIRM_RATE.perMinute);
    const call = signedDelivery(made.serverSecret!, { key: made.source.key, action: "confirm", token: "x.y", visitorIp: ip(30) }, { headers: { "x-real-ip": "198.51.100.1" } });
    const error = await refusal(handleLeadWebhook(booted.harness.ctx, call));
    expect(error.message).toMatch(/Too many confirmations/);
    expect(error.code).toBe(PLUGIN_RPC_ERROR_CODES.RATE_LIMITED);
  });

  it("the newsletter daily confirmation-mail cap", async () => {
    const booted = await bootLeads();
    const made = await makeSourceAsPerson(booted, { ...NEWSLETTER, serverSecret: true, confirmDailyCap: 2 });
    for (let i = 0; i < 2; i += 1) {
      booted.store.lead_captures.push({ id: `c${i}`, company_id: CO, source_id: made.source.id, key: `form:${made.source.id}:h${i}:x`, outcome: PENDING_CONFIRMATION, created_at: recent() });
    }
    const call = signedDelivery(made.serverSecret!, { key: made.source.key, email: "sipho@remotesaffa.test", pageUrl: `${SITE}/jobs`, visitorIp: ip(12) }, { headers: { "x-real-ip": "198.51.100.1" } });
    const error = await refusal(handleLeadWebhook(booted.harness.ctx, call));
    expect(error.message).toMatch(/all the confirmation emails it may today/);
    expect(error.code).toBe(PLUGIN_RPC_ERROR_CODES.RATE_LIMITED);
  });

  it("a bad signature, an inactive key and a validation refusal carry no code", async () => {
    const booted = await bootLeads();
    const made = await makeSourceAsPerson(booted, { serverSecret: true });
    const badSignature = await refusal(handleLeadWebhook(booted.harness.ctx, signedDelivery("pibs_wrong", lead(made.source.key))));
    const inactive = await refusal(handleLeadWebhook(booted.harness.ctx, delivery(lead(generateLeadKey()))));
    const invalid = await refusal(handleLeadWebhook(booted.harness.ctx, delivery(lead(made.source.key, { email: "not-an-email" }), { "x-real-ip": ip(5) })));
    expect([badSignature.outcome, inactive.outcome]).toEqual(["bad_signature", "inactive"]);
    for (const error of [badSignature, inactive, invalid]) expect(error.code).toBeUndefined();
  });
});
