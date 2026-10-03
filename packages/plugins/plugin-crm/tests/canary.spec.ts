import { describe, expect, it } from "vitest";
import { CANARY_DOMAIN, CANARY_NAME, CANARY_RULES, canaryAccountId, canaryContactId, canaryEmail, isCanaryAccount, isCanaryContact, isCanaryEmail, isCanaryId } from "../src/canary-flag.js";
import { CANARY_JOURNEY, cleanupCanary, ensureCanaryClient } from "../src/canary.js";
import { handleLeadWebhook } from "../src/lead-capture.js";
import { CRM_MUTATIONS } from "../src/sync.js";
import { BOARD, CO, boot, contact, crmIssues, deal, seed, tool, toolRaw } from "./helpers/crm.js";
import type { Store } from "./helpers/fake-db.js";
import { bootLeads, delivery, lead, makeSource } from "./helpers/leads.js";

const ACCOUNT = canaryAccountId(CO);
const CONTACT = canaryContactId(CO);
const viewer = { companyId: CO, userId: "local-board", agentId: null, role: "owner" } as const;
const PAST = "2026-09-01T08:00:00.000Z";

describe("what makes a record the canary's", () => {
  it("derives stable ids that no real record can have, per Paperclip company", () => {
    expect(ACCOUNT).toMatch(/^canary-[0-9a-f]{8}$/);
    expect(CONTACT).toMatch(/^canary-contact-[0-9a-f]{8}$/);
    expect(canaryAccountId(CO)).toBe(ACCOUNT);
    expect(canaryAccountId("co-2")).not.toBe(ACCOUNT);
    // Real ids are UUIDs.
    expect(isCanaryId("0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d")).toBe(false);
    expect(isCanaryId(ACCOUNT)).toBe(true);
    expect(isCanaryId(undefined)).toBe(false);
    expect(CANARY_NAME).toBe("PiB Canary Co");
  });

  it("only ever puts the canary on an address no mail system can deliver to", () => {
    expect(canaryEmail()).toBe(`canary@${CANARY_DOMAIN}`);
    expect(CANARY_DOMAIN.endsWith(".invalid")).toBe(true);
    expect(canaryEmail("Jane Doe+x")).toBe("janedoex@canary.invalid");
    expect(isCanaryEmail("anyone@canary.invalid")).toBe(true);
    expect(isCanaryEmail("anyone@mail.test.invalid")).toBe(true);
    expect(isCanaryEmail("anyone@acme.co.za")).toBe(false);
    expect(isCanaryEmail(undefined)).toBe(false);
  });

  it("flags a contact by flag, tag, id or by having only canary addresses; and an account by flag, tag or id", () => {
    expect(isCanaryContact({ custom: { canary: true } })).toBe(true);
    expect(isCanaryContact({ tags: ["Lead", "CANARY"] })).toBe(true);
    expect(isCanaryContact({ id: CONTACT })).toBe(true);
    expect(isCanaryContact({ emails: ["a@canary.invalid", "b@x.invalid"] })).toBe(true);
    expect(isCanaryContact({ emails: ["a@canary.invalid", "real@acme.co.za"] })).toBe(false);
    expect(isCanaryContact({ emails: [], tags: [], custom: {} })).toBe(false);
    expect(isCanaryContact({ id: "ada", emails: ["ada@acme.co.za"], tags: ["decision-maker"] })).toBe(false);
    expect(isCanaryAccount({ custom: { canary: true } })).toBe(true);
    expect(isCanaryAccount({ id: ACCOUNT })).toBe(true);
    expect(isCanaryAccount({ id: "acme", tags: ["retainer"] })).toBe(false);
  });

  it("says what is forbidden for the canary, in plain rules", () => {
    expect(CANARY_RULES.join(" ")).toMatch(/draft or a dry run/);
    expect(CANARY_RULES.join(" ")).toMatch(/@canary\.invalid/);
    expect(CANARY_RULES.join(" ")).toMatch(/cleanup-canary/);
    expect(CANARY_JOURNEY.map((step) => step.split(":")[0])).toEqual(["Lead", "Qualify", "Quote", "Won", "Invoice", "Payment proof", "Care", "Clean up"]);
  });
});

