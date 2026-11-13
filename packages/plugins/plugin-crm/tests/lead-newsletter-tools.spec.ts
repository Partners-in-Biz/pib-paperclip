/** Newsletter lead sources, stage 1b (PAR-10863): the tools make and change them, check their settings, and never show the confirmation-link secret. */
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { tool } from "./helpers/crm.js";
import { bootLeads, makeSource, makeSourceAsPerson, type Booted } from "./helpers/leads.js";

const SITE = "https://remotesaffa.co.za";
const NEWSLETTER = { label: "Newsletter", intake: "newsletter", siteUrl: SITE, applyTags: ["remotesaffa-subscribers"], confirmUrl: `${SITE}/subscribe/confirm`, confirmFrom: "hello@remotesaffa.co.za", consentText: "Yes, send me the Friday list." };
const refused = (promise: Promise<unknown>) => promise.then(() => "accepted", (error: unknown) => String(error));
const row = (booted: Booted) => booted.store.lead_sources[0] as Record<string, any>;

async function newsletterForm(extra: Record<string, unknown> = {}) {
  const booted = await bootLeads();
  const made = await makeSourceAsPerson(booted, { ...NEWSLETTER, ...extra });
  return { booted, made, secret: row(booted).confirm_secret as string };
}

describe("create-lead-endpoint with intake newsletter", () => {
  it("a person makes it: the settings are stored, the confirmation secret is made and no result, list or log shows it", async () => {
    const { booted, made, secret } = await newsletterForm({ confirmDailyCap: 250 });
    expect(made.created).toBe(true);
    expect(secret).toMatch(/^pibs_[a-z0-9]{40}$/);
    expect(secret).not.toBe(made.serverSecret);
    expect(row(booted)).toMatchObject({ intake: "newsletter", confirm_url: `${SITE}/subscribe/confirm`, confirm_from: "hello@remotesaffa.co.za", confirm_daily_cap: 250, rate_limit_per_hour: 20, consent_text: NEWSLETTER.consentText });
    expect(made.serverSecret).toMatch(/^pibs_/);
    expect(made.source).toMatchObject({ intake: "newsletter", newsletter: { applyTags: ["remotesaffa-subscribers"], confirmUrl: `${SITE}/subscribe/confirm`, confirmFrom: "hello@remotesaffa.co.za", confirmDailyCap: 250 } });
    const listed = await tool<Record<string, any>>(booted.harness, "list-lead-sources", {});
    expect(listed.sources[0].newsletter).toEqual(made.source.newsletter);
    for (const output of [made, listed, booted.harness.logs]) expect(JSON.stringify(output)).not.toContain(secret);
    expect(JSON.stringify(listed)).not.toMatch(/confirm_?secret/i);
  });

  it("an agent cannot make one (it always gets a signing secret), and nothing is stored", async () => {
    const booted = await bootLeads();
    expect(await refused(makeSource(booted, NEWSLETTER))).toMatch(/only a person makes it/);
    expect(booted.store.lead_sources).toHaveLength(0);
  });

  it.each([
    ["on another host", "https://evil.example/subscribe/confirm", /must be on remotesaffa.co.za exactly/],
    ["on a subdomain", "https://www.remotesaffa.co.za/subscribe/confirm", /must be on remotesaffa.co.za exactly/],
    ["with userinfo", "https://user:pw@remotesaffa.co.za/confirm", /user name or password/],
    ["with userinfo hiding another host", "https://remotesaffa.co.za@evil.example/confirm", /user name or password/],
    ["on http", "http://remotesaffa.co.za/confirm", /must start with https/],
    ["with a port", "https://remotesaffa.co.za:443/confirm", /port/],
    ["with a query", "https://remotesaffa.co.za/confirm?next=x", /query/],
    ["with an empty fragment", "https://remotesaffa.co.za/confirm#", /fragment/],
  ])("refuses confirmUrl %s and stores nothing", async (_case, confirmUrl, message) => {
    const booted = await bootLeads();
    expect(await refused(makeSourceAsPerson(booted, { ...NEWSLETTER, confirmUrl }))).toMatch(message);
    expect(booted.store.lead_sources).toHaveLength(0);
  });

  it.each([
    ["no site", { siteUrl: undefined }, /needs its site/],
    ["a sender with a name", { confirmFrom: "RemoteSaffa <hello@remotesaffa.co.za>" }, /one email address/],
    ["two senders", { confirmFrom: "a@remotesaffa.co.za, b@remotesaffa.co.za" }, /one email address/],
    ["no tags", { applyTags: [] }, /1 to 5 tags/],
    ["six tags", { applyTags: ["a", "b", "c", "d", "e", "f"] }, /at most 5 tags/],
    ["a 61-character tag", { applyTags: ["x".repeat(61)] }, /at most 60 characters/],
    ["an empty tag", { applyTags: ["  "] }, /empty tag/],
    ["a cap of 0", { confirmDailyCap: 0 }, /confirmDailyCap/],
  ])("refuses %s", async (_case, extra, message) => {
    const booted = await bootLeads();
    expect(await refused(makeSourceAsPerson(booted, { ...NEWSLETTER, ...extra }))).toMatch(message);
    expect(booted.store.lead_sources).toHaveLength(0);
  });

  it("refuses a confirmation secret in any spelling, and newsletter settings on a lead form", async () => {
    const booted = await bootLeads();
    expect(await refused(makeSourceAsPerson(booted, { ...NEWSLETTER, confirmSecret: "pibs_mine" }))).toMatch(/never set or shown/);
    expect(await refused(makeSourceAsPerson(booted, { ...NEWSLETTER, confirm_secret: "pibs_mine" }))).toMatch(/never set or shown/);
    expect(await refused(makeSource(booted, { label: "Contact", applyTags: ["x"] }))).toMatch(/applyTags belong to a newsletter form/);
    expect(booted.store.lead_sources).toHaveLength(0);
  });
});

