import { describe, expect, it } from "vitest";
import { moduleOfPlugin, PIB_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import { collectPersonData, consentGaps, eraseSubjectInCrm, findPerson, privacyHealth, reannounceAll } from "../src/privacy.js";
import { bootCare, careSeed, CO, contact, DAY, decide, MAILBOX, OWNER, tool, toolRaw, type Booted } from "./helpers/care.js";

const NOW = new Date().toISOString();
const ADA = "ada@acme.co.za";

function seedPerson() {
  const store = careSeed();
  store.contacts = [...store.contacts!, contact("ada2", "Ada L.", { emails: ["ada@acme.co.za", "ada.home@gmail.test"], phones: ["+27 82 123 4567"] })];
  // Ada exists twice (a duplicate the Data Steward has not merged yet): both are her.
  store.activities = [
    { id: "ac1", company_id: CO, record_type: "contact", record_id: "ada", kind: "email_received", body: "Hi, please quote", created_at: NOW, meta: null, source_key: "mail:1", issue_id: "iss-reply" },
    { id: "ac2", company_id: CO, record_type: "contact", record_id: "grace", kind: "note", body: "Grace asked for a call", created_at: NOW, meta: null, source_key: "g1", issue_id: null },
    { id: "ac3", company_id: "co-2", record_type: "contact", record_id: "ada", kind: "note", body: "Another company's row", created_at: NOW, meta: null, source_key: "o1", issue_id: null },
    { id: "ac4", company_id: CO, record_type: "contact", record_id: "ada", kind: "note", body: "Followed up", created_at: NOW, meta: null, source_key: "n1", issue_id: "iss-other" },
  ];
  store.facts = [
    { id: "f1", company_id: CO, record_type: "contact", record_id: "ada", field_key: "phones", value: ["+27 82 123 4567"], source: "agent", refused: false, created_at: NOW },
    { id: "f2", company_id: CO, record_type: "contact", record_id: "grace", field_key: "tags", value: ["x"], source: "agent", refused: false, created_at: NOW },
  ];
  store.enrollments = [
    { id: "en1", company_id: CO, sequence_id: "seq-mail", contact_id: "ada", status: "running", step_position: 1, next_due_at: NOW, open_issue_id: null, sending_key: null },
    { id: "en2", company_id: CO, sequence_id: "seq-mail", contact_id: "grace", status: "running", step_position: 1, next_due_at: NOW, open_issue_id: null, sending_key: null },
  ];
  store.consent_records = [
    { id: "cr1", company_id: CO, sender_key: "own", subject_key: `email:${ADA}`, email: ADA, contact_id: "ada", purpose: "marketing_email", basis: "consent", granted: true, source: "form", wording: "Yes", form_id: null, url: null, policy_version: null, ip_hash: "hash", recorded_at: NOW, expires_at: null, recorded_by: "partnersinbiz.crm" },
    { id: "cr2", company_id: CO, sender_key: "own", subject_key: "email:grace@globex.test", email: "grace@globex.test", contact_id: "grace", purpose: "marketing_email", basis: "consent", granted: true, source: "form", wording: "Yes", form_id: null, url: null, policy_version: null, ip_hash: null, recorded_at: NOW, expires_at: null, recorded_by: "partnersinbiz.crm" },
  ];
  store.client_leads = [
    { id: "cl1", key: "form:1", company_id: CO, client_kind: "company", client_ref: "globex", source: "form", platform: null, name: "Ada", handle: null, email: ADA, phone: null, message: "Hello Globex", url: null, item_id: null, confidence: null, captured_at: NOW, issue_id: "iss-clientlead", meta: {}, created_at: NOW },
    { id: "cl2", key: "dm:2", company_id: CO, client_kind: "company", client_ref: "globex", source: "social", platform: "instagram", name: "Ada", handle: "@ada", email: ADA, phone: null, message: "DM", url: null, item_id: null, confidence: null, captured_at: NOW, issue_id: null, meta: {}, created_at: NOW },
    { id: "cl3", key: "form:3", company_id: CO, client_kind: "company", client_ref: "globex", source: "form", platform: null, name: "Other", handle: null, email: "other@x.test", phone: null, message: "Hi", url: null, item_id: null, confidence: null, captured_at: NOW, issue_id: null, meta: {}, created_at: NOW },
  ];
  store.lead_captures = [{ id: "lc1", company_id: CO, source_id: "src", key: "form:1", outcome: "stored", contact_id: "ada", client_kind: "company", client_ref: "globex", attribution: {}, consent: true, ip_hash: "h", created_at: NOW }];
  store.handoffs = [
    { id: "h1", key: "consent:1", company_id: CO, event: "consent.recorded", payload: { subject: { email: ADA } }, created_at: NOW },
    { id: "h2", key: "suppress:g", company_id: CO, event: "contact.suppressed", payload: { email: "grace@globex.test" }, created_at: NOW },
  ];
  store.outbox = [
    { key: "crm:seq:en1:1", company_id: CO, event: "mail.send.requested", payload: { to: [{ email: "Ada@Acme.co.za" }], subject: "Hi" }, status: "pending", attempts: 1, last_error: null, result: null, created_at: NOW },
    { key: "crm:seq:en2:1", company_id: CO, event: "mail.send.requested", payload: { to: [{ email: "grace@globex.test" }], subject: "Hi" }, status: "pending", attempts: 1, last_error: null, result: null, created_at: NOW },
  ];
  store.held_leads = [{ id: "hl1", key: "k1", company_id: CO, event: "lead.captured", payload: { email: ADA, text: "hi" }, reason: "settings", attempts: 0, last_error: null, held_at: NOW, processed_at: null }];
  store.decisions = [
    { id: "d1", company_id: CO, purpose: "crm.lead-score", subject_kind: "contact", subject_id: "ada", question_key: "fit", answer_type: "score", confidence: 0.9, model: "jev", acted: false, created_at: NOW },
    { id: "d2", company_id: CO, purpose: "crm.lead-score", subject_kind: "contact", subject_id: "grace", question_key: "fit", answer_type: "score", confidence: 0.9, model: "jev", acted: false, created_at: NOW },
  ];
  return store;
}

async function bootPerson(): Promise<Booted> {
  const booted = await bootCare({ store: seedPerson() });
  const { harness } = booted;
  harness.seed({
    issues: [
      { id: "iss-reply", companyId: CO, title: "Reply from Ada: quote", description: "Ada (ada@acme.co.za) wants a quote. 082 123 4567", status: "todo", originKind: "plugin:partnersinbiz.crm", originId: "crm:reply:m1", createdAt: new Date() } as never,
      { id: "iss-clientlead", companyId: CO, title: "Lead for Globex: Ada", description: "Ada wrote: Hello Globex", status: "todo", originKind: "plugin:partnersinbiz.crm", originId: "crm:client-lead:form:1", createdAt: new Date() } as never,
      { id: "iss-other", companyId: CO, title: "Reply needed: Ada", description: "A mailbox issue", status: "todo", originKind: "plugin:partnersinbiz.mailbox", originId: "mailbox:reply:a:t", createdAt: new Date() } as never,
    ],
  });
  return booted;
}

const eraseApproved = async (booted: Booted, extra: Record<string, unknown> = {}) => {
  const made = await tool<Record<string, any>>(booted.harness, "request-erasure", { contactId: "contact:ada", evidence: "Ada emailed us on 3 Oct from the address on file asking us to delete her data.", identityChecked: true, ...extra });
  await decide(booted.harness, made.approvalIssueId, "done", "user");
  return made;
};

describe("recording consent and lawful basis", () => {
  it("keeps the basis, source, wording and who recorded it; the contact shows it", async () => {
    const booted = await bootCare();
    const result = await tool<Record<string, any>>(booted.harness, "record-consent", { contactId: "contact:ada", basis: "legitimate_interest", source: "manual", wording: "Existing client for SEO; this email is about similar services and offers an opt-out.", expiresInDays: 365 });
    expect(result).toMatchObject({ recorded: true, status: "recorded", basis: "legitimate_interest", purpose: "marketing_email", granted: true });
    expect(booted.store.consent_records![0]).toMatchObject({ email: ADA, sender_key: "own", basis: "legitimate_interest", source: "manual", granted: true, contact_id: "ada", recorded_by: "agent:agent-1" });
    expect(booted.store.consent_records![0]!.expires_at).toBeTruthy();
    expect(booted.store.consent_records![0]!.wording).toMatch(/similar services/);
    const shown = await tool<Record<string, any>>(booted.harness, "get-contact", { contactId: "contact:ada" });
    expect(shown.consent).toEqual([expect.objectContaining({ basis: "legitimate_interest", purpose: "marketing_email", granted: true, source: "manual" })]);
    // It is announced to the other modules too.
    expect(booted.emit.mock.calls.some((call) => call[0] === "consent.recorded")).toBe(true);
  });

  it("a basis needs its evidence, and the choices are checked", async () => {
    const booted = await bootCare();
    expect((await toolRaw(booted.harness, "record-consent", { contactId: "contact:ada", wording: "yes" })).error).toMatch(/at least a sentence/);
    expect((await toolRaw(booted.harness, "record-consent", { contactId: "contact:ada", wording: "Replied yes to our email on 2 Oct.", basis: "vibes" })).error).toMatch(/basis must be one of/);
    expect((await toolRaw(booted.harness, "record-consent", { contactId: "contact:ada", wording: "Replied yes to our email on 2 Oct.", source: "api" })).error).toMatch(/never api/);
    expect((await toolRaw(booted.harness, "record-consent", { contactId: "contact:ada", wording: "Replied yes to our email on 2 Oct.", purpose: "spam" })).error).toMatch(/purpose must be one of/);
    expect((await toolRaw(booted.harness, "record-consent", { contactId: "contact:ada", wording: "Replied yes to our email on 2 Oct.", expiresInDays: 0 })).error).toMatch(/expiresInDays/);
    expect((await toolRaw(booted.harness, "record-consent", { wording: "Replied yes to our email on 2 Oct." })).error).toMatch(/Say who/);
    expect((await toolRaw(booted.harness, "record-consent", { contactId: "contact:nobody", wording: "Replied yes to our email on 2 Oct." })).error).toMatch(/not found/);
    expect((await toolRaw(booted.harness, "record-consent", { email: ADA, client: "company:nobody", wording: "Replied yes to our email on 2 Oct." })).error).toMatch(/not found/);
    expect(booted.store.consent_records ?? []).toHaveLength(0);
  });

  it("a withdrawal needs no evidence, marks them unsubscribed, stops their sequences and tells the other modules", async () => {
    const booted = await bootPerson();
    const result = await tool<Record<string, any>>(booted.harness, "record-consent", { contactId: "contact:ada", granted: false });
    expect(result).toMatchObject({ recorded: true, granted: false });
    expect(result.optedOut).toMatch(/marked unsubscribed/);
    expect(booted.store.contacts!.find((row) => row.id === "ada")!.email_status).toBe("unsubscribed");
    expect(booted.store.enrollments!.find((row) => row.id === "en1")!.status).toBe("stopped");
    expect(booted.emit.mock.calls.some((call) => call[0] === "contact.suppressed" && (call[2] as any).email === ADA)).toBe(true);
  });

  it("an older record than the one on file is ignored", async () => {
    const booted = await bootCare();
    await booted.harness.emit(`${MAILBOX}.consent.recorded` as `plugin.${string}`, { key: "consent:email:ada@acme.co.za:marketing_email:2026-10-03T10:00:00.000Z", subject: { email: ADA }, purpose: "marketing_email", basis: "consent", granted: true, source: "reply", evidence: { wording: "Newer yes" }, recordedAt: "2026-10-03T10:00:00.000Z", recordedBy: "partnersinbiz.mailbox" }, { companyId: CO });
    await booted.harness.emit(`${MAILBOX}.consent.recorded` as `plugin.${string}`, { key: "consent:old", subject: { email: ADA }, purpose: "marketing_email", basis: "consent", granted: false, source: "reply", evidence: { wording: "Older no" }, recordedAt: "2026-10-01T10:00:00.000Z", recordedBy: "partnersinbiz.mailbox" }, { companyId: CO });
    expect(booted.store.consent_records).toHaveLength(1);
    expect(booted.store.consent_records![0]).toMatchObject({ granted: true, wording: "Newer yes", recorded_by: "partnersinbiz.mailbox", source: "reply" });
  });

  it("finds people in an email sequence with no basis on file; customers and covered people are not gaps", async () => {
    const store = careSeed();
    store.enrollments = [
      { id: "en1", company_id: CO, sequence_id: "seq-mail", contact_id: "grace", status: "running", step_position: 1, next_due_at: NOW, open_issue_id: null, sending_key: null },
      { id: "en2", company_id: CO, sequence_id: "seq-mail", contact_id: "solo", status: "running", step_position: 1, next_due_at: NOW, open_issue_id: null, sending_key: null },
      { id: "en3", company_id: CO, sequence_id: "seq-intro", contact_id: "ada", status: "running", step_position: 1, next_due_at: NOW, open_issue_id: null, sending_key: null },
    ];
    const booted = await bootCare({ store });
    // Grace is a lead in an email sequence with no basis; Solo is a customer; the Intro sequence is by issue, not email.
    expect(await consentGaps(booted.harness.ctx, CO)).toEqual([{ contactId: "grace", name: "Grace Hopper" }]);
    const check = (await privacyHealth(booted.harness.ctx, CO)).find((c) => c.key === "privacy:consent-gaps")!;
    expect(check).toMatchObject({ status: "warn" });
    expect(check.detail).toMatch(/Grace Hopper/);
    await tool(booted.harness, "record-consent", { contactId: "contact:grace", wording: "Signed up on the website form on 2 Oct and ticked the box." });
    expect(await consentGaps(booted.harness.ctx, CO)).toEqual([]);
    expect((await privacyHealth(booted.harness.ctx, CO)).find((c) => c.key === "privacy:consent-gaps")!.status).toBe("ok");
  });
});

describe("exporting one person's data", () => {
  it("collects what the CRM holds about her, and nothing of anyone else or another company", async () => {
    const booted = await bootPerson();
    const out = await tool<Record<string, any>>(booted.harness, "export-person-data", { email: ADA });
    expect(out.data.person.emails).toEqual(expect.arrayContaining([ADA, "ada.home@gmail.test"]));
    expect(out.data.person.contacts.map((c: any) => c.id).sort()).toEqual(["ada", "ada2"]);
    expect(out.counts).toMatchObject({ contacts: 2, activities: 2, notes_on_fields: 1, sequence_enrollments: 1, consent_records: 1, client_leads: 2, deals_linked: 1 });
    expect(out.data.consent).toEqual([expect.objectContaining({ purpose: "marketing_email", granted: true, wording: "Yes" })]);
    const text = JSON.stringify(out.data);
    expect(text).not.toMatch(/Grace|grace@globex|Another company's row|other@x\.test/);
    expect(out.data.websiteEnquiries.map((l: any) => l.message).sort()).toEqual(["DM", "Hello Globex"]);
    expect(out.notInTheCrm.map((m: any) => m.module)).toEqual(["mailbox", "campaigns", "social", "billing", "accounting"]);
    expect(out.next[0]).toMatch(/Check the requester is the person/);
    // By contact id the same person is found, with her address.
    expect((await tool<Record<string, any>>(booted.harness, "export-person-data", { contactId: "contact:ada" })).counts.contacts).toBe(2);
  });

  it("says plainly when there is nothing, and works for an address with no contact", async () => {
    const booted = await bootCare();
    expect((await toolRaw(booted.harness, "export-person-data", {})).error).toMatch(/Say who/);
    const none = await tool<Record<string, any>>(booted.harness, "export-person-data", { email: "nobody@nowhere.test" });
    expect(none.counts.contacts).toBe(0);
    expect(none.data.person.emails).toEqual(["nobody@nowhere.test"]);
  });
});

describe("asking for an erasure", () => {
  it("opens an approval for the owner showing exactly what will go; nothing is erased until a person decides", async () => {
    const booted = await bootPerson();
    const made = await tool<Record<string, any>>(booted.harness, "request-erasure", { contactId: "contact:ada", evidence: "Ada emailed us on 3 Oct from the address on file asking us to delete her data.", identityChecked: true });
    expect(made).toMatchObject({ status: "awaiting_approval" });
    expect(made.willRemove).toMatchObject({ contacts: 2, activities: 2, consent_records: 1 });
    expect(Date.parse(made.dueBy) - Date.now()).toBeGreaterThan(29 * DAY);
    const issue = (await booted.harness.ctx.issues.get(made.approvalIssueId, CO))!;
    expect(issue).toMatchObject({ assigneeUserId: OWNER, title: "Approve erasure: Ada Lovelace" });
    expect(issue.description).toContain("Erase **everything** we hold about **Ada Lovelace**");
    expect(issue.description).toContain("- activities: 2");
    expect(issue.description).toContain("**Evidence:** Ada emailed us on 3 Oct");
    expect(issue.description).toContain("This cannot be undone.");
    expect(issue.description).toMatch(/Our target is to answer within 30 days/);
    expect(booted.store.activities!.filter((row) => row.record_id === "ada")).toHaveLength(3);
    expect(booted.store.contacts!.some((row) => row.id === "ada")).toBe(true);
    expect(booted.emit.mock.calls.some((call) => call[0] === "contact.erase.requested")).toBe(false);
    // An agent closing it does not erase: it is reopened for the person.
    const reopened = await decide(booted.harness, made.approvalIssueId, "done", "agent");
    expect(reopened.status).toBe("todo");
    expect(booted.store.contacts!.some((row) => row.id === "ada")).toBe(true);
    expect(booted.store.care_approvals![0]!.status).toBe("open");
  });

  it("goes to a person even when the company has a Reviewer: erasure is not outward work", async () => {
    const booted = await bootCare({ store: seedPerson(), reviewer: true });
    const made = await tool<Record<string, any>>(booted.harness, "request-erasure", { contactId: "contact:ada", evidence: "Ada emailed us on 3 Oct from the address on file asking us to delete her data.", identityChecked: true });
    expect((await booted.harness.ctx.issues.get(made.approvalIssueId, CO))!.assigneeUserId).toBe(OWNER);
  });

  it("needs the evidence and that the person was identified; a refusal erases nothing", async () => {
    const booted = await bootPerson();
    expect((await toolRaw(booted.harness, "request-erasure", { contactId: "contact:ada", identityChecked: true, evidence: "short" })).error).toMatch(/how the request came/);
    expect((await toolRaw(booted.harness, "request-erasure", { contactId: "contact:ada", evidence: "Ada emailed us on 3 Oct from the address on file.", identityChecked: false })).error).toMatch(/Check that the request is from the person/);
    expect((await toolRaw(booted.harness, "request-erasure", { contactId: "contact:ada", evidence: "Ada emailed us on 3 Oct from the address on file.", identityChecked: true, reason: "boredom" })).error).toMatch(/reason must be one of/);
    expect(booted.store.care_approvals ?? []).toHaveLength(0);
    const made = await tool<Record<string, any>>(booted.harness, "request-erasure", { contactId: "contact:ada", evidence: "Ada emailed us on 3 Oct from the address on file asking us to delete her data.", identityChecked: true });
    await decide(booted.harness, made.approvalIssueId, "cancelled", "user");
    expect(booted.store.care_approvals![0]!.status).toBe("refused");
    expect(booted.store.contacts!.some((row) => row.id === "ada")).toBe(true);
    expect(booted.emit.mock.calls.some((call) => call[0] === "contact.erase.requested")).toBe(false);
  });
});

describe("carrying out an approved erasure", () => {
  it("erases her in the CRM and nobody else, keeps the deals unlinked and the cases without her, and blanks the issues the CRM opened", async () => {
    const booted = await bootPerson();
    const { harness, store } = booted;
    await tool(harness, "open-support-case", { client: "company:acme", title: "Ada's printer", summary: "Ada Lovelace says the printer is broken", contactId: "contact:ada" });
    await eraseApproved(booted);
    const mine = (rows: Array<Record<string, any>> | undefined, col: string, ...values: string[]) => (rows ?? []).filter((row) => row.company_id === CO && values.includes(String(row[col])));
    expect(mine(store.contacts, "id", "ada", "ada2")).toEqual([]);
    expect(mine(store.contacts, "id", "grace")).toHaveLength(1);
    expect(mine(store.activities, "record_id", "ada")).toEqual([]);
    expect(mine(store.activities, "record_id", "grace")).toHaveLength(1);
    expect(store.activities!.some((row) => row.company_id === "co-2")).toBe(true);
    expect(mine(store.facts, "record_id", "ada")).toEqual([]);
    expect(mine(store.facts, "record_id", "grace")).toHaveLength(1);
    expect(mine(store.enrollments, "contact_id", "ada")).toEqual([]);
    expect(mine(store.enrollments, "contact_id", "grace")).toHaveLength(1);
    expect(mine(store.consent_records, "email", ADA)).toEqual([]);
    expect(mine(store.consent_records, "email", "grace@globex.test")).toHaveLength(1);
    expect(mine(store.client_leads, "email", ADA)).toEqual([]);
    expect(mine(store.client_leads, "email", "other@x.test")).toHaveLength(1);
    expect(store.lead_captures ?? []).toHaveLength(0);
    expect(mine(store.handoffs, "id", "h1")).toEqual([]);
    expect(mine(store.handoffs, "id", "h2")).toHaveLength(1);
    expect(store.outbox!.map((row) => row.key)).toEqual(["crm:seq:en2:1"]);
    expect(mine(store.held_leads, "id", "hl1")).toEqual([]);
    expect(mine(store.decisions, "id", "d1")).toEqual([]);
    expect(mine(store.decisions, "id", "d2")).toHaveLength(1);
    // The deal stays (a business record) without her; the case stays without her name.
    expect(store.deals!.find((row) => row.id === "d-acme")).toMatchObject({ contact_id: null });
    expect(store.support_cases![0]).toMatchObject({ contact_id: null, title: "Support case (person erased)", summary: "" });
    expect(store.contact_companies!.some((row) => row.contact_id === "ada")).toBe(false);
    // Only the issues the CRM opened are blanked; another module's issue is its own to redact.
    expect((await harness.ctx.issues.get("iss-reply", CO))).toMatchObject({ title: "Erased on request", description: expect.stringContaining("erased from this issue") });
    expect((await harness.ctx.issues.get("iss-clientlead", CO))!.title).toBe("Erased on request");
    expect((await harness.ctx.issues.get("iss-other", CO))!.title).toBe("Reply needed: Ada");
    // The other modules are told the contact is gone.
    expect(booted.emit.mock.calls.some((call) => call[0] === "contact.upserted" || call[0] === "contact.deleted")).toBe(true);
  });

  it("a sole trader is erased as a client too: reports, health, signals, profile, websites, monitoring and enquiries go, and another client's rows stay", async () => {
    const solo = { company_id: CO, client_kind: "contact", client_ref: "solo" };
    const acme = { company_id: CO, client_kind: "company", client_ref: "acme" };
    const store = careSeed({
      client_reports: [{ id: "r-solo", ...solo, period: "2026-09" }, { id: "r-acme", ...acme, period: "2026-09" }],
      client_health: [{ id: "h-solo", ...solo }, { id: "h-acme", ...acme }],
      client_signals: [{ id: "s-solo", ...solo }, { id: "s-acme", ...acme }],
      client_sensitivity: [{ id: "x-solo", ...solo }, { id: "x-acme", ...acme }],
      client_profiles: [{ id: "p-solo", ...solo, services: [] }, { id: "p-acme", ...acme, services: [] }],
      client_projects: [{ id: "cp-solo", ...solo, project_id: "proj-solo" }, { id: "cp-acme", ...acme, project_id: "proj-acme" }],
      client_sites: [{ id: "site-solo", ...solo, url: "https://sipho.test" }, { id: "site-acme", ...acme, url: "https://acme.co.za" }],
      site_monitor: [{ site_id: "site-solo", company_id: CO }, { site_id: "site-acme", company_id: CO }],
      site_uptime_days: [{ id: "site-solo:2026-09-01", site_id: "site-solo", company_id: CO }, { id: "site-acme:2026-09-01", site_id: "site-acme", company_id: CO }],
      site_changes: [{ id: "c-solo", site_id: "site-solo", company_id: CO }, { id: "c-acme", site_id: "site-acme", company_id: CO }],
      site_signoff: [{ site_id: "site-solo", company_id: CO }, { site_id: "site-acme", company_id: CO }],
      client_leads: [{ id: "cl-solo", key: "form:solo", company_id: CO, client_kind: "contact", client_ref: "solo", email: "visitor@x.test", source: "form", message: "Hi" }],
      service_onboarding: [{ id: "so-solo", ...solo }, { id: "so-acme", ...acme }],
      care_approvals: [{ id: "ap-solo", ...solo, kind: "client_report", subject_id: "r-solo", seq: 1, status: "open", payload: {} }],
    });
    const booted = await bootCare({ store });
    // Opened first, not decided: the approval a person reads already says the client records will go.
    const request = await tool<Record<string, any>>(booted.harness, "request-erasure", { contactId: "contact:solo", evidence: "Sipho wrote from the address on file and asked us to delete everything.", identityChecked: true });
    expect(request.willRemove.records_kept_for_them_as_a_client).toBe(10);
    expect((await booted.harness.ctx.issues.get(request.approvalIssueId, CO))!.description).toContain("records kept for them as a client: 10");
    await decide(booted.harness, request.approvalIssueId, "done", "user");
    const left = (name: string) => (store[name] ?? []).map((row) => String(row.id ?? row.site_id ?? row.key));
    expect(store.contacts!.some((row) => row.id === "solo")).toBe(false);
    expect(left("client_reports")).toEqual(["r-acme"]);
    expect(left("client_health")).toEqual(["h-acme"]);
    expect(left("client_signals")).toEqual(["s-acme"]);
    expect(left("client_sensitivity")).toEqual(["x-acme"]);
    expect(left("client_profiles")).toEqual(["p-acme"]);
    expect(left("client_projects")).toEqual(["cp-acme"]);
    expect(left("client_sites")).toEqual(["site-acme"]);
    expect(left("site_monitor")).toEqual(["site-acme"]);
    expect(left("site_uptime_days")).toEqual(["site-acme:2026-09-01"]);
    expect(left("site_changes")).toEqual(["c-acme"]);
    expect(left("site_signoff")).toEqual(["site-acme"]);
    expect(left("client_leads")).toEqual([]);
    expect(left("service_onboarding")).toEqual(["so-acme"]);
    expect((store.care_approvals ?? []).some((row) => row.id === "ap-solo")).toBe(false);
    // Reported to the person who decides: a report, health score, signal, sensitivity flag, monitor row, uptime day, queued approval, site and project link.
    const done = store.care_approvals!.find((row) => row.kind === "erasure")!.result as Record<string, any>;
    expect(done.counts.client_records).toBe(9);
  });

  it("erasing a person who works for a client touches none of the client's own records", async () => {
    const acme = { company_id: CO, client_kind: "company", client_ref: "acme" };
    const store = seedPerson();
    store.client_reports = [{ id: "r-acme", ...acme, period: "2026-09" }];
    store.client_sites = [{ id: "site-acme", ...acme, url: "https://acme.co.za" }];
    store.client_profiles = [{ id: "p-acme", ...acme, services: [] }];
    const booted = await bootCare({ store });
    await eraseApproved(booted);
    expect(store.client_reports).toHaveLength(1);
    expect(store.client_sites).toHaveLength(1);
    expect(store.client_profiles).toHaveLength(1);
  });

  it("announces the request to the other modules with the person who approved it, remembers what each owes, and says what was kept", async () => {
    const booted = await bootPerson();
    const { harness, store } = booted;
    const made = await eraseApproved(booted);
    const [request] = booted.emit.mock.calls.filter((call) => call[0] === "contact.erase.requested").map((call) => call[2] as Record<string, any>);
    expect(request).toMatchObject({ approvedByUserId: OWNER, scope: "all", reason: "data_subject_request", source: "partnersinbiz.crm", approvalIssueId: made.approvalIssueId, subject: { email: ADA, contactId: "ada" } });
    expect(Date.parse(request.dueBy) - Date.now()).toBeGreaterThan(29 * DAY);
    const approval = store.care_approvals![0]!;
    expect(approval).toMatchObject({ status: "erased", decided_by: `user:${OWNER}` });
    expect(approval.result.announcedTo).toEqual([PIB_PLUGINS.mailbox, PIB_PLUGINS.campaigns, PIB_PLUGINS.social, PIB_PLUGINS.billing, PIB_PLUGINS.accounting]);
    expect(approval.result.counts).toMatchObject({ contacts: 2, activities: 2, consent_records: 1 });
    expect(approval.result.retained.map((r: any) => r.what)).toEqual(expect.arrayContaining([expect.stringMatching(/1 deal/), "comments on issues the CRM opened about them"]));
    const ledger = (await harness.ctx.state.get({ scopeKind: "company", scopeId: CO, namespace: "pib-privacy", stateKey: `ledger:${request.requestId}` })) as Record<string, any>;
    expect(ledger.pending).toEqual(approval.result.announcedTo);
    // The approval issue says what happened, with no address in it, and the approval no longer holds her.
    const issue = (await harness.ctx.issues.get(made.approvalIssueId, CO))!;
    expect(issue.title).toBe("Erasure request (completed)");
    expect(issue.description).not.toMatch(/Ada|ada@/);
    expect(JSON.stringify(approval.payload)).not.toMatch(/Ada|ada@acme|Ada emailed/);
    expect(approval.payload.request.subject).toEqual({});
  });

  it("only asks the modules that are switched on", async () => {
    const booted = await bootPerson();
    const modules = { [moduleOfPlugin(PIB_PLUGINS.accounting)!]: false, [moduleOfPlugin(PIB_PLUGINS.social)!]: false };
    await booted.harness.ctx.state.set({ scopeKind: "company", scopeId: CO, namespace: "pib-setup", stateKey: "modules" }, { companyId: CO, modules, updatedAt: NOW });
    await eraseApproved(booted);
    expect(booted.store.care_approvals![0]!.result.announcedTo).toEqual([PIB_PLUGINS.mailbox, PIB_PLUGINS.campaigns, PIB_PLUGINS.billing]);
  });

  it("each module's answer is written on the approval, and when everyone has answered the ledger drops her identifiers", async () => {
    const booted = await bootPerson();
    const { harness } = booted;
    const made = await eraseApproved(booted);
    const [request] = booted.emit.mock.calls.filter((call) => call[0] === "contact.erase.requested").map((call) => call[2] as Record<string, any>);
    const comments: string[] = [];
    const original = harness.ctx.issues.createComment.bind(harness.ctx.issues);
    harness.ctx.issues.createComment = (async (issueId: string, body: string, companyId: string, ...rest: unknown[]) => {
      if (issueId === made.approvalIssueId) comments.push(body);
      return (original as (...args: unknown[]) => Promise<unknown>)(issueId, body, companyId, ...rest);
    }) as never;
    const answer = (plugin: string, status: string, counts: Record<string, number> = {}, retained: Array<{ what: string; why: string }> = []) =>
      harness.emit(`plugin.${plugin}.contact.erase.completed` as `plugin.${string}`, { key: `erase:${request.requestId}:${plugin}`, requestId: request.requestId, plugin, status, counts, retained, completedAt: NOW }, { companyId: CO });
    await answer(PIB_PLUGINS.mailbox, "erased", { messages: 12 });
    await answer(PIB_PLUGINS.billing, "retained", {}, [{ what: "2 invoices", why: "tax law requires seven years" }]);
    expect(comments[0]).toBe("mailbox answered: erased (12 messages).");
    expect(comments[1]).toBe("billing answered: retained. Kept by law: 2 invoices (tax law requires seven years).");
    await answer(PIB_PLUGINS.campaigns, "nothing_found");
    await answer(PIB_PLUGINS.social, "nothing_found");
    await answer(PIB_PLUGINS.accounting, "retained", {}, [{ what: "ledger entries", why: "tax law" }]);
    expect(comments.some((text) => /Every module has answered\./.test(text))).toBe(true);
    const ledger = (await harness.ctx.state.get({ scopeKind: "company", scopeId: CO, namespace: "pib-privacy", stateKey: `ledger:${request.requestId}` })) as Record<string, any>;
    expect(ledger.pending).toEqual([]);
    expect(ledger.request.subject).toEqual({});
    expect(ledger.subjectHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an erasure a module never answers is asked again every hour and shows up in the Cockpit after a week", async () => {
    const booted = await bootPerson();
    const { harness } = booted;
    await eraseApproved(booted);
    expect(booted.emit.mock.calls.filter((call) => call[0] === "contact.erase.requested")).toHaveLength(1);
    expect(await reannounceAll(harness.ctx, CO)).toBe(1);
    expect(booted.emit.mock.calls.filter((call) => call[0] === "contact.erase.requested")).toHaveLength(2);
    expect((await privacyHealth(harness.ctx, CO)).some((c) => c.key === "privacy:erasure-stale")).toBe(false);
    const [request] = booted.emit.mock.calls.filter((call) => call[0] === "contact.erase.requested").map((call) => call[2] as Record<string, any>);
    const key = { scopeKind: "company" as const, scopeId: CO, namespace: "pib-privacy", stateKey: `ledger:${request.requestId}` };
    const ledger = (await harness.ctx.state.get(key)) as Record<string, any>;
    await harness.ctx.state.set(key, { ...ledger, announcedAt: new Date(Date.now() - 8 * DAY).toISOString() });
    const stale = (await privacyHealth(harness.ctx, CO)).find((c) => c.key === "privacy:erasure-stale")!;
    expect(stale.status).toBe("warn");
    expect(stale.detail).not.toMatch(/Ada|ada@/);
    // The hourly care job does the re-sending.
    expect((await harness.runJob("client-care").then(() => booted.emit.mock.calls.filter((call) => call[0] === "contact.erase.requested").length)) >= 2).toBe(true);
  });

  it("is safe to run again: the second run finds nothing", async () => {
    const booted = await bootPerson();
    const person = await findPerson(booted.harness.ctx, CO, { contactId: "ada" });
    const first = await eraseSubjectInCrm(booted.harness.ctx, CO, person, "all");
    expect(first.counts.contacts).toBe(2);
    const again = await eraseSubjectInCrm(booted.harness.ctx, CO, { contacts: [], emails: person.emails, phones: person.phones }, "all");
    expect(again.counts).toEqual({});
  });

  it("marketing only keeps the record and stops all marketing", async () => {
    const booted = await bootPerson();
    const { harness, store } = booted;
    await eraseApproved(booted, { scope: "marketing_only" });
    expect(store.contacts!.find((row) => row.id === "ada")).toMatchObject({ email_status: "unsubscribed" });
    expect(store.enrollments!.some((row) => row.contact_id === "ada")).toBe(false);
    expect(store.consent_records!.some((row) => row.email === ADA)).toBe(false);
    expect(store.decisions!.some((row) => row.subject_id === "ada")).toBe(false);
    expect(store.activities!.filter((row) => row.record_id === "ada")).toHaveLength(3);
    expect(booted.emit.mock.calls.some((call) => call[0] === "contact.suppressed" && (call[2] as any).email === ADA)).toBe(true);
    expect((await harness.ctx.issues.get("iss-reply", CO))!.title).toBe("Reply from Ada: quote");
    const [request] = booted.emit.mock.calls.filter((call) => call[0] === "contact.erase.requested").map((call) => call[2] as Record<string, any>);
    expect(request.scope).toBe("marketing_only");
  });

  it("when the CRM part fails nothing is announced, and the approval says so", async () => {
    const booted = await bootPerson();
    const made = await tool<Record<string, any>>(booted.harness, "request-erasure", { contactId: "contact:ada", evidence: "Ada emailed us on 3 Oct from the address on file asking us to delete her data.", identityChecked: true });
    const execute = booted.harness.ctx.db.execute.bind(booted.harness.ctx.db);
    (booted.harness.ctx.db as any).execute = async (sql: string, params?: unknown[]) => {
      if (/DELETE FROM \S+\.activities/.test(sql)) throw new Error("disk full");
      return execute(sql, params);
    };
    await decide(booted.harness, made.approvalIssueId, "done", "user");
    expect(booted.store.care_approvals![0]).toMatchObject({ status: "failed" });
    expect(booted.store.care_approvals![0]!.error).toBe("disk full");
    expect(booted.emit.mock.calls.some((call) => call[0] === "contact.erase.requested")).toBe(false);
  });

  it("collects what is held without touching it", async () => {
    const booted = await bootPerson();
    const person = await findPerson(booted.harness.ctx, CO, { email: "Ada@Acme.co.za" });
    const data = await collectPersonData(booted.harness.ctx, CO, person);
    expect(data.outboxKeys).toEqual(["crm:seq:en1:1"]);
    expect(data.handoffIds).toEqual(["h1"]);
    expect(data.heldLeadIds).toEqual(["hl1"]);
    expect(data.issueIds.sort()).toEqual(["iss-clientlead", "iss-other", "iss-reply"]);
    expect(booted.store.contacts!.some((row) => row.id === "ada")).toBe(true);
  });
});