describe("create-canary-client", () => {
  it("makes the flagged company, its contact on a canary address, and a canary lead form, and says how to run the journey", async () => {
    const { harness, store } = await boot();
    const result = await tool<Record<string, any>>(harness, "create-canary-client", {});
    expect(result).toMatchObject({ created: true, client: `company:${ACCOUNT}`, name: "PiB Canary Co", link: `/PIB/crm?client=company%3A${ACCOUNT}`, contact: { ref: `contact:${CONTACT}`, email: "canary@canary.invalid" } });
    expect(result.rules).toEqual(CANARY_RULES);
    expect(result.journey).toEqual(CANARY_JOURNEY);
    expect(result.leadForm).toMatchObject({ label: "Canary form", canary: true, client: `company:${ACCOUNT}`, status: "active" });

    const account = store.companies.find((row) => row.id === ACCOUNT)!;
    expect(account).toMatchObject({ name: "PiB Canary Co", domain: "canary.invalid", lifecycle: "prospect", tags: ["canary"], custom: { canary: true, dryRun: true } });
    const person = store.contacts.find((row) => row.id === CONTACT)!;
    expect(person).toMatchObject({ name: "Canary Contact", emails: ["canary@canary.invalid"], lifecycle: "lead", tags: ["canary", "lead"], custom: { canary: true, dryRun: true } });
    expect(store.contact_companies).toEqual(expect.arrayContaining([expect.objectContaining({ contact_id: CONTACT, account_id: ACCOUNT, role_label: "owner" })]));
    expect(store.lead_sources[0]).toMatchObject({ canary: true, client_kind: "company", client_ref: ACCOUNT, label: "Canary form" });
    // The other modules hear about it like any client: creating and removing it are mutations that share the change feed.
    for (const name of ["create-canary-client", "crm.create-canary-client", "cleanup-canary", "crm.cleanup-canary"]) expect(CRM_MUTATIONS.has(name), name).toBe(true);
  });

  it("is idempotent: asking again returns the same client, contact and form and creates nothing", async () => {
    const { harness, store } = await boot();
    const first = await tool<Record<string, any>>(harness, "create-canary-client", {});
    const companies = store.companies.length;
    const contacts = store.contacts.length;
    const second = await tool<Record<string, any>>(harness, "create-canary-client", {});
    expect(second.created).toBe(false);
    expect(second.client).toBe(first.client);
    expect(second.leadForm.key).toBe(first.leadForm.key);
    expect(store.companies).toHaveLength(companies);
    expect(store.contacts).toHaveLength(contacts);
    expect(store.lead_sources).toHaveLength(1);
    expect(store.contact_companies.filter((row) => row.account_id === ACCOUNT)).toHaveLength(1);
    // The board action is the same thing.
    const viaAction = await harness.performAction<Record<string, any>>("crm.create-canary-client", {}, { companyId: CO, actor: BOARD });
    expect(viaAction.client).toBe(first.client);
  });

  it("repairs a canary that lost its contact or its link", async () => {
    const { harness, store } = await boot();
    await tool(harness, "create-canary-client", {});
    store.contact_companies = store.contact_companies.filter((row) => row.contact_id !== CONTACT);
    const again = await tool<Record<string, any>>(harness, "create-canary-client", {});
    expect(again.created).toBe(true);
    expect(store.contact_companies.filter((row) => row.account_id === ACCOUNT)).toHaveLength(1);
  });

  it("shows up as the canary when an agent reads it, with the rules", async () => {
    const { harness } = await boot();
    await tool(harness, "create-canary-client", {});
    const company = await tool<Record<string, any>>(harness, "get-company", { companyRecordId: `company:${ACCOUNT}` });
    expect(company).toMatchObject({ canary: true, tags: ["canary"] });
    expect(company.canaryRules).toEqual(CANARY_RULES);
    const person = await tool<Record<string, any>>(harness, "get-contact", { contactId: `contact:${CONTACT}` });
    expect(person).toMatchObject({ canary: true, emails: ["canary@canary.invalid"] });
    const profile = await tool<Record<string, any>>(harness, "get-client-profile", { client: `company:${ACCOUNT}` });
    expect(profile.canary).toBe(true);
    // A real client has no such flag.
    expect((await tool<Record<string, any>>(harness, "get-company", { companyRecordId: "company:acme" })).canary).toBeUndefined();
    expect((await tool<Record<string, any>>(harness, "get-contact", { contactId: "contact:ada" })).canary).toBeUndefined();
  });
});