describe("update-lead-source on a newsletter form", () => {
  it("never changes the intake to or from newsletter", async () => {
    const { booted, made } = await newsletterForm();
    const lead = await makeSource(booted, { label: "Contact", siteUrl: SITE });
    expect(await refused(tool(booted.harness, "update-lead-source", { sourceId: made.source.id, intake: "lead" }))).toMatch(/intake is set when it is made/);
    expect(await refused(tool(booted.harness, "update-lead-source", { sourceId: made.source.id, intake: "issue" }))).toMatch(/intake is set when it is made/);
    expect(await refused(tool(booted.harness, "update-lead-source", { ...NEWSLETTER, sourceId: lead.source.id }))).toMatch(/intake is set when it is made/);
    expect(booted.store.lead_sources.map((source: any) => source.intake)).toEqual(["newsletter", "lead"]);
    // Naming the intake it already has is not a change.
    expect((await tool<Record<string, any>>(booted.harness, "update-lead-source", { sourceId: made.source.id, intake: "newsletter" })).source.intake).toBe("newsletter");
  });

  it("an agent changes the settings, checked the same way; a lead form refuses them", async () => {
    const { booted, made, secret } = await newsletterForm();
    const updated = await tool<Record<string, any>>(booted.harness, "update-lead-source", { sourceId: made.source.id, applyTags: ["remotesaffa", "Remotesaffa", "friday"], confirmUrl: `${SITE}/confirm`, confirmFrom: "news@remotesaffa.co.za", confirmDailyCap: 100 });
    expect(updated.source.newsletter).toEqual({ applyTags: ["remotesaffa", "friday"], confirmUrl: `${SITE}/confirm`, confirmFrom: "news@remotesaffa.co.za", confirmDailyCap: 100 });
    expect(updated.note).toBeUndefined();
    expect(await refused(tool(booted.harness, "update-lead-source", { sourceId: made.source.id, confirmUrl: "https://shop.remotesaffa.co.za/confirm" }))).toMatch(/exactly/);
    expect(await refused(tool(booted.harness, "update-lead-source", { sourceId: made.source.id, consentText: "" }))).toMatch(/consentText cannot be empty/);
    expect(await refused(tool(booted.harness, "update-lead-source", { sourceId: made.source.id, confirmSecret: "pibs_mine" }))).toMatch(/never set or shown/);
    expect(row(booted)).toMatchObject({ confirm_url: `${SITE}/confirm`, consent_text: NEWSLETTER.consentText, confirm_secret: secret });
    const lead = await makeSource(booted, { label: "Contact" });
    expect(await refused(tool(booted.harness, "update-lead-source", { sourceId: lead.source.id, confirmFrom: "a@b.co" }))).toMatch(/belong to a newsletter form/);
  });

  it("new consent wording is allowed and says the open links stop working", async () => {
    const { booted, made, secret } = await newsletterForm();
    const updated = await tool<Record<string, any>>(booted.harness, "update-lead-source", { sourceId: made.source.id, consentText: "Yes, send me the weekly list." });
    expect(updated.note).toMatch(/confirmation link already sent stops working/);
    expect(row(booted).consent_text).toBe("Yes, send me the weekly list.");
    expect(JSON.stringify(updated)).not.toContain(secret);
  });
});

