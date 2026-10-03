import { describe, expect, it } from "vitest";
import { rememberPluginUiBase } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { cockpitSnapshot, leadFormsHealth, LEAD_FORM_QUIET_DAYS } from "../src/cockpit.js";
import { generateLeadKey, isLeadKey } from "../src/lead-form.js";
import { setupStatus } from "../src/setup-status.js";
import { BOARD, CO, tool, toolRaw } from "./helpers/crm.js";
import { bootLeads, delivery, lead, makeSource, makeSourceAsPerson, ip, signedDelivery } from "./helpers/leads.js";
import { createLeadEndpoint, handleLeadWebhook, makeLeadSecret, rotateLeadKey, SECRET_BY_PERSON } from "../src/lead-capture.js";
import { LEAD_CAPTURE_REFERENCE } from "../src/skills-references.js";

const UUID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const UI_BASE = `/_plugins/${UUID}/ui/`;
const TURNSTILE = { timezone: "Africa/Johannesburg", leads: { turnstileSiteKey: "0x4AAAAAAA", turnstileSecret: { type: "secret_ref", secretId: "sec-1" } } };

describe("what the plugin declares for the public endpoint", () => {
  it("asks for the webhooks.receive capability and declares one endpoint called lead", () => {
    expect(manifest.capabilities).toContain("webhooks.receive");
    expect(manifest.webhooks).toEqual([expect.objectContaining({ endpointKey: "lead", displayName: "Lead form" })]);
    expect(manifest.jobs?.map((job) => job.jobKey)).toContain("services-check");
    const names = (manifest.tools ?? []).map((tool) => tool.name);
    for (const name of ["create-lead-endpoint", "rotate-lead-key", "list-lead-sources", "update-lead-source", "start-new-client", "create-canary-client", "cleanup-canary"]) expect(names).toContain(name);
  });

  it("has settings for Turnstile with the secret as a secret reference, and a list of extra blocked domains", () => {
    const leads = (manifest.instanceConfigSchema as { properties: Record<string, any> }).properties.leads;
    expect(leads.properties.turnstileSecret.format).toBe("secret-ref");
    expect(leads.properties.turnstileSecret.type).toBeUndefined();
    expect(Object.keys(leads.properties)).toEqual(["turnstileSiteKey", "turnstileSecret", "blockedEmailDomains"]);
  });
});