describe("the canary's lead form", () => {
  it("takes a lead on a canary address through the public endpoint and files it as the canary client's lead; a normal form refuses that address", async () => {
    const booted = await bootLeads();
    const canary = await tool<Record<string, any>>(booted.harness, "create-canary-client", {});
    const normal = await makeSource(booted, { label: "Real form" });
    const body = (key: string) => lead(key, { email: "tester@canary.invalid", name: "Test Lead" });
    expect(await handleLeadWebhook(booted.harness.ctx, delivery(body(canary.leadForm.key)))).toMatchObject({ status: "stored", client: `company:${ACCOUNT}` });
    expect(booted.store.client_leads).toEqual([expect.objectContaining({ client_ref: ACCOUNT, email: "tester@canary.invalid", name: "Test Lead" })]);
    const issues = await crmIssues(booted.harness);
    expect(issues[0]!.title).toBe("Lead for PiB Canary Co: Test Lead");
    await expect(handleLeadWebhook(booted.harness.ctx, delivery(body(normal.source.key), { "x-real-ip": "203.0.113.50" }))).rejects.toThrow(/permanent email/);
  });
});

describe("a sequence for the canary never emails", () => {
  const row = (contactId: string) => ({ id: "e1", company_id: CO, sequence_id: "seq-mail", contact_id: contactId, status: "running", step_position: 1, next_due_at: PAST, open_issue_id: null, sending_key: null, mail_thread_id: null, mail_last_message_id: null, created_at: "2026-09-01T00:00:00Z" });

  it("records the step as a dry run and moves on, with nothing sent or queued", async () => {
    const { harness, store, emit } = await boot();
    await tool(harness, "create-canary-client", {});
    store.enrollments = [row(CONTACT)];
    await harness.runJob("open-due-steps");
    expect(store.outbox).toHaveLength(0);
    expect(emit).not.toHaveBeenCalledWith("mail.send.requested", expect.anything(), expect.anything());
    expect(store.enrollments[0]).toMatchObject({ status: "done", sending_key: null });
    const note = store.activities.find((activity) => activity.kind === "email_sent" && activity.record_id === CONTACT)!;
    expect(note.body).toMatch(/Canary dry run: the email for step 1 .* was NOT sent/);
    expect(note.meta).toEqual({ dryRun: true });
    // Running the job again does nothing more.
    await harness.runJob("open-due-steps");
    expect(store.activities.filter((activity) => activity.kind === "email_sent" && activity.record_id === CONTACT)).toHaveLength(1);
  });

  it("a contact that only has canary addresses is held to the same rule even when it is not flagged", async () => {
    const store: Store = seed();
    store.contacts!.push(contact("tester", "Tester", { emails: ["t@canary.invalid"] }));
    store.enrollments = [row("tester")];
    const { harness, emit } = await boot({ store });
    await harness.runJob("open-due-steps");
    expect(emit).not.toHaveBeenCalledWith("mail.send.requested", expect.anything(), expect.anything());
    expect(store.enrollments[0]!.status).toBe("done");
  });

  it("the same sequence for a real contact still sends (the guard is only for the canary)", async () => {
    const store: Store = seed();
    store.enrollments = [row("ada")];
    const { harness, emit } = await boot({ store });
    await harness.runJob("open-due-steps");
    expect(emit).toHaveBeenCalledWith("mail.send.requested", CO, expect.objectContaining({ key: "crm:seq:e1:1" }));
    expect(store.outbox).toHaveLength(1);
  });
});

