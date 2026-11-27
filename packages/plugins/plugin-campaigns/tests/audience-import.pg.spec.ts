/**
 * Stage 4c (plan PAR-9192 rev 2, 5.5 and 7): import preview, add one and tick own contacts. The preview counts match a
 * fixture; a client's people go on the client's list and never into our CRM contacts; a person without an SMS/WhatsApp
 * opt-in is imported and marked as unable to receive them; our own campaign hands its people to the CRM's import.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyImport, classify, listMembersWithReach, person, previewImport, readCsvPeople, tickContacts } from "../src/audience-import.js";
import { addChannelSuppression, addSuppression, insertCampaign, upsertConsent } from "../src/db.js";
import type { CampaignDraft } from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const CO = "c";
const OPTED = "+27821110001";
const NO_OPT_IN = "+27821110002";
const STOPPED = "+27821110003";
// 8 rows: 3 new (one email-only, one opted-in mobile, one mobile without opt-in), 2 duplicates (one already there, one
// twice in the file), 2 suppressed (email unsubscribed from this sender; mobile-only with STOP on both channels), 1 invalid.
const FIXTURE = [
  "Full Name,E-mail,Mobile",
  "Ada,ada@expo.test,",
  "Bob,bob@expo.test,082 111 0001",
  "Cleo,,082 111 0002",
  "Dan,dan@have.test,",
  "Ada again,ADA@expo.test,",
  "Eve,eve@gone.test,",
  "Fay,,082 111 0003",
  "Gus,not-an-email,",
].join("\r\n");

const draft = (over: Partial<CampaignDraft>): CampaignDraft => ({
  id: "camp", companyId: CO, name: "Expo", description: "", status: "draft", fromName: "Acme", fromLocal: "hello", replyTo: null, audienceTags: [],
  startAt: null, endAt: null, approvalIssueId: null, winnerVariant: null, clientKind: "company", clientRef: "acme", clientName: "Acme",
  audienceMode: "client_list", delivery: "email", ownerUserId: "user-peet", ownerAgentId: null, ...over,
});
const PROVENANCE = { source: "expo sign-up sheet", lawfulBasis: "consent" as const, addedBy: "user:peet" };

describe("classify (pure)", () => {
  it("a row is new, duplicate, suppressed or invalid; noOptIn counts mobiles going in without an opt-in", () => {
    const { people } = readCsvPeople(FIXTURE);
    const empty = new Set<string>();
    const { counts, rows } = classify(people, {
      existing: new Set(["dan@have.test"]), suppressedEmails: new Set(["eve@gone.test"]),
      blocked: { sms: new Set([STOPPED]), whatsapp: new Set([STOPPED]) }, optedIn: { sms: new Set([OPTED]), whatsapp: empty }, needsName: false,
    });
    expect(counts).toEqual({ total: 8, new: 3, duplicate: 2, suppressed: 2, invalid: 1, noOptIn: 1 });
    expect(rows.map((r) => r.status)).toEqual(["new", "new", "new", "duplicate", "duplicate", "suppressed", "suppressed", "invalid"]);
    expect(rows[1]).toMatchObject({ phone: OPTED, reach: { email: true, sms: true, whatsapp: false } });
    expect(rows[2]).toMatchObject({ phone: NO_OPT_IN, reach: { email: false, sms: false, whatsapp: false } });
  });

  it("a mapped column must exist; an email or mobile column is required", () => {
    expect(() => readCsvPeople("name,email\nAda,a@b.test", { email: "Work email" })).toThrow(/no column "Work email"/);
    expect(() => readCsvPeople("name,town\nAda,Paarl")).toThrow(/email or a mobile/);
    expect(readCsvPeople('Name,Work email\n"Lovelace, Ada",A@B.test', { email: "work email" }).people[0]).toMatchObject({ name: "Lovelace, Ada", email: "a@b.test" });
  });
});

describe.skipIf(!available)("adding people (postgres)", () => {
  let h: PgHarness;
  beforeAll(async () => {
    h = await startPg();
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });
  beforeEach(async () => {
    await h.reset();
    const acme = "company:acme";
    await addSuppression(h.ctx, { companyId: CO, email: "eve@gone.test", reason: "unsubscribe", scope: "marketing", source: "test", contactId: null, campaignId: null, senderKey: acme });
    for (const channel of ["sms", "whatsapp"] as const) {
      await addChannelSuppression(h.ctx, { companyId: CO, channel, address: STOPPED, senderKey: acme, reason: "stop_keyword", scope: "marketing", source: "test" });
    }
    await upsertConsent(h.ctx, { companyId: CO, channel: "sms", address: OPTED, senderKey: acme, granted: true, basis: "consent", source: "form", recordedAt: "2026-11-20T08:00:00Z" });
  });

  it("client list: preview counts match the fixture, the import writes the list with source and lawful basis, never CRM contacts", async () => {
    const campaign = draft({});
    await insertCampaign(h.ctx, campaign);
    const { people } = readCsvPeople(FIXTURE);
    await applyImport(h.ctx, CO, campaign, [person(1, "Dan", "dan@have.test", null)], PROVENANCE);
    const preview = await previewImport(h.ctx, CO, campaign, people);
    expect(preview.counts).toEqual({ total: 8, new: 3, duplicate: 2, suppressed: 2, invalid: 1, noOptIn: 1 });
    expect(preview.target).toEqual({ kind: "list", client: { kind: "company", id: "acme" }, listName: "Expo" });
    expect((await h.client.query(`SELECT id FROM ${NAMESPACE}.audience_members`)).rows).toHaveLength(1);

    const done = await applyImport(h.ctx, CO, campaign, people, PROVENANCE);
    expect(done).toMatchObject({ added: 3, cannotText: 2, crm: null });
    const rows = (await h.client.query(`SELECT email, phone, source, lawful_basis, added_by FROM ${NAMESPACE}.audience_members ORDER BY added_at, email`)).rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatchObject({ source: "expo sign-up sheet", lawful_basis: "consent", added_by: "user:peet" });
    expect(rows.map((r) => r.email ?? r.phone)).not.toContain("eve@gone.test");
    expect((await h.client.query(`SELECT id FROM ${NAMESPACE}.crm_contacts`)).rows).toHaveLength(0);
    expect((await h.client.query(`SELECT id FROM ${NAMESPACE}.campaign_enrollments`)).rows).toHaveLength(0);

    const { members } = await listMembersWithReach(h.ctx, CO, campaign);
    expect(members.find((m) => m.phone === NO_OPT_IN)).toMatchObject({ name: "Cleo", reach: { email: false, sms: false, whatsapp: false } });
    expect(members.find((m) => m.phone === OPTED)).toMatchObject({ reach: { sms: true, whatsapp: false } });
  });

  it("a client campaign whose audience is not its list, and a completed one, are refused", async () => {
    await expect(previewImport(h.ctx, CO, draft({ audienceMode: "client_contacts" }), [])).rejects.toThrow(/client's own list/);
    await expect(previewImport(h.ctx, CO, draft({ status: "completed" }), [])).rejects.toThrow(/completed/);
  });

  it("own campaign: duplicates are CRM contacts that get the tag; the result is the CRM's import with the tag, source and basis", async () => {
    await h.client.query(`INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, emails, phones, updated_at) VALUES ('dan', $1, 'Dan', ARRAY['dan@have.test'], ARRAY['082 111 0002'], now())`, [CO]);
    const own = draft({ clientKind: null, clientRef: null, clientName: null, audienceMode: "tags", audienceTags: ["expo-2026"] });
    await expect(previewImport(h.ctx, CO, { ...own, audienceTags: [] }, [])).rejects.toThrow(/audience tag/);
    const done = await applyImport(h.ctx, CO, own, [person(1, "Ada", "ada@expo.test", null), person(2, "Cleo", null, "0821110002"), person(3, null, "nameless@expo.test", null)], { ...PROVENANCE, lawfulBasis: "legitimate_interest" });
    expect(done.counts).toMatchObject({ new: 1, duplicate: 1, invalid: 1 });
    expect(done.crm).toEqual({
      plugin: "partnersinbiz.crm", action: "crm.import-contacts",
      params: { csv: "name,emails,phones,tags,source,lawful_basis\nAda,ada@expo.test,,expo-2026,expo sign-up sheet,legitimate_interest\nCleo,,+27821110002,expo-2026,expo sign-up sheet,legitimate_interest" },
    });
    expect((await h.client.query(`SELECT id FROM ${NAMESPACE}.audience_members`)).rows).toHaveLength(0);

    expect(await tickContacts(h.ctx, CO, own, ["dan", "dan"])).toEqual({ tag: "expo-2026", count: 1, crm: { plugin: "partnersinbiz.crm", action: "crm.bulk-tag-contacts", params: { contactIds: ["dan"], tags: ["expo-2026"], action: "add" } } });
    await expect(tickContacts(h.ctx, CO, own, ["dan", "stranger"])).rejects.toThrow(/stranger/);
    await expect(tickContacts(h.ctx, "other", own, ["dan"])).rejects.toThrow(/dan/);
    await expect(tickContacts(h.ctx, CO, draft({}), ["dan"])).rejects.toThrow(/own campaigns/);
  });
});
