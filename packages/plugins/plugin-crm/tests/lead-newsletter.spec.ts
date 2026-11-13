/** Newsletter lead sources, stage 1a (PAR-10850): the database takes them and the webhook refuses them (the tools: lead-newsletter-tools.spec.ts). */
import { describe, expect, it } from "vitest";
import { tool } from "./helpers/crm.js";
import { bootLeads, delivery, lead, makeSource, makeSourceAsPerson, signedDelivery } from "./helpers/leads.js";
import { handleLeadWebhook } from "../src/lead-capture.js";

const SITE = "https://remotesaffa.co.za";
const refused = (promise: Promise<unknown>) => promise.then(() => "accepted", (error: unknown) => String(error));

describe("the lead webhook and a newsletter form", () => {
  it("refuses a signed signup until the double opt-in path ships, and writes nothing", async () => {
    const booted = await bootLeads();
    const made = await makeSourceAsPerson(booted, { label: "Newsletter", siteUrl: SITE, serverSecret: true, consentText: "Yes, send me the Friday list." });
    // A newsletter row as migration 023 allows it (the tools that make one come in PAR-10863).
    Object.assign(booted.store.lead_sources[0]!, { intake: "newsletter", apply_tags: ["remotesaffa-subscribers"], confirm_url: `${SITE}/subscribe/confirm`, confirm_from: "hello@remotesaffa.co.za", confirm_secret: "pibs_confirm" });
    const contacts = booted.store.contacts.length;
    expect(await refused(handleLeadWebhook(booted.harness.ctx, signedDelivery(made.serverSecret!, lead(made.source.key))))).toMatch(/not active/);
    expect(await refused(handleLeadWebhook(booted.harness.ctx, delivery(lead(made.source.key), { "x-real-ip": "203.0.113.9" })))).toMatch(/not active/);
    expect(booted.store.lead_hits).toHaveLength(0);
    expect(booted.store.lead_captures).toHaveLength(0);
    expect(booted.store.consent_records).toHaveLength(0);
    expect(booted.store.contacts).toHaveLength(contacts);
    expect(booted.store.lead_sources[0]).toMatchObject({ accepted_count: 0, rejected_count: 0, status: "active" });
  });

  it("every existing form still lists as lead, keeps empty newsletter settings and still takes a lead", async () => {
    const booted = await bootLeads();
    const made = await makeSource(booted, { label: "Contact" });
    const listed = await tool(booted.harness, "list-lead-sources", {});
    expect(listed.sources.map((source: { intake: string }) => source.intake)).toEqual(["lead"]);
    expect(await handleLeadWebhook(booted.harness.ctx, delivery(lead(made.source.key), { "x-real-ip": "203.0.113.9" }))).toMatchObject({ status: "stored" });
    expect(booted.store.lead_sources[0]).toMatchObject({ intake: "lead", apply_tags: [], confirm_url: null, confirm_from: null, confirm_secret: null, confirm_daily_cap: 300 });
  });
});
