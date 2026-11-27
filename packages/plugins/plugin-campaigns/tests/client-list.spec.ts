/**
 * Stage 4c (plan PAR-9192 revision 2, 5.5 and 7): a client campaign may be a draft with a `client_list` audience, but
 * the check before approval (and launch) refuses it until list members have the stop paths (4d). A list never falls
 * back to our own contacts (F16). Export and erase cover a list member.
 */
import { describe, expect, it } from "vitest";
import { HANDOFF_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { audienceContacts } from "../src/db.js";
import { audienceLine, audienceSource, createCampaign, isEveryContact } from "../src/domain.js";
import { evaluatePreflight, type PreflightFacts } from "../src/preflight.js";
import { boot, CO, seed } from "./helpers/harness.js";

const AGENT = { companyId: CO, agentId: "agent-camp" };
const ADA_PHONE = "+27821234567";
type Result = { data?: Record<string, any>; error?: string };

function listStore() {
  const s = seed();
  s.sender_identities = [{ company_id: CO, sender_key: "company:acme", from_address: "hello@acme.test", from_name: "Acme", reply_to: null, sms_from: null, whatsapp_from: null }];
  const row = (id: string, client: string, email: string | null, phone: string | null) => ({
    id, company_id: CO, client_kind: "company", client_ref: client, list_name: "Expo", name: id, email, phone, source: "expo sheet",
    lawful_basis: "consent", added_by: "user-peet", added_at: "2026-11-20T08:00:00Z", crm_lead_id: null,
  });
  s.audience_members = [row("m-ada", "acme", "ada@expo.test", ADA_PHONE), row("m-ada-beta", "beta", null, ADA_PHONE), row("m-bob", "acme", "bob@expo.test", null)];
  s.channel_consents = [{ company_id: CO, channel: "sms", address: ADA_PHONE, sender_key: "company:acme", granted: true, basis: "consent", source: "import", evidence: "expo sheet", recorded_at: "2026-11-20T08:00:00Z" }];
  return s;
}

describe("client_list audience", () => {
  it("a client draft may have it; our own campaign may not", async () => {
    const { harness } = await boot({ store: listStore() });
    const made = await harness.executeTool<Result>("create-campaign", { name: "Expo follow-up", client: "company:acme", audienceMode: "client_list" }, AGENT);
    expect(made.data).toMatchObject({ status: "draft", audienceMode: "client_list" });
    const own = await harness.executeTool<Result>("create-campaign", { name: "Ours", audienceMode: "client_list" }, AGENT);
    expect(own.error).toMatch(/needs a client/);
  });

  it("the approval request is refused: client lists cannot be sent to yet", async () => {
    const { harness, store } = await boot({ store: listStore() });
    const made = await harness.executeTool<Result>("create-campaign", { name: "Expo follow-up", client: "company:acme", audienceMode: "client_list" }, AGENT);
    const campaignId = String(made.data!.id);
    await harness.executeTool<Result>("add-campaign-step", { campaignId, subject: "Thanks for visiting", body: "Hello {{first_name|there}}, good to meet you." }, AGENT);
    const preflight = await harness.executeTool<Result>("preflight-campaign", { campaignId, links: false }, AGENT);
    expect(preflight.data!.errors.map((e: { code: string }) => e.code)).toContain("client-list");
    const asked = await harness.executeTool<Result>("request-campaign-approval", { campaignId }, AGENT);
    expect(asked.error).toMatch(/client lists cannot be sent to yet/);
    expect(store.campaigns!.find((c) => c.id === campaignId)).toMatchObject({ status: "draft", approval_issue_id: null });
  });

  it("the check before launch refuses it too, and it never reads our own contacts (F16)", async () => {
    const draft = createCampaign({ companyId: CO, name: "Expo", audienceMode: "client_list", client: { kind: "company", id: "acme", name: "Acme" } });
    const facts: PreflightFacts = { campaign: draft, steps: [], email: null, emailHealth: null, mailboxOn: true, linkProblem: null, oneClick: false, channels: {}, audience: null, liveLinks: null };
    expect(evaluatePreflight(facts).errors.find((e) => e.code === "client-list")?.message).toBe("The audience is Acme's own list, and client lists cannot be sent to yet.");
    expect(audienceSource(draft)).toEqual({ kind: "list", client: { kind: "company", id: "acme" } });
    expect(isEveryContact(draft)).toBe(false);
    expect(audienceLine(draft, 0)).toBe("People on Acme's list (0)");
    const { harness } = await boot({ store: listStore() });
    expect(await audienceContacts(harness.ctx, CO, draft)).toEqual([]);
  });
});

describe("privacy covers list members", () => {
  it("export-person-data returns the lists a person is on and their opt-ins", async () => {
    const { harness } = await boot({ store: listStore() });
    const out = await harness.executeTool<Result>("export-person-data", { email: "ADA@expo.test" }, AGENT);
    expect(out.data!.counts).toEqual({ list_members: 2, consents: 1 });
    expect(out.data!.listMemberships.map((m: { id: string }) => m.id).sort()).toEqual(["m-ada", "m-ada-beta"]);
    expect(out.data!.listMemberships[0]).toMatchObject({ listName: "Expo", source: "expo sheet", lawfulBasis: "consent" });
    expect(out.data!.consents[0]).toMatchObject({ channel: "sms", address: ADA_PHONE, senderKey: "company:acme", granted: true });
    expect((await harness.executeTool<Result>("export-person-data", {}, AGENT)).error).toMatch(/email or phone/);
  });

  it("an approved erasure deletes their rows on every client list and the consents of the numbers on them", async () => {
    const { harness, store, emit } = await boot({ store: listStore() });
    await harness.emit("plugin.partnersinbiz.crm.contact.erase.requested" as `plugin.${string}`, {
      requestId: "req-1", subject: { email: "ada@expo.test" }, scope: "all", reason: "data_subject_request",
      approvedByUserId: "user-peet", requestedAt: "2026-11-27T08:00:00Z", source: "partnersinbiz.crm",
    }, { companyId: CO });
    const answer = emit.mock.calls.find(([name]) => name === HANDOFF_EVENTS.contactEraseCompleted)?.[2] as Record<string, any>;
    expect(answer).toMatchObject({ status: "erased" });
    expect(answer.counts).toMatchObject({ list_members: 2, consents: 1 });
    expect(store.audience_members!.map((m) => m.id)).toEqual(["m-bob"]);
    expect(store.channel_consents).toEqual([]);
  });
});
