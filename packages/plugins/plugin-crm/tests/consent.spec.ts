import { describe, expect, it } from "vitest";
import { asConsentRecorded, consentKey } from "@partnersinbiz/pib-plugin-kit";
import { consentSummary, recordConsent } from "../src/consent.js";
import { eraseFormData } from "../src/lead-store.js";
import { BOARD, CO, boot, tool } from "./helpers/crm.js";

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe("consent the CRM records", () => {
  it("stores one record per sender, person and purpose and announces it in the kit's contract shape", async () => {
    const { harness, store, emit } = await boot();
    const at = "2026-10-03T08:00:00.000Z";
    const outcome = await recordConsent(harness.ctx, { companyId: CO, client: null, email: "Jane@Smith.test", granted: true, source: "form", wording: "Yes email me", formId: "src1", url: "https://pib.example.co.za/contact", ipHash: "abc123", recordedAt: at });
    expect(outcome).toEqual({ status: "recorded", senderKey: "own", key: consentKey({ email: "jane@smith.test" }, "marketing_email", at) });
    expect(store.consent_records).toHaveLength(1);
    expect(store.consent_records[0]).toMatchObject({ sender_key: "own", subject_key: "email:jane@smith.test", email: "jane@smith.test", purpose: "marketing_email", basis: "consent", granted: true, source: "form", wording: "Yes email me", form_id: "src1", ip_hash: "abc123", recorded_by: "partnersinbiz.crm" });
    // What goes out parses with the kit's own reader, and carries no hash.
    const payload = emit.mock.calls.find((call) => call[0] === "consent.recorded")![2];
    expect(asConsentRecorded(payload)).toMatchObject({ purpose: "marketing_email", granted: true, source: "form", evidence: { wording: "Yes email me", formId: "src1" }, recordedAt: at });
    expect(JSON.stringify(payload)).not.toContain("abc123");
    expect(store.handoffs.filter((row) => row.event === "consent.recorded")).toHaveLength(1);
  });

  it("keeps our list and each client's list apart, and each purpose apart", async () => {
    const { harness, store } = await boot();
    const base = { companyId: CO, email: "jane@smith.test", granted: true, source: "form" as const };
    await recordConsent(harness.ctx, { ...base, client: null });
    await recordConsent(harness.ctx, { ...base, client: { kind: "company", id: "acme" } });
    await recordConsent(harness.ctx, { ...base, client: { kind: "contact", id: "solo" } });
    await recordConsent(harness.ctx, { ...base, client: null, purpose: "newsletter" });
    expect(store.consent_records.map((row) => [row.sender_key, row.purpose]).sort()).toEqual([["company:acme", "marketing_email"], ["contact:solo", "marketing_email"], ["own", "marketing_email"], ["own", "newsletter"]]);
  });

  it("the newest record wins: an older one is ignored, a newer one replaces it, and a withdrawal is a newer record", async () => {
    const { harness, store } = await boot();
    const base = { companyId: CO, client: null, email: "jane@smith.test", source: "form" as const };
    await recordConsent(harness.ctx, { ...base, granted: true, wording: "first", recordedAt: later(10) });
    expect(await recordConsent(harness.ctx, { ...base, granted: false, wording: "older", recordedAt: later(0) })).toMatchObject({ status: "stale" });
    expect(store.consent_records).toHaveLength(1);
    expect(store.consent_records[0]).toMatchObject({ granted: true, wording: "first" });
    expect(await recordConsent(harness.ctx, { ...base, granted: false, source: "unsubscribe_link", wording: "stop", recordedAt: later(20) })).toMatchObject({ status: "recorded" });
    expect(store.consent_records).toHaveLength(1);
    expect(store.consent_records[0]).toMatchObject({ granted: false, source: "unsubscribe_link", wording: "stop" });
    // The same moment again is a harmless re-send.
    const at = later(20);
    await recordConsent(harness.ctx, { ...base, granted: false, recordedAt: at });
    expect(store.consent_records).toHaveLength(1);
  });

  it("records nothing for a lead that has no email", async () => {
    const { harness, store } = await boot();
    expect(await recordConsent(harness.ctx, { companyId: CO, client: null, email: "  ", granted: true, source: "form" })).toBeNull();
    expect(store.consent_records).toHaveLength(0);
  });

  it("says what a person agreed to on their contact, with no address or hash", async () => {
    const { harness } = await boot();
    await recordConsent(harness.ctx, { companyId: CO, client: null, email: "ada@acme.co.za", granted: true, source: "form", wording: "Yes email me", ipHash: "deadbeef", recordedAt: "2026-10-03T08:00:00.000Z" });
    await recordConsent(harness.ctx, { companyId: CO, client: { kind: "company", id: "acme" }, email: "ada@acme.co.za", granted: true, source: "form", wording: "Yes Acme may email me", recordedAt: "2026-10-03T09:00:00.000Z" });
    const lines = await consentSummary(harness.ctx, CO, "ada@acme.co.za");
    expect(lines).toEqual([
      { sender: "company:acme", purpose: "marketing_email", basis: "consent", granted: true, source: "form", recordedAt: "2026-10-03T09:00:00.000Z", expiresAt: null, wording: "Yes Acme may email me" },
      { sender: "own", purpose: "marketing_email", basis: "consent", granted: true, source: "form", recordedAt: "2026-10-03T08:00:00.000Z", expiresAt: null, wording: "Yes email me" },
    ]);
    const contact = await tool<Record<string, any>>(harness, "get-contact", { contactId: "contact:ada" });
    expect(contact.consent).toHaveLength(2);
    expect(JSON.stringify(contact.consent)).not.toMatch(/deadbeef|ada@acme\.co\.za/);
    // A contact nobody recorded consent for shows no consent block.
    expect((await tool<Record<string, any>>(harness, "get-contact", { contactId: "contact:grace" })).consent).toBeUndefined();
    expect(await consentSummary(harness.ctx, CO, "nobody@x.test")).toEqual([]);
    expect(await consentSummary(harness.ctx, CO, "")).toEqual([]);
  });

  it("is only about the company asked for", async () => {
    const { harness, store } = await boot();
    await recordConsent(harness.ctx, { companyId: CO, client: null, email: "ada@acme.co.za", granted: true, source: "form" });
    store.consent_records.push({ ...store.consent_records[0]!, id: "other", company_id: "co-2" });
    expect(await consentSummary(harness.ctx, CO, "ada@acme.co.za")).toHaveLength(1);
    expect(await consentSummary(harness.ctx, "co-2", "ada@acme.co.za")).toHaveLength(1);
    void BOARD;
  });
});

