/**
 * 020: `audience_members`, the people on a client's list (Stage 4c). The table is new, so the 0.17.2 statements on
 * the tables it sits beside (campaign insert and save, enrollment insert: unchanged in this release, so the db.ts
 * functions are those statements) must still run against the migrated schema (rule PAR-4100). A list row never
 * becomes a CRM contact, and every read is scoped to one company and one client.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addAudienceMember, audienceMembersOf, getCampaign, insertCampaign, insertEnrollment, listAudienceMembers, saveCampaign } from "../src/db.js";
import type { CampaignDraft } from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const ACME = { kind: "company" as const, id: "acme" };
const BETA = { kind: "company" as const, id: "beta" };
const member = (over: Record<string, unknown> = {}) => ({ companyId: "c", client: ACME, listName: "Expo 2026", name: "Ada", email: "Ada@Acme.test", source: "expo sign-up sheet", lawfulBasis: "consent" as const, addedBy: "user-peet", ...over });

describe.skipIf(!available)("audience_members (postgres)", () => {
  let h: PgHarness;
  beforeAll(async () => {
    h = await startPg();
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });
  beforeEach(async () => {
    await h.reset();
  });

  it("the 0.17.2 campaign insert and save and the enrollment insert still run, a client_list draft included (PAR-4100)", async () => {
    const draft: CampaignDraft = {
      id: "camp-1", companyId: "c", name: "Expo", description: "", status: "draft", fromName: "Acme", fromLocal: "hello", replyTo: null, audienceTags: [],
      startAt: null, endAt: null, approvalIssueId: null, winnerVariant: null, clientKind: "company", clientRef: "acme", clientName: "Acme",
      audienceMode: "client_list", delivery: "email", ownerUserId: "user-peet", ownerAgentId: null,
    };
    await insertCampaign(h.ctx, draft);
    await saveCampaign(h.ctx, { ...draft, name: "Expo follow-up", audienceMode: "client_contacts" });
    expect(await getCampaign(h.ctx, "camp-1")).toMatchObject({ name: "Expo follow-up", audienceMode: "client_contacts" });
    await insertEnrollment(h.ctx, { id: "e-1", companyId: "c", campaignId: "camp-1", contactId: "ada", status: "running", stepPosition: 1, variant: "a", nextDueAt: "2099-01-01T08:00:00.000Z", openIssueId: null });
    expect((await h.client.query(`SELECT id FROM ${NAMESPACE}.campaign_enrollments`)).rows).toHaveLength(1);
  });

  it("adds a member once per client list, by email or else phone; the same person may be on another client's list", async () => {
    const ada = await addAudienceMember(h.ctx, member());
    expect(ada).toMatchObject({ client: ACME, listName: "Expo 2026", email: "ada@acme.test", lawfulBasis: "consent", source: "expo sign-up sheet", crmLeadId: null });
    expect(await addAudienceMember(h.ctx, member({ email: " ada@ACME.test ", name: "Ada again" }))).toBeNull();
    expect(await addAudienceMember(h.ctx, member({ client: BETA }))).not.toBeNull();
    expect(await addAudienceMember(h.ctx, member({ listName: "Newsletter" }))).not.toBeNull();
    expect(await addAudienceMember(h.ctx, member({ email: null, phone: "+27821234567", name: "Bob" }))).not.toBeNull();
    expect(await addAudienceMember(h.ctx, member({ email: null, phone: "+27821234567", name: "Bob twice" }))).toBeNull();
    await expect(addAudienceMember(h.ctx, member({ email: null, phone: null }))).rejects.toThrow(/email or a phone/);
    await expect(addAudienceMember(h.ctx, member({ lawfulBasis: "because" }))).rejects.toThrow(/lawfulBasis/);
    // The table itself refuses a row without an address and an unknown lawful basis.
    await expect(h.client.query(`INSERT INTO ${NAMESPACE}.audience_members (id, company_id, client_kind, client_ref, list_name, source, lawful_basis) VALUES ('x', 'c', 'company', 'acme', 'l', 's', 'consent')`)).rejects.toThrow(/audience_members_reachable/);
    await expect(h.client.query(`INSERT INTO ${NAMESPACE}.audience_members (id, company_id, client_kind, client_ref, list_name, email, source, lawful_basis) VALUES ('y', 'c', 'company', 'acme', 'l', 'a@b.test', 's', 'whim')`)).rejects.toThrow(/audience_members_lawful_basis/);
  });

  it("reads one client's lists of one company only, and a list row never appears in CRM contacts", async () => {
    await addAudienceMember(h.ctx, member());
    await addAudienceMember(h.ctx, member({ email: "bob@acme.test", listName: "Newsletter" }));
    await addAudienceMember(h.ctx, member({ client: BETA, email: "carl@beta.test" }));
    await addAudienceMember(h.ctx, member({ companyId: "other", email: "dora@acme.test" }));
    expect((await listAudienceMembers(h.ctx, "c", ACME)).map((m) => m.email)).toEqual(["ada@acme.test", "bob@acme.test"]);
    expect((await listAudienceMembers(h.ctx, "c", ACME, "Newsletter")).map((m) => m.email)).toEqual(["bob@acme.test"]);
    expect((await listAudienceMembers(h.ctx, "c", BETA)).map((m) => m.email)).toEqual(["carl@beta.test"]);
    expect(await listAudienceMembers(h.ctx, "c", { kind: "contact", id: "acme" })).toEqual([]);
    expect((await listAudienceMembers(h.ctx, "other", ACME)).map((m) => m.email)).toEqual(["dora@acme.test"]);
    expect((await h.client.query(`SELECT id FROM ${NAMESPACE}.crm_contacts`)).rows).toHaveLength(0);
  });

  it("finds a person's rows by email and phone in this company, across clients unless one is named", async () => {
    await addAudienceMember(h.ctx, member());
    await addAudienceMember(h.ctx, member({ client: BETA, email: null, phone: "+27821234567" }));
    await addAudienceMember(h.ctx, member({ companyId: "other" }));
    const all = await audienceMembersOf(h.ctx, "c", { emails: ["ADA@acme.test"], phones: ["+27821234567"] });
    expect(all.map((m) => m.client.id).sort()).toEqual(["acme", "beta"]);
    expect((await audienceMembersOf(h.ctx, "c", { emails: ["ada@acme.test"], phones: ["+27821234567"] }, BETA)).map((m) => m.client.id)).toEqual(["beta"]);
  });
});