describe("rotate-lead-key with newConfirmKey", () => {
  it("replaces only the confirmation secret (an agent may): the key and signing secret stay, nothing shows the new one", async () => {
    const { booted, made, secret } = await newsletterForm();
    const before = { ...row(booted) };
    const rotated = await tool<Record<string, any>>(booted.harness, "rotate-lead-key", { sourceId: made.source.id, newConfirmKey: true });
    const fresh = row(booted).confirm_secret as string;
    expect(fresh).toMatch(/^pibs_[a-z0-9]{40}$/);
    expect(fresh).not.toBe(secret);
    expect(row(booted)).toMatchObject({ public_key: before.public_key, signing_secret: before.signing_secret, previous_key: null });
    expect(rotated).toMatchObject({ confirmKeyReplaced: true, note: expect.stringMatching(/already sent stops working/) });
    expect(JSON.stringify(rotated)).not.toContain(fresh);
    expect(JSON.stringify(booted.harness.logs)).not.toContain(fresh);
  });

  it("is refused on a lead form, and the confirmation secret cannot be passed in", async () => {
    const booted = await bootLeads();
    const lead = await makeSource(booted, { label: "Contact" });
    expect(await refused(tool(booted.harness, "rotate-lead-key", { sourceId: lead.source.id, newConfirmKey: true }))).toMatch(/newsletter form .* only/);
    expect(await refused(tool(booted.harness, "rotate-lead-key", { sourceId: lead.source.id, confirmSecret: "pibs_mine" }))).toMatch(/never set or shown/);
    expect(row(booted).public_key).toBe(lead.source.key);
  });
});

describe("the tool declarations", () => {
  it("offer the newsletter settings and never a confirmation secret", () => {
    const tools = Object.fromEntries((manifest.tools ?? []).map((entry) => [entry.name, entry.parametersSchema as { properties: Record<string, unknown> }]));
    for (const name of ["create-lead-endpoint", "update-lead-source"]) {
      expect(Object.keys(tools[name]!.properties)).toEqual(expect.arrayContaining(["applyTags", "confirmUrl", "confirmFrom", "confirmDailyCap"]));
    }
    expect(Object.keys(tools["rotate-lead-key"]!.properties)).toContain("newConfirmKey");
    for (const name of ["create-lead-endpoint", "update-lead-source", "rotate-lead-key", "list-lead-sources"]) expect(JSON.stringify(tools[name])).not.toMatch(/confirm_?secret/i);
  });
});