describe("erasing what the lead forms hold about a person", () => {
  it("removes their consent records, the form leads of clients that carry their address, and the captures of those leads and of their contact, and nobody else's", async () => {
    const { harness, store } = await boot();
    await recordConsent(harness.ctx, { companyId: CO, client: null, email: "Jane@Smith.test", granted: true, source: "form" });
    await recordConsent(harness.ctx, { companyId: CO, client: { kind: "company", id: "acme" }, email: "jane@smith.test", granted: true, source: "form" });
    await recordConsent(harness.ctx, { companyId: CO, client: null, email: "other@smith.test", granted: true, source: "form" });
    store.client_leads = [
      { id: "l1", key: "form:a:1:20261003", company_id: CO, client_kind: "company", client_ref: "acme", source: "form", email: "jane@smith.test", message: "hi", captured_at: "2026-10-03T08:00:00Z" },
      { id: "l2", key: "form:a:2:20261003", company_id: CO, client_kind: "company", client_ref: "acme", source: "form", email: "other@smith.test", message: "hi", captured_at: "2026-10-03T08:00:00Z" },
      { id: "l3", key: "social:inbox:9", company_id: CO, client_kind: "company", client_ref: "acme", source: "social", email: "jane@smith.test", message: "hi", captured_at: "2026-10-03T08:00:00Z" },
    ];
    store.lead_captures = [
      { id: "c1", company_id: CO, source_id: "s", key: "form:a:1:20261003", outcome: "stored", contact_id: null, ip_hash: "h1" },
      { id: "c2", company_id: CO, source_id: "s", key: "form:a:2:20261003", outcome: "stored", contact_id: null, ip_hash: "h2" },
      { id: "c3", company_id: CO, source_id: "s", key: "form:own:3:20261003", outcome: "stored", contact_id: "ada", ip_hash: "h3" },
      { id: "c4", company_id: CO, source_id: "s", key: "form:own:4:20261003", outcome: "stored", contact_id: "grace", ip_hash: "h4" },
    ];
    expect(await eraseFormData(harness.ctx, CO, " JANE@smith.test ", ["ada"])).toEqual({ consentRecords: 2, clientLeads: 1, captures: 2 });
    expect(store.consent_records.map((row) => row.email)).toEqual(["other@smith.test"]);
    // A lead that came in on a social channel is not a form's data: it is left for the Social plugin's own erasure.
    expect(store.client_leads.map((row) => row.id)).toEqual(["l2", "l3"]);
    expect(store.lead_captures.map((row) => row.id)).toEqual(["c2", "c4"]);
    expect(await eraseFormData(harness.ctx, CO, "")).toEqual({ consentRecords: 0, clientLeads: 0, captures: 0 });
    expect(await eraseFormData(harness.ctx, "co-2", "other@smith.test", ["grace"])).toEqual({ consentRecords: 0, clientLeads: 0, captures: 0 });
    expect(store.lead_captures).toHaveLength(2);
  });
});
