/** Newsletter lead sources (intake newsletter), stage 1: the settings, their checks, the hidden confirmation secret, and a webhook that refuses them for now. */
import { describe, expect, it } from "vitest";
import { tool } from "./helpers/crm.js";
import { bootLeads, delivery, lead, makeSource, makeSourceAsPerson, signedDelivery, type Booted } from "./helpers/leads.js";
import { handleLeadWebhook } from "../src/lead-capture.js";
import { parseApplyTags, parseConfirmUrl } from "../src/lead-newsletter.js";

const SITE = "https://remotesaffa.co.za";
const NEWSLETTER = { label: "Newsletter", intake: "newsletter", siteUrl: SITE, applyTags: ["remotesaffa-subscribers"], confirmUrl: `${SITE}/subscribe/confirm`, confirmFrom: "hello@remotesaffa.co.za", consentText: "Yes, send me the Friday list." };

async function newsletter(booted: Booted, extra: Record<string, unknown> = {}) {
  return makeSourceAsPerson(booted, { ...NEWSLETTER, serverSecret: true, ...extra });
}

const refused = (promise: Promise<unknown>) => promise.then(() => "accepted", (error: unknown) => String(error));

describe("creating a newsletter form", () => {
  it("a person creates it with its signing secret; the plugin makes a confirmation secret that no output, list or log contains", async () => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    const row = booted.store.lead_sources[0]!;
    expect(row).toMatchObject({ intake: "newsletter", apply_tags: ["remotesaffa-subscribers"], confirm_url: NEWSLETTER.confirmUrl, confirm_from: "hello@remotesaffa.co.za", confirm_daily_cap: 300 });
    const secret = String(row.confirm_secret);
    expect(secret).toMatch(/^pibs_[a-z0-9]{40}$/);
    expect(secret).not.toBe(made.serverSecret);
    expect(made.source).toMatchObject({ intake: "newsletter", embed: null, newsletter: { applyTags: ["remotesaffa-subscribers"], confirmKey: { set: true } } });
    const listed = await tool(booted.harness, "list-lead-sources", {});
    const updated = await tool(booted.harness, "update-lead-source", { sourceId: made.source.id, label: "Friday list" });
    for (const output of [made, listed, updated, booted.harness.logs]) expect(JSON.stringify(output)).not.toContain(secret);
    expect(listed.sources[0]).toMatchObject({ intake: "newsletter" });
  });

  it("an agent cannot create one (it needs a signing secret, which only a person makes), and nothing is stored", async () => {
    const booted = await bootLeads();
    expect(await refused(makeSource(booted, NEWSLETTER))).toMatch(/newsletter form .* person/);
    expect(booted.store.lead_sources).toHaveLength(0);
  });

  it("refuses missing or bad settings: confirmUrl off the site's exact host, with userinfo, a port, a query or fragment, or on http", async () => {
    const booted = await bootLeads();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ confirmUrl: "https://example.com/confirm" }, /exactly/],
      [{ confirmUrl: "https://www.remotesaffa.co.za/confirm" }, /exactly/],
      [{ confirmUrl: "https://news.remotesaffa.co.za/confirm" }, /exactly/],
      [{ confirmUrl: "https://user:pw@remotesaffa.co.za/confirm" }, /user name/],
      [{ confirmUrl: "https://user@remotesaffa.co.za/confirm" }, /user name/],
      [{ confirmUrl: "http://remotesaffa.co.za/confirm" }, /https/],
      [{ confirmUrl: "https://remotesaffa.co.za:8443/confirm" }, /port/],
      [{ confirmUrl: "https://remotesaffa.co.za:443/confirm" }, /port/],
      [{ confirmUrl: "https://remotesaffa.co.za/confirm?x=1" }, /query/],
      [{ confirmUrl: "https://remotesaffa.co.za/confirm#t" }, /fragment/],
      [{ confirmUrl: "" }, /confirmUrl is required/],
      [{ siteUrl: "" }, /needs siteUrl/],
      [{ confirmFrom: "hello@remotesaffa.co.za, x@y.co" }, /one email address/],
      [{ confirmFrom: "" }, /one email address/],
      [{ applyTags: [] }, /1 to 5 tags/],
      [{ applyTags: ["a", "b", "c", "d", "e", "f"] }, /1 to 5 tags/],
      [{ applyTags: ["x".repeat(61)] }, /1 to 60/],
      [{ applyTags: undefined }, /applyTags must be a list/],
      [{ confirmDailyCap: 301 }, /1 to 300/],
      [{ confirmSecret: "pibs_mine" }, /never set or shown/],
      [{ projectId: "p1" }, /report form/],
    ];
    for (const [extra, message] of cases) expect(await refused(newsletter(booted, extra)), JSON.stringify(extra)).toMatch(message);
    expect(booted.store.lead_sources).toHaveLength(0);
  });

  it("the settings are cleaned: tags trimmed and deduplicated case-insensitively, the url kept as given", () => {
    expect(parseApplyTags([" News ", "news", "Jobs"])).toEqual(["News", "Jobs"]);
    expect(parseConfirmUrl("https://remotesaffa.co.za/subscribe/confirm", "https://remotesaffa.co.za")).toBe("https://remotesaffa.co.za/subscribe/confirm");
  });

  it("a lead or report form takes none of the newsletter settings, and a label of another intake is never turned into a newsletter", async () => {
    const booted = await bootLeads();
    expect(await refused(makeSource(booted, { label: "Contact", applyTags: ["x"] }))).toMatch(/belong to a newsletter form/);
    expect(await refused(makeSource(booted, { label: "Contact", confirmUrl: `${SITE}/c` }))).toMatch(/belong to a newsletter form/);
    await makeSource(booted, { label: "Newsletter", siteUrl: SITE });
    expect(await refused(newsletter(booted))).toMatch(/never changes to or from newsletter/);
    expect(booted.store.lead_sources).toHaveLength(1);
  });
});