describe("cleanup-canary", () => {
  it("needs confirm: true, and says when there is nothing to clean", async () => {
    const { harness } = await boot();
    expect((await toolRaw(harness, "cleanup-canary", {})).error).toMatch(/pass confirm true/);
    expect((await toolRaw(harness, "cleanup-canary", { confirm: "yes" })).error).toMatch(/pass confirm true/);
    expect(await tool(harness, "cleanup-canary", { confirm: true })).toMatchObject({ cleaned: false, note: "There is no canary client in this workspace." });
  });

  it("removes the canary's own records and nothing else, and tells the other modules", async () => {
    const booted = await bootLeads();
    const { harness, store, emit } = booted;
    const created = await tool<Record<string, any>>(harness, "create-canary-client", {});
    // A journey's leftovers: a lead, a deal and its activity, an enrollment, a profile, a site, a project link, a service step, consent.
    await handleLeadWebhook(harness.ctx, delivery(lead(created.leadForm.key, { email: "tester@canary.invalid", consent: true, consentText: "Yes" })));
    store.deals.push(deal("d-canary", "Canary retainer", { account_id: ACCOUNT, contact_id: CONTACT }));
    store.activities.push({ id: "a-c1", company_id: CO, record_type: "deal", record_id: "d-canary", kind: "note", body: "quote drafted", issue_id: null, meta: null, source_key: null, created_at: PAST });
    store.enrollments = [{ id: "e-c", company_id: CO, sequence_id: "seq-intro", contact_id: CONTACT, status: "running", step_position: 1, next_due_at: PAST, open_issue_id: null, sending_key: null, created_at: PAST }];
    await tool(harness, "update-client-profile", { client: `company:${ACCOUNT}`, brandVoice: "Test", primaryColor: "#112233" });
    store.client_sites = [{ id: "site-c", company_id: CO, client_kind: "company", client_ref: ACCOUNT, url: "https://canary.invalid", site_key: "canary.invalid", platform: "other", access: [], connector_status: "none", health: {}, created_at: PAST, updated_at: PAST }];
    store.site_changes = [{ id: "sc1", company_id: CO, site_id: "site-c", endpoint: "seo/set", ok: true, created_at: PAST }];
    store.client_projects = [{ id: "cp-c", company_id: CO, client_kind: "company", client_ref: ACCOUNT, project_id: "proj-canary", created_at: PAST }];
    store.service_onboarding = [{ id: "so1", company_id: CO, client_kind: "company", client_ref: ACCOUNT, service: "seo", status: "open", issue_id: null, opened_at: PAST }];
    // A real person linked to the canary company (not flagged) must be unlinked, not deleted.
    store.contact_companies.push({ id: "l-real", company_id: CO, contact_id: "ada", account_id: ACCOUNT, role_label: "staff", created_at: PAST });
    const realCompanies = store.companies.filter((row) => row.id !== ACCOUNT).map((row) => row.id);
    const realContacts = store.contacts.filter((row) => row.id !== CONTACT).map((row) => row.id);
    const realDeals = store.deals.filter((row) => row.id !== "d-canary").map((row) => row.id);
    expect(store.consent_records.length).toBeGreaterThan(0);
    emit.mockClear();

    const result = await tool<Record<string, any>>(harness, "cleanup-canary", { confirm: true });
    expect(result).toEqual({ cleaned: true, company: `company:${ACCOUNT}`, contacts: 1, deals: 1, leadSources: 1 });

    expect(store.companies.map((row) => row.id)).toEqual(realCompanies);
    expect(store.contacts.map((row) => row.id)).toEqual(realContacts);
    expect(store.deals.map((row) => row.id)).toEqual(realDeals);
    for (const table of ["lead_sources", "lead_captures", "lead_hits", "consent_records", "client_leads", "client_profiles", "client_sites", "site_changes", "client_projects", "service_onboarding", "enrollments"]) {
      expect(store[table], table).toEqual([]);
    }
    expect(store.activities.filter((row) => [ACCOUNT, CONTACT, "d-canary"].includes(row.record_id))).toEqual([]);
    expect(store.contact_companies.filter((row) => row.account_id === ACCOUNT)).toEqual([]);
    // The real person is still there, unlinked.
    expect(store.contacts.find((row) => row.id === "ada")).toBeTruthy();
    // Others hear about it.
    const tells = store.handoffs.map((row) => row.event);
    expect(tells).toEqual(expect.arrayContaining(["company.deleted", "contact.deleted"]));
    expect(emit).toHaveBeenCalledWith("company.deleted", CO, expect.objectContaining({ id: ACCOUNT }));
    expect(emit).toHaveBeenCalledWith("contact.deleted", CO, expect.objectContaining({ id: CONTACT }));
    // Done once: asking again finds nothing.
    expect(await tool(harness, "cleanup-canary", { confirm: true })).toMatchObject({ cleaned: false });
    // And the canary can be made again afterwards.
    expect((await tool<Record<string, any>>(harness, "create-canary-client", {})).created).toBe(true);
  });

  it("only deletes contacts that are flagged AND have only canary addresses: a person with no address, or a flagged one with a real address, is unlinked and kept", async () => {
    const store: Store = seed();
    const { harness } = await boot({ store });
    await ensureCanaryClient(harness.ctx, viewer);
    // Not flagged at all and no address (so `emails.every(...)` is vacuously true): must not be mistaken for a canary contact.
    store.contacts.push(contact("nobody", "Nobody Noaddress", { emails: [], tags: [], custom: {} }));
    // Tagged canary by someone, but it has a real address: not a test record.
    store.contacts.push(contact("tagged-real", "Tagged But Real", { emails: ["real@acme.co.za"], tags: ["canary"], custom: {} }));
    for (const id of ["nobody", "tagged-real"]) store.contact_companies.push({ id: `l-${id}`, company_id: CO, contact_id: id, account_id: ACCOUNT, role_label: "staff", created_at: PAST });

    const result = await cleanupCanary(harness.ctx, viewer, { confirm: true });
    expect(result).toMatchObject({ cleaned: true, contacts: 1 });
    expect(store.contacts.map((row) => row.id)).toEqual(expect.arrayContaining(["nobody", "tagged-real", "ada"]));
    expect(store.contacts.some((row) => row.id === CONTACT)).toBe(false);
    expect(store.contact_companies.filter((row) => row.account_id === ACCOUNT)).toEqual([]);
  });

  it("leaves a record alone that has the canary id but is not flagged as the canary", async () => {
    const store: Store = seed();
    store.companies!.push({ ...store.companies![0]!, id: ACCOUNT, name: "Real client with an odd id", custom: {}, tags: [] });
    const { harness } = await boot({ store });
    await expect(cleanupCanary(harness.ctx, viewer, { confirm: true })).rejects.toThrow(/not flagged as the canary: it was left alone/);
    expect(store.companies!.some((row) => row.id === ACCOUNT)).toBe(true);
  });

  it("is a board action too, and never touches a real client", async () => {
    const { harness, store } = await boot();
    await ensureCanaryClient(harness.ctx, viewer);
    const before = JSON.stringify([store.companies.filter((row) => row.id === "acme"), store.deals.filter((row) => row.id === "d-acme")]);
    expect(await harness.performAction("crm.cleanup-canary", { confirm: true }, { companyId: CO, actor: BOARD })).toMatchObject({ cleaned: true });
    expect(JSON.stringify([store.companies.filter((row) => row.id === "acme"), store.deals.filter((row) => row.id === "d-acme")])).toBe(before);
    await expect(harness.performAction("crm.cleanup-canary", {}, { companyId: CO, actor: BOARD })).rejects.toThrow(/pass confirm true/);
  });
});