describe("create-lead-endpoint", () => {
  it("makes our own form with a key", async () => {
    const booted = await bootLeads();
    const made = await makeSource(booted, { label: "Quote form" });
    expect(made.created).toBe(true);
    expect(isLeadKey(made.source.key)).toBe(true);
    expect(made.source).toMatchObject({ label: "Quote form", client: null, ownedBy: "us", status: "active", canary: false, accepted: 0, serverSecret: { set: false } });
    expect(booted.store.lead_sources).toHaveLength(1);
    expect(booted.store.lead_sources[0]).toMatchObject({ client_kind: null, client_ref: null, status: "active", canary: false, rate_limit_per_hour: 120, created_by: "agent:agent-1" });
  });

  it("returns the snippet, the endpoint and a curl test once the plugin knows its address", async () => {
    const booted = await bootLeads();
    await rememberPluginUiBase(booted.harness.ctx, UI_BASE);
    const made = await makeSource(booted, { client: "company:acme", label: "Contact form", siteUrl: "https://www.acme.co.za/contact", privacyUrl: "acme.co.za/privacy", successMessage: "Thanks, we will call you." });
    const key = made.source.key;
    expect(made.source.embed.snippet).toBe(`<!-- PiB lead form: Contact form -->\n<script async src="https://paperclip.partnersinbiz.online${UI_BASE}lead.js" data-pib-lead="${key}" data-consent="Yes, Acme Plumbing may email me news and offers. I can unsubscribe at any time." data-privacy="https://acme.co.za/privacy" data-success="Thanks, we will call you."></script>`);
    expect(made.source.embed.endpoint).toBe("https://paperclip.partnersinbiz.online/api/plugins/partnersinbiz.crm/webhooks/lead");
    expect(made.source.embed.curl).toContain("curl -sS -X POST 'https://paperclip.partnersinbiz.online/api/plugins/partnersinbiz.crm/webhooks/lead'");
    expect(made.source.embed.curl).toContain(key);
    expect(made.source.embed.signedCurl).toBeNull();
    expect(made.source.embed.steps[0]).toContain(made.source.embed.snippet);
    expect(made.source.embed.steps.join("\n")).toMatch(/repo project/);
    expect(made.source).toMatchObject({ client: "company:acme", clientName: "Acme Plumbing", ownedBy: "client", site: "https://www.acme.co.za" });
    expect(made.next).toMatch(/Install the snippet/);
  });

  it("uses the public address from the settings when one is saved", async () => {
    const booted = await bootLeads({ config: { timezone: "Africa/Johannesburg", publicBaseUrl: "https://paperclip.example.org/ignored/path" } });
    await rememberPluginUiBase(booted.harness.ctx, UI_BASE);
    const made = await makeSource(booted, {});
    expect(made.source.embed.endpoint).toBe("https://paperclip.example.org/api/plugins/partnersinbiz.crm/webhooks/lead");
    expect(made.source.embed.snippet).toContain(`src="https://paperclip.example.org${UI_BASE}lead.js"`);
  });

  it("the form wears the client's brand colour when the profile has one", async () => {
    const booted = await bootLeads();
    await rememberPluginUiBase(booted.harness.ctx, UI_BASE);
    await tool(booted.harness, "update-client-profile", { client: "company:acme", primaryColor: "#0a7a3d" });
    const made = await makeSource(booted, { client: "company:acme" });
    expect(made.source.embed.snippet).toContain('data-accent="#0A7A3D"');
  });

  it("refuses a client that is unknown or not visible, a site that is not the client's, and bad addresses", async () => {
    const booted = await bootLeads();
    expect((await toolRaw(booted.harness, "create-lead-endpoint", { client: "company:nobody" })).error).toMatch(/not found or is not visible/);
    expect((await toolRaw(booted.harness, "create-lead-endpoint", { client: "company:foreign" })).error).toMatch(/not found or is not visible/);
    expect((await toolRaw(booted.harness, "create-lead-endpoint", { client: "somebody" })).error).toMatch(/company:<id> or contact:<id>/);
    booted.store.client_sites = [
      { id: "site-acme", company_id: CO, client_kind: "company", client_ref: "acme", label: null, url: "https://www.acme.co.za/shop", site_key: "acme.co.za", platform: "wordpress", access: [], connector_status: "none", health: {}, updated_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z" },
      { id: "site-globex", company_id: CO, client_kind: "company", client_ref: "globex", label: null, url: "https://globex.test", site_key: "globex.test", platform: "other", access: [], connector_status: "none", health: {}, updated_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z" },
    ];
    expect((await toolRaw(booted.harness, "create-lead-endpoint", { client: "company:acme", siteId: "site-globex" })).error).toMatch(/not one of this client's websites/);
    expect((await toolRaw(booted.harness, "create-lead-endpoint", { siteId: "site-acme" })).error).toMatch(/belongs to a client/);
    expect((await toolRaw(booted.harness, "create-lead-endpoint", { client: "company:acme", privacyUrl: "not a url" })).error).toMatch(/privacyUrl must be a web address/);
    const ok = await tool<Record<string, any>>(booted.harness, "create-lead-endpoint", { client: "company:acme", siteId: "site-acme" });
    expect(ok.source).toMatchObject({ siteId: "site-acme", site: "https://www.acme.co.za", label: "Acme Plumbing website form" });
  });

  it("is idempotent per client and label: asking again returns the same form and key, and a new secret is never made", async () => {
    const booted = await bootLeads();
    const first = await makeSourceAsPerson(booted, { client: "company:acme", label: "Contact form", serverSecret: true });
    const again = await makeSourceAsPerson(booted, { client: "company:acme", label: "contact FORM", serverSecret: true });
    expect(again.created).toBe(false);
    expect(again.source.key).toBe(first.source.key);
    expect(again.serverSecret).toBeUndefined();
    expect(again.note).toMatch(/no new key was made/);
    expect(booted.store.lead_sources).toHaveLength(1);
    // The same label for another client is another form.
    const other = await makeSource(booted, { client: "company:globex", label: "Contact form" });
    expect(other.created).toBe(true);
    expect(other.source.key).not.toBe(first.source.key);
    // A form that was switched off for good does not block a new one.
    await booted.harness.performAction("crm.update-lead-source", { sourceId: first.source.id, status: "revoked" }, { companyId: CO, actor: BOARD });
    expect((await makeSource(booted, { client: "company:acme", label: "Contact form" })).created).toBe(true);
  });

  it("shows a server secret once, to the person who asked on the card, and never again", async () => {
    const booted = await bootLeads();
    await rememberPluginUiBase(booted.harness.ctx, UI_BASE);
    const made = await makeSourceAsPerson(booted, { serverSecret: true });
    expect(made.serverSecret).toMatch(/^pibs_[a-z0-9]{40}$/);
    expect(made.serverSecretNote).toMatch(/Shown once/);
    expect(made.source.serverSecret).toMatchObject({ set: true });
    expect(made.source.embed.signedCurl).toContain("X-PiB-Signature");
    expect(made.source.embed.signedCurl).toContain("$PIB_LEAD_SECRET");
    expect(JSON.stringify(made.source)).not.toContain(made.serverSecret);
    const listed = await tool<Record<string, any>>(booted.harness, "list-lead-sources", {});
    expect(JSON.stringify(listed)).not.toContain(made.serverSecret!);
    expect(listed.sources[0].serverSecret).toMatchObject({ set: true, keyId: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(JSON.stringify(booted.harness.logs)).not.toContain(made.serverSecret!);
  });

  it("caps the label and the wording", async () => {
    const booted = await bootLeads();
    const made = await makeSource(booted, { label: "L".repeat(300), consentText: "C".repeat(900) });
    expect(made.source.label).toHaveLength(80);
    expect(made.source.consentText).toHaveLength(500);
  });
});

describe("rotate-lead-key", () => {
  it("gives a new key, keeps the old one for 7 days and says when it stops", async () => {
    const booted = await bootLeads();
    const made = await makeSource(booted, {});
    const rotated = await tool<Record<string, any>>(booted.harness, "rotate-lead-key", { sourceId: made.source.id });
    expect(rotated.source.key).not.toBe(made.source.key);
    expect(rotated.source.previousKeyValidUntil).toBe(rotated.oldKeyValidUntil);
    const days = (Date.parse(rotated.oldKeyValidUntil) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(rotated.source.warnings).toEqual([expect.stringMatching(/old key stops working/)]);
    expect(rotated.serverSecret).toBeUndefined();
    expect(rotated.next).toMatch(/within 7 days/);
  });

  it("a person's serverSecret: true replaces the signing secret at once and shows the new one once", async () => {
    const booted = await bootLeads();
    const made = await makeSourceAsPerson(booted, { serverSecret: true });
    const rotated = await booted.harness.performAction<Record<string, any>>("crm.rotate-lead-key", { sourceId: made.source.id, serverSecret: true }, { companyId: CO, actor: BOARD });
    expect(rotated.serverSecret).toMatch(/^pibs_/);
    expect(rotated.serverSecret).not.toBe(made.serverSecret);
    expect(booted.store.lead_sources[0]!.signing_secret).toBe(rotated.serverSecret);
    expect(rotated.serverSecretNote).toMatch(/old secret no longer works/);
    // Rotating the key alone (an agent can) keeps the secret and shows none.
    const keyOnly = await tool<Record<string, any>>(booted.harness, "rotate-lead-key", { sourceId: made.source.id });
    expect(keyOnly.serverSecret).toBeUndefined();
    expect(JSON.stringify(keyOnly)).not.toContain(rotated.serverSecret);
    expect(booted.store.lead_sources[0]!.signing_secret).toBe(rotated.serverSecret);
  });

  it("refuses a form that was switched off for good, an unknown form and one of a client the caller cannot see", async () => {
    const booted = await bootLeads();
    const made = await makeSource(booted, {});
    await booted.harness.performAction("crm.update-lead-source", { sourceId: made.source.id, status: "revoked" }, { companyId: CO, actor: BOARD });
    expect((await toolRaw(booted.harness, "rotate-lead-key", { sourceId: made.source.id })).error).toMatch(/switched off for good/);
    expect((await toolRaw(booted.harness, "rotate-lead-key", { sourceId: "nope" })).error).toMatch(/was not found/);
    expect((await toolRaw(booted.harness, "rotate-lead-key", {})).error).toMatch(/sourceId is required/);
  });

  it("a form made before Turnstile was set up warns, and rotating it turns the check on", async () => {
    const booted = await bootLeads();
    const made = await makeSource(booted, {});
    booted.harness.setConfig(TURNSTILE);
    const before = await tool<Record<string, any>>(booted.harness, "list-lead-sources", {});
    expect(before.sources[0].turnstile).toBe(false);
    expect(before.sources[0].warnings).toEqual([expect.stringMatching(/predates it: run rotate-lead-key/)]);
    const rotated = await tool<Record<string, any>>(booted.harness, "rotate-lead-key", { sourceId: made.source.id });
    expect(rotated.source.turnstile).toBe(true);
    expect(booted.store.lead_sources[0]!.turnstile_site_key).toBe("0x4AAAAAAA");
  });
});

describe("who may be handed a signing secret", () => {
  const AGENT = { type: "agent" as const, agentId: "agent-1" };

  it("an agent asking for one is refused, with the way to get it, and nothing is stored or returned", async () => {
    const booted = await bootLeads();
    for (const value of [true, "true", "yes", 1]) {
      const refused = await toolRaw(booted.harness, "create-lead-endpoint", { client: "company:acme", label: "Contact form", serverSecret: value });
      expect(refused.error, String(value)).toBe(SECRET_BY_PERSON);
      expect(refused.error).toMatch(/only a person makes it/);
      expect(refused.error).toMatch(/Needs-you/);
    }
    // Refused before anything was made.
    expect(booted.store.lead_sources).toHaveLength(0);
    // An explicit false is the same as not asking.
    for (const [n, value] of [false, "", null, "false", "no", "0"].entries()) {
      expect((await makeSource(booted, { label: `Plain form ${n}`, serverSecret: value })).created, String(value)).toBe(true);
    }
    expect(booted.store.lead_sources).toHaveLength(6);
    expect(booted.store.lead_sources.every((row) => row.signing_secret === null)).toBe(true);
    expect(JSON.stringify(booted.harness.logs)).not.toMatch(/pibs_/);
  });

  it("an agent calling the board action is refused the same way (the caller's type decides, not the route)", async () => {
    const booted = await bootLeads();
    await expect(booted.harness.performAction("crm.create-lead-endpoint", { serverSecret: true }, { companyId: CO, actor: AGENT as never })).rejects.toThrow(/only a person makes it/);
    expect(booted.store.lead_sources).toHaveLength(0);
    const made = await makeSourceAsPerson(booted, {});
    await expect(booted.harness.performAction("crm.rotate-lead-key", { sourceId: made.source.id, serverSecret: true }, { companyId: CO, actor: AGENT as never })).rejects.toThrow(/only a person makes it/);
    await expect(booted.harness.performAction("crm.make-lead-secret", { sourceId: made.source.id }, { companyId: CO, actor: AGENT as never })).rejects.toThrow(/only a person makes it/);
    expect(booted.store.lead_sources[0]!.signing_secret).toBeNull();
  });

  it("an agent rotating a key with serverSecret is refused: the key does not change and the stored secret stays", async () => {
    const booted = await bootLeads();
    const made = await makeSourceAsPerson(booted, { serverSecret: true });
    const before = booted.store.lead_sources[0]!.signing_secret;
    const refused = await toolRaw(booted.harness, "rotate-lead-key", { sourceId: made.source.id, serverSecret: true });
    expect(refused.error).toBe(SECRET_BY_PERSON);
    expect(booted.store.lead_sources[0]).toMatchObject({ public_key: made.source.key, previous_key: null, signing_secret: before });
  });

  it("both conditions must hold: a person's call (not an agent id, and the action type of a user), whichever function is called", async () => {
    const booted = await bootLeads();
    const ctx = booted.harness.ctx;
    const person = { companyId: CO, userId: "local-board", agentId: null, role: "owner" } as const;
    const agentRun = { ...person, agentId: "agent-1" } as const;
    // A person's viewer called as an agent (the tool path), and an agent's viewer called as a person (an action that claims to be human).
    await expect(createLeadEndpoint(ctx, person, { serverSecret: true }, "agent")).rejects.toThrow(/only a person makes it/);
    await expect(createLeadEndpoint(ctx, person, { serverSecret: true })).rejects.toThrow(/only a person makes it/);
    await expect(createLeadEndpoint(ctx, agentRun, { serverSecret: true }, "human")).rejects.toThrow(/only a person makes it/);
    expect(booted.store.lead_sources).toHaveLength(0);
    const made = (await createLeadEndpoint(ctx, person, { serverSecret: true }, "human")) as { serverSecret?: string; source: { id: string } };
    expect(made.serverSecret).toMatch(/^pibs_/);
    await expect(rotateLeadKey(ctx, person, { sourceId: made.source.id, serverSecret: true }, "agent")).rejects.toThrow(/only a person makes it/);
    await expect(rotateLeadKey(ctx, agentRun, { sourceId: made.source.id, serverSecret: true }, "human")).rejects.toThrow(/only a person makes it/);
    await expect(makeLeadSecret(ctx, person, { sourceId: made.source.id }, "agent")).rejects.toThrow(/only a person makes it/);
    await expect(makeLeadSecret(ctx, agentRun, { sourceId: made.source.id }, "human")).rejects.toThrow(/only a person makes it/);
    expect(booted.store.lead_sources[0]!.signing_secret).toBe(made.serverSecret);
    // A person who spells it as a string still gets one (and a "false" spelling gets none).
    const spelled = (await createLeadEndpoint(ctx, person, { label: "Second", serverSecret: "true" }, "human")) as { serverSecret?: string };
    expect(spelled.serverSecret).toMatch(/^pibs_/);
    const none = (await createLeadEndpoint(ctx, person, { label: "Third", serverSecret: "false" }, "human")) as { serverSecret?: string };
    expect(none.serverSecret).toBeUndefined();
  });

  it("the agent tools no longer offer the parameter, and no agent text tells an agent to ask for it", () => {
    for (const name of ["create-lead-endpoint", "rotate-lead-key"]) {
      const tool = (manifest.tools ?? []).find((row) => row.name === name)!;
      expect(Object.keys((tool.parametersSchema as { properties: Record<string, unknown> }).properties), name).not.toContain("serverSecret");
      expect(tool.description, name).not.toMatch(/serverSecret/);
      expect(tool.description, name).toMatch(/only a person/);
    }
    expect(LEAD_CAPTURE_REFERENCE).not.toContain("serverSecret");
    expect(LEAD_CAPTURE_REFERENCE).toMatch(/only a PERSON makes it/);
    expect(LEAD_CAPTURE_REFERENCE).toMatch(/never see it and never ask for it/);
  });

  it("the form's view tells an agent a secret exists (and its short id), never what it is", async () => {
    const booted = await bootLeads();
    const made = await makeSourceAsPerson(booted, { serverSecret: true });
    const asAgent = await tool<Record<string, any>>(booted.harness, "list-lead-sources", {});
    expect(asAgent.sources[0].serverSecret).toMatchObject({ set: true });
    expect(JSON.stringify(asAgent)).not.toContain(made.serverSecret!);
    expect(JSON.stringify(asAgent)).not.toMatch(/pibs_/);
    const updated = await tool<Record<string, any>>(booted.harness, "update-lead-source", { sourceId: made.source.id, label: "Renamed" });
    expect(JSON.stringify(updated)).not.toMatch(/pibs_/);
  });

  it("a person makes or replaces a signing secret on the card without changing the key; the old secret stops at once", async () => {
    const booted = await bootLeads();
    const made = await makeSourceAsPerson(booted, {});
    expect(made.serverSecret).toBeUndefined();
    const first = await booted.harness.performAction<Record<string, any>>("crm.make-lead-secret", { sourceId: made.source.id }, { companyId: CO, actor: BOARD });
    expect(first.serverSecret).toMatch(/^pibs_[a-z0-9]{40}$/);
    expect(first.serverSecretNote).toMatch(/Shown once/);
    expect(first.source).toMatchObject({ key: made.source.key, serverSecret: { set: true } });
    expect(JSON.stringify(first.source)).not.toContain(first.serverSecret);
    expect(booted.store.lead_sources[0]).toMatchObject({ public_key: made.source.key, previous_key: null, signing_secret: first.serverSecret });
    expect(await handleLeadWebhook(booted.harness.ctx, signedDelivery(first.serverSecret, lead(made.source.key)))).toMatchObject({ status: "stored" });

    const second = await booted.harness.performAction<Record<string, any>>("crm.make-lead-secret", { sourceId: made.source.id }, { companyId: CO, actor: BOARD });
    expect(second.serverSecret).not.toBe(first.serverSecret);
    expect(second.serverSecretNote).toMatch(/old secret no longer works/);
    const oldOne = await handleLeadWebhook(booted.harness.ctx, signedDelivery(first.serverSecret, lead(made.source.key, { email: "other@smith-plumbing.test" }), { headers: { "x-real-ip": ip(81) } })).then(() => null, (error: unknown) => error);
    expect(String(oldOne)).toMatch(/does not match/);
    expect(await handleLeadWebhook(booted.harness.ctx, signedDelivery(second.serverSecret, lead(made.source.key, { email: "other@smith-plumbing.test" }), { headers: { "x-real-ip": ip(82) } }))).toMatchObject({ status: "stored" });
    expect(JSON.stringify(booted.harness.logs)).not.toMatch(/pibs_/);
  });

  it("a signing secret cannot be made for a form that was switched off for good, a form of another workspace, or without a form", async () => {
    const booted = await bootLeads();
    const made = await makeSourceAsPerson(booted, {});
    await booted.harness.performAction("crm.update-lead-source", { sourceId: made.source.id, status: "revoked" }, { companyId: CO, actor: BOARD });
    await expect(booted.harness.performAction("crm.make-lead-secret", { sourceId: made.source.id }, { companyId: CO, actor: BOARD })).rejects.toThrow(/switched off for good/);
    await expect(booted.harness.performAction("crm.make-lead-secret", { sourceId: "nope" }, { companyId: CO, actor: BOARD })).rejects.toThrow(/was not found/);
    await expect(booted.harness.performAction("crm.make-lead-secret", {}, { companyId: CO, actor: BOARD })).rejects.toThrow(/sourceId is required/);
  });
});

describe("update-lead-source", () => {
  it("an agent pauses and resumes a form and changes its wording; the paused form takes no lead", async () => {
    const booted = await bootLeads();
    const made = await makeSource(booted, { label: "Contact form" });
    const paused = await tool<Record<string, any>>(booted.harness, "update-lead-source", { sourceId: made.source.id, status: "paused", consentText: "Yes Acme may email me.", label: "Contact page form", successMessage: "Thanks!" });
    expect(paused.source).toMatchObject({ status: "paused", consentText: "Yes Acme may email me.", label: "Contact page form", successMessage: "Thanks!" });
    await expect(handleLeadWebhook(booted.harness.ctx, delivery(lead(made.source.key)))).rejects.toThrow(/not active/);
    await tool(booted.harness, "update-lead-source", { sourceId: made.source.id, status: "active" });
    expect(await handleLeadWebhook(booted.harness.ctx, delivery(lead(made.source.key)))).toMatchObject({ status: "stored" });
  });

  it("only a person switches a form off for good, and it cannot be turned back on", async () => {
    const booted = await bootLeads();
    const made = await makeSource(booted, {});
    expect((await toolRaw(booted.harness, "update-lead-source", { sourceId: made.source.id, status: "revoked" })).error).toMatch(/Only a person can switch a form off for good/);
    expect(booted.store.lead_sources[0]!.status).toBe("active");
    const revoked = await booted.harness.performAction<Record<string, any>>("crm.update-lead-source", { sourceId: made.source.id, status: "revoked" }, { companyId: CO, actor: BOARD });
    expect(revoked.source).toMatchObject({ status: "revoked", embed: null });
    expect((await toolRaw(booted.harness, "update-lead-source", { sourceId: made.source.id, status: "active" })).error).toMatch(/cannot be turned on again/);
    await expect(handleLeadWebhook(booted.harness.ctx, delivery(lead(made.source.key)))).rejects.toThrow(/not active/);
    expect((await toolRaw(booted.harness, "update-lead-source", { sourceId: made.source.id, status: "deleted" })).error).toMatch(/status must be/);
  });
});

describe("list-lead-sources", () => {
  it("lists forms with how they are doing, filters by client and own, and hides a client the caller cannot see", async () => {
    const booted = await bootLeads();
    const own = await makeSource(booted, { label: "Our form" });
    const acme = await makeSource(booted, { client: "company:acme", label: "Acme form" });
    await makeSource(booted, { client: "company:globex", label: "Globex form" });
    booted.store.lead_sources.push({ ...booted.store.lead_sources[0]!, id: "ghost", client_kind: "company", client_ref: "foreign", label: "Ghost form", public_key: generateLeadKey(), created_at: "2026-09-01T00:00:00Z" });

    const all = await tool<Record<string, any>>(booted.harness, "list-lead-sources", {});
    expect(all.sources.map((s: { label: string }) => s.label)).toEqual(["Our form", "Acme form", "Globex form"]);
    expect((await tool<Record<string, any>>(booted.harness, "list-lead-sources", { client: "company:acme" })).sources.map((s: { id: string }) => s.id)).toEqual([acme.source.id]);
    expect((await tool<Record<string, any>>(booted.harness, "list-lead-sources", { ownOnly: true })).sources.map((s: { id: string }) => s.id)).toEqual([own.source.id]);
    expect((await toolRaw(booted.harness, "list-lead-sources", { client: "company:foreign" })).error).toMatch(/not found or is not visible/);
    expect((await tool<Record<string, any>>(booted.harness, "list-lead-sources", { client: "company:globex" })).sources).toHaveLength(1);
  });

  it("warns about a form that took no lead in days, and counts what it took", async () => {
    const booted = await bootLeads();
    const made = await makeSource(booted, {});
    booted.store.lead_sources[0]!.created_at = new Date(Date.now() - 5 * 86_400_000).toISOString();
    let listed = await tool<Record<string, any>>(booted.harness, "list-lead-sources", {});
    expect(listed.sources[0].warnings).toEqual([expect.stringMatching(/No lead has arrived yet/)]);
    await handleLeadWebhook(booted.harness.ctx, delivery(lead(made.source.key)));
    listed = await tool<Record<string, any>>(booted.harness, "list-lead-sources", {});
    expect(listed.sources[0]).toMatchObject({ accepted: 1, rejected: 0 });
    expect(listed.sources[0].lastLeadAt).toBeTruthy();
    expect(listed.sources[0].warnings).toBeUndefined();
  });

  it("says what to do when there are none", async () => {
    const booted = await bootLeads();
    expect((await tool<Record<string, any>>(booted.harness, "list-lead-sources", {})).next).toMatch(/create-lead-endpoint/);
  });
});

describe("the client page", () => {
  it("lists the client's own forms, never another client's, and hides one that was switched off for good", async () => {
    const booted = await bootLeads();
    const acme = await makeSource(booted, { client: "company:acme", label: "Acme form" });
    await makeSource(booted, { client: "company:globex", label: "Globex form" });
    const gone = await makeSource(booted, { client: "company:acme", label: "Old form" });
    await booted.harness.performAction("crm.update-lead-source", { sourceId: gone.source.id, status: "revoked" }, { companyId: CO, actor: BOARD });
    const ws = await booted.harness.performAction<Record<string, any>>("crm.client-workspace", { client: "company:acme" }, { companyId: CO, actor: BOARD });
    expect(ws.leadForms.map((form: { label: string }) => form.label)).toEqual(["Acme form"]);
    expect(ws.leadForms[0]).toMatchObject({ id: acme.source.id, status: "active", accepted: 0, serverSecret: { set: false } });
    expect(JSON.stringify(ws.leadForms)).not.toMatch(/pibs_/);
  });
});

describe("the setup checklist and the health check", () => {
  it("has nothing about lead forms for a company that has none", async () => {
    const booted = await bootLeads();
    const status = await setupStatus(booted.harness.ctx, CO);
    expect(status.items.map((row) => row.key)).not.toEqual(expect.arrayContaining(["turnstile"]));
    expect(status.items.some((row) => row.key.startsWith("lead-form:"))).toBe(false);
  });

  it("one item per active form: Install the lead form on <site>, with the exact snippet, until its first lead", async () => {
    const booted = await bootLeads();
    await rememberPluginUiBase(booted.harness.ctx, UI_BASE);
    const made = await makeSource(booted, { client: "company:acme", label: "Contact form", siteUrl: "https://www.acme.co.za" });
    await makeSource(booted, { label: "Paused form" });
    await tool(booted.harness, "update-lead-source", { sourceId: booted.store.lead_sources[1]!.id, status: "paused" });
    const status = await setupStatus(booted.harness.ctx, CO);
    const items = status.items.filter((row) => row.key.startsWith("lead-form:"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: `lead-form:${made.source.id}`, title: "Install the lead form on www.acme.co.za", status: "missing", required: false, hrefLabel: "Open the client page", href: "/crm?client=company%3Aacme" });
    expect(items[0]!.detail).toMatch(/the client's, kept on their CRM page/);
    expect(items[0]!.steps![0]).toContain(made.source.embed.snippet);
    expect(items[0]!.agentNext).toMatch(/Inbound Qualifier/);

    await handleLeadWebhook(booted.harness.ctx, delivery(lead(made.source.key)));
    const after = (await setupStatus(booted.harness.ctx, CO)).items.find((row) => row.key === `lead-form:${made.source.id}`)!;
    expect(after).toMatchObject({ status: "done", steps: undefined });
    expect(after.detail).toMatch(/Taking leads: 1 so far/);
  });

  it("a form with no site is named by its label", async () => {
    const booted = await bootLeads();
    await makeSource(booted, { label: "Quote form" });
    const item = (await setupStatus(booted.harness.ctx, CO)).items.find((row) => row.key.startsWith("lead-form:"))!;
    expect(item.title).toBe("Install the lead form: Quote form");
  });

  it("the canary's form is not listed", async () => {
    const booted = await bootLeads();
    await makeSource(booted, {});
    expect((await setupStatus(booted.harness.ctx, CO)).items.some((row) => row.key.startsWith("lead-form:"))).toBe(true);
    booted.store.lead_sources[0]!.canary = true;
    expect((await setupStatus(booted.harness.ctx, CO)).items.some((row) => row.key.startsWith("lead-form:"))).toBe(false);
  });

  it("the spam-protection item says exactly what the owner does, with a deep link, and turns done when both keys are saved", async () => {
    const booted = await bootLeads();
    await makeSource(booted, {});
    let item = (await setupStatus(booted.harness.ctx, CO)).items.find((row) => row.key === "turnstile")!;
    expect(item).toMatchObject({ status: "optional", required: false });
    expect(item.steps![0]).toContain("https://dash.cloudflare.com/?to=/:account/turnstile");
    expect(item.steps!.join(" ")).toMatch(/site key and secret/);
    expect(item.steps!.join(" ")).toMatch(/Save Configuration/);
    expect(item.agentNext).toMatch(/rotates their key/);
    booted.harness.setConfig({ timezone: "Africa/Johannesburg", leads: { turnstileSiteKey: "0x4AAA" } });
    item = (await setupStatus(booted.harness.ctx, CO)).items.find((row) => row.key === "turnstile")!;
    expect(item.detail).toMatch(/site key is saved but the secret is not/);
    booted.harness.setConfig(TURNSTILE);
    item = (await setupStatus(booted.harness.ctx, CO)).items.find((row) => row.key === "turnstile")!;
    expect(item).toMatchObject({ status: "done", steps: undefined });
  });

  it("the Cockpit warns about a form that never took a lead in a week, and says nothing for a company with no forms", async () => {
    const booted = await bootLeads();
    expect(await leadFormsHealth(booted.harness.ctx, CO)).toBeNull();
    expect((await cockpitSnapshot(booted.harness.ctx, CO)).health.some((row) => row.key === "lead-forms")).toBe(false);
    const made = await makeSource(booted, { label: "Contact form" });
    expect(await leadFormsHealth(booted.harness.ctx, CO)).toMatchObject({ key: "lead-forms", status: "ok" });
    booted.store.lead_sources[0]!.created_at = new Date(Date.now() - (LEAD_FORM_QUIET_DAYS + 1) * 86_400_000).toISOString();
    const warn = await leadFormsHealth(booted.harness.ctx, CO);
    expect(warn).toMatchObject({ key: "lead-forms", status: "warn", detail: expect.stringContaining("Contact form") });
    expect(warn!.fix).toMatch(/snippet is probably not on the site/);
    expect((await cockpitSnapshot(booted.harness.ctx, CO)).health.find((row) => row.key === "lead-forms")).toMatchObject({ status: "warn" });
    // A form that took a lead is fine however old it is.
    await handleLeadWebhook(booted.harness.ctx, delivery(lead(made.source.key), { "x-real-ip": ip(5) }));
    expect(await leadFormsHealth(booted.harness.ctx, CO)).toMatchObject({ status: "ok" });
  });
});