describe("updating a newsletter form", () => {
  it("intake never changes to or from newsletter", async () => {
    const booted = await bootLeads();
    const plain = await makeSource(booted, { label: "Contact", siteUrl: SITE });
    const list = await newsletter(booted);
    expect(await refused(tool(booted.harness, "update-lead-source", { ...NEWSLETTER, sourceId: plain.source.id }))).toMatch(/never changes/);
    expect(await refused(tool(booted.harness, "update-lead-source", { sourceId: list.source.id, intake: "lead" }))).toMatch(/never changes/);
    expect(await refused(tool(booted.harness, "update-lead-source", { sourceId: plain.source.id, applyTags: ["x"] }))).toMatch(/belong to a newsletter form/);
    expect(booted.store.lead_sources.map((row) => row.intake)).toEqual(["lead", "newsletter"]);
  });

  it("changes the settings with the same checks, never the secret, and says when new wording voids open links", async () => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    const secret = booted.store.lead_sources[0]!.confirm_secret;
    const changed = await tool(booted.harness, "update-lead-source", { sourceId: made.source.id, applyTags: ["a", "b"], confirmDailyCap: 50, confirmFrom: "News@RemoteSaffa.co.za" });
    expect(changed.source.newsletter).toMatchObject({ applyTags: ["a", "b"], confirmDailyCap: 50, confirmFrom: "news@remotesaffa.co.za" });
    expect(changed.note).toBeUndefined();
    expect(await refused(tool(booted.harness, "update-lead-source", { sourceId: made.source.id, confirmUrl: "https://www.remotesaffa.co.za/c" }))).toMatch(/exactly/);
    expect(await refused(tool(booted.harness, "update-lead-source", { sourceId: made.source.id, confirmSecret: "pibs_mine" }))).toMatch(/never set or shown/);
    expect(await refused(tool(booted.harness, "update-lead-source", { sourceId: made.source.id, consentText: "" }))).toMatch(/needs consentText/);
    const reworded = await tool(booted.harness, "update-lead-source", { sourceId: made.source.id, consentText: "Yes, the Friday list please." });
    expect(reworded.note).toMatch(/links already sent stop working/);
    expect(booted.store.lead_sources[0]).toMatchObject({ confirm_secret: secret, consent_text: "Yes, the Friday list please.", confirm_daily_cap: 50 });
  });
});

describe("rotate-lead-key with newConfirmKey", () => {
  it("replaces only the confirmation secret (key and signing secret stay) and never shows it; a lead form has none", async () => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    const before = { ...booted.store.lead_sources[0]! };
    const rotated = await tool(booted.harness, "rotate-lead-key", { sourceId: made.source.id, newConfirmKey: true });
    const after = booted.store.lead_sources[0]!;
    expect(after.confirm_secret).toMatch(/^pibs_[a-z0-9]{40}$/);
    expect(after.confirm_secret).not.toBe(before.confirm_secret);
    expect(after).toMatchObject({ public_key: before.public_key, previous_key: null, signing_secret: before.signing_secret });
    expect(rotated).toMatchObject({ confirmKeyReplaced: true, source: { key: made.source.key } });
    expect(JSON.stringify(rotated)).not.toMatch(/pibs_/);
    expect(JSON.stringify(booted.harness.logs)).not.toMatch(/pibs_/);

    const plain = await makeSource(booted, { label: "Contact" });
    expect(await refused(tool(booted.harness, "rotate-lead-key", { sourceId: plain.source.id, newConfirmKey: true }))).toMatch(/belongs to a newsletter form/);
    // A blanked or misnamed option never falls through to a plain key rotation.
    const key = booted.store.lead_sources[0]!.public_key;
    for (const value of [true, "[REDACTED]"]) expect(await refused(tool(booted.harness, "rotate-lead-key", { sourceId: made.source.id, confirmSecret: value }))).toMatch(/never a parameter/);
    expect(booted.store.lead_sources[0]!.public_key).toBe(key);
  });
});

describe("the lead webhook and a newsletter form", () => {
  it("refuses a signed signup until the double opt-in path ships, and writes nothing", async () => {
    const booted = await bootLeads();
    const made = await newsletter(booted);
    const contacts = booted.store.contacts.length;
    expect(await refused(handleLeadWebhook(booted.harness.ctx, signedDelivery(made.serverSecret!, lead(made.source.key))))).toMatch(/not active/);
    expect(booted.store.lead_hits).toHaveLength(0);
    expect(booted.store.lead_captures).toHaveLength(0);
    expect(booted.store.consent_records).toHaveLength(0);
    expect(booted.store.contacts).toHaveLength(contacts);
    expect(booted.store.lead_sources[0]).toMatchObject({ accepted_count: 0, rejected_count: 0 });
  });

  it("every existing form still lists as lead and still takes a lead", async () => {
    const booted = await bootLeads();
    const made = await makeSource(booted, { label: "Contact" });
    const listed = await tool(booted.harness, "list-lead-sources", {});
    expect(listed.sources.map((source: { intake: string }) => source.intake)).toEqual(["lead"]);
    expect(listed.sources[0].newsletter).toBeUndefined();
    expect(await handleLeadWebhook(booted.harness.ctx, delivery(lead(made.source.key), { "x-real-ip": "203.0.113.9" }))).toMatchObject({ status: "stored" });
    expect(booted.store.lead_sources[0]).toMatchObject({ intake: "lead", apply_tags: [], confirm_secret: null });
  });
});
