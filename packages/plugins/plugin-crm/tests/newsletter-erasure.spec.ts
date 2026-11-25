/** Unconfirmed newsletter signups: erased with the person by email, and expired after 30 days. */
import { describe, expect, it } from "vitest";
import { bootLeads, makeSource } from "./helpers/leads.js";
import { CO } from "./helpers/crm.js";
import { ipSalt } from "../src/lead-capture.js";
import { leadCaptureKey } from "../src/lead-form.js";
import { eraseFormData, expireUnconfirmedCaptures } from "../src/lead-store.js";

const SITE = "https://remotesaffa.co.za";
const NEWSLETTER = { label: "Newsletter", intake: "newsletter", siteUrl: SITE, applyTags: ["t"], confirmUrl: `${SITE}/subscribe/confirm`, confirmFrom: "hello@remotesaffa.co.za", consentText: "Yes, send me the Friday list." };
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

describe("erasure of unconfirmed newsletter captures", () => {
  it("removes an address's capture rows across two sources, with no contact, and leaves another address's rows", async () => {
    const booted = await bootLeads();
    const a = (await makeSource(booted, NEWSLETTER)).source.id as string;
    const b = (await makeSource(booted, { ...NEWSLETTER, label: "Second" })).source.id as string;
    const salt = await ipSalt(booted.harness.ctx);
    const row = (id: string, key: string) => ({ id, company_id: CO, source_id: a, key, outcome: "pending_confirmation", contact_id: null, ip_hash: null, created_at: ago(1) });
    const now = new Date();
    booted.store.lead_captures = [
      row("j1", leadCaptureKey(a, "jane@smith.test", now, salt)),
      row("j2", leadCaptureKey(b, "Jane@Smith.test", new Date(now.getTime() - 3 * DAY), salt)),
      row("o1", leadCaptureKey(a, "other@smith.test", now, salt)),
      row("o2", leadCaptureKey(b, "other@smith.test", now, salt)),
    ];
    const res = await eraseFormData(booted.harness.ctx, CO, " JANE@smith.test ");
    expect(res.captures).toBe(2);
    expect(booted.store.lead_captures.map((r) => r.id)).toEqual(["o1", "o2"]);
  });
});

describe("expiry of unconfirmed newsletter captures", () => {
  it("deletes pending_confirmation and confirmation_failed older than 30 days, and nothing else", async () => {
    const booted = await bootLeads();
    const mk = (id: string, outcome: string, days: number) => ({ id, company_id: CO, source_id: "s", key: `form:s:${id}:20261001`, outcome, contact_id: null, ip_hash: null, created_at: ago(days) });
    booted.store.lead_captures = [
      mk("p31", "pending_confirmation", 31),
      mk("f31", "confirmation_failed", 31),
      mk("p29", "pending_confirmation", 29),
      mk("f29", "confirmation_failed", 29),
      mk("s31", "stored", 31),
      mk("d31", "dry_run", 31),
    ];
    expect(await expireUnconfirmedCaptures(booted.harness.ctx, ago(30))).toBe(2);
    expect(booted.store.lead_captures.map((r) => r.id)).toEqual(["p29", "f29", "s31", "d31"]);
  });
});
