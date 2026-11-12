/**
 * Our own brands (Velox, JagGids and the like): CRM companies the owner marked as ours. Their campaigns keep the
 * brand's own workspace, sender and do-not-email list, but are approved like our own campaigns, show grouped on the
 * own page, and a person can move a draft between our own work and a brand.
 */
import { describe, expect, it } from "vitest";
import { brandNames, isOwnBrandCampaign, ownBrands } from "../src/brands.js";
import { boot, campaign, CO, seed, setRoles, step, type Harness } from "./helpers/harness.js";

const OWNER = { type: "user" as const, userId: "user-owner" };
const MEMBER = { type: "user" as const, userId: "user-member" };
const AGENT = { type: "agent" as const, agentId: "agent-camp" };
const PREFS = { scopeKind: "company" as const, scopeId: CO, namespace: "preferences", stateKey: "v1" };

type Store = ReturnType<typeof seed>;

async function markBrands(harness: Harness, names: string) {
  await harness.ctx.state.set(PREFS, { values: { ownBrands: names }, updatedBy: "user-owner", updatedAt: "2026-11-12T00:00:00Z" });
}

function brandStore(extra: Record<string, unknown> = {}) {
  const store = seed();
  store.campaigns!.push(campaign("camp-1", { status: "draft", audience_tags: ["vip"], audience_mode: "tags", client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing", owner_user_id: "user-peet", ...extra }));
  store.campaign_steps!.push(step("camp-1", 1, "a", "Hi {{first_name|there}}", "Hello {{first_name}}. Reply STOP to stop these emails."));
  // A brand sends as itself, like a client: without its own sender the check before approval refuses the campaign.
  store.sender_identities = [{ company_id: CO, sender_key: "company:acme", from_address: "hello@acme.test", from_name: "Acme", reply_to: null, sms_from: null, whatsapp_from: null }];
  return store;
}

async function requestApproval(harness: Harness, store: Store) {
  const result = await harness.executeTool<{ data?: Record<string, unknown>; error?: string }>("request-campaign-approval", { campaignId: "camp-1" }, { companyId: CO, agentId: "agent-camp" });
  if (!result.data) throw new Error(`request-campaign-approval failed: ${result.error}`);
  const issueId = String(result.data.approvalIssueId);
  const issue = await harness.ctx.issues.get(issueId, CO);
  (store.issues ??= []).push({ id: issueId, status: issue!.status, assignee_agent_id: issue!.assigneeAgentId ?? null, assignee_user_id: issue!.assigneeUserId ?? null, created_at: new Date().toISOString() });
  return { issueId, hash: String(store.campaigns![0]!.approval_audience_hash) };
}

const approve = (harness: Harness, actor: Record<string, unknown>, params: Record<string, unknown>) =>
  harness.performAction<Record<string, unknown>>("campaigns.approve", { campaignId: "camp-1", ...params }, { companyId: CO, actor: actor as never });
const move = (harness: Harness, actor: Record<string, unknown>, client: string | null, campaignId = "camp-1") =>
  harness.performAction<Record<string, any>>("campaigns.move", { campaignId, client: client ?? "own" }, { companyId: CO, actor: actor as never });

describe("which companies are our own brands", () => {
  it("reads names one per line or comma separated, trimmed, without blanks or repeats", () => {
    expect(brandNames(" Velox \nJagGids, velox\n\n")).toEqual(["velox", "jaggids"]);
    expect(brandNames("")).toEqual([]);
    expect(brandNames(undefined)).toEqual([]);
  });

  it("matches CRM companies by name, whatever the case; a deleted company, another company's and an unknown name mark nothing", async () => {
    const store = seed();
    store.crm_companies!.push(
      { id: "velox-1", company_id: CO, name: "Velox", domain: null, lifecycle: "customer", updated_at: "2026-01-01T00:00:00Z", deleted: false },
      { id: "velox-2", company_id: CO, name: "velox", domain: "veloxmath.com", lifecycle: "lead", updated_at: "2026-01-01T00:00:00Z", deleted: false },
      { id: "velox-gone", company_id: CO, name: "Velox", domain: null, lifecycle: null, updated_at: "2026-01-01T00:00:00Z", deleted: true },
      { id: "velox-other", company_id: "other-co", name: "Velox", domain: null, lifecycle: null, updated_at: "2026-01-01T00:00:00Z", deleted: false },
    );
    const { harness } = await boot({ store });
    expect(await ownBrands(harness.ctx, CO)).toEqual([]);
    await markBrands(harness, "VELOX\nNo Such Company");
    expect((await ownBrands(harness.ctx, CO)).map((brand) => brand.id).sort()).toEqual(["velox-1", "velox-2"]);
  });

  it("only a company client can be a brand", () => {
    const brands = [{ id: "acme", name: "Acme Plumbing" }];
    expect(isOwnBrandCampaign(brands, { clientKind: "company", clientRef: "acme" })).toBe(true);
    expect(isOwnBrandCampaign(brands, { clientKind: "contact", clientRef: "acme" })).toBe(false);
    expect(isOwnBrandCampaign(brands, { clientKind: "company", clientRef: "other" })).toBe(false);
    expect(isOwnBrandCampaign(brands, { clientKind: null, clientRef: null })).toBe(false);
  });

  it("an agent or a plain member cannot change the list", async () => {
    const { harness } = await boot({ store: seed() });
    for (const actor of [AGENT, MEMBER]) {
      const result = await harness.performAction<{ ok: boolean }>("campaigns.preferences-save", { patch: { ownBrands: "Acme Plumbing" } }, { companyId: CO, actor: actor as never });
      expect(result.ok).toBe(false);
    }
    expect(await ownBrands(harness.ctx, CO)).toEqual([]);
  });
});

describe("approving a campaign of one of our own brands", () => {
  it("without the brand mark it is a client's campaign: the client's yes and the owner are needed", async () => {
    const store = brandStore();
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    const { hash } = await requestApproval(harness, store);
    await expect(approve(harness, MEMBER, { audienceHash: hash })).rejects.toThrow(/a client's campaign, so only the company owner/);
    await expect(approve(harness, OWNER, { audienceHash: hash })).rejects.toThrow(/Record the client's yes/);
    expect(store.campaigns![0]!.status).toBe("draft");
  });

  it("with the mark it is approved like an own campaign: any board member, no client's yes, and it launches", async () => {
    const store = brandStore();
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    await markBrands(harness, "Acme Plumbing");
    const { hash } = await requestApproval(harness, store);
    await expect(approve(harness, AGENT, { audienceHash: hash })).rejects.toThrow(/Only a person/);
    await expect(approve(harness, MEMBER, { audienceHash: hash })).resolves.toMatchObject({ approved: true, launched: true });
    expect(store.campaigns![0]).toMatchObject({ status: "active", client_ref: "acme", approved_by_user_id: "user-member" });
    expect(store.campaigns![0]!.client_yes_ref ?? null).toBeNull();
  });

  it("a brand campaign that reaches a current client still needs the owner", async () => {
    const store = brandStore();
    store.crm_contacts!.find((row) => row.id === "bob")!.lifecycle = "customer";
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    await markBrands(harness, "Acme Plumbing");
    const { hash } = await requestApproval(harness, store);
    await expect(approve(harness, MEMBER, { audienceHash: hash })).rejects.toThrow(/reaches 1 current client, so only the company owner/);
    await expect(approve(harness, OWNER, { audienceHash: hash })).resolves.toMatchObject({ launched: true });
  });

  it("the mark is read at the moment of the decision: taking it away brings the client rules back", async () => {
    const store = brandStore();
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    await markBrands(harness, "Acme Plumbing");
    const { hash } = await requestApproval(harness, store);
    await markBrands(harness, "");
    await expect(approve(harness, OWNER, { audienceHash: hash })).rejects.toThrow(/Record the client's yes/);
    expect(store.campaigns![0]!.status).toBe("draft");
  });
});

describe("a brand still sends as itself", () => {
  it("a brand campaign without its own sender is refused before approval, marked or not", async () => {
    const store = brandStore();
    store.sender_identities = [];
    const { harness } = await boot({ store });
    await markBrands(harness, "Acme Plumbing");
    const result = await harness.executeTool<{ data?: unknown; error?: string }>("request-campaign-approval", { campaignId: "camp-1" }, { companyId: CO, agentId: "agent-camp" });
    expect(result.error).toMatch(/No sender is set up for company:acme/);
  });
});

describe("campaigns.move", () => {
  function ownDraft(extra: Record<string, unknown> = {}) {
    return brandStore({ client_kind: null, client_ref: null, client_name: null, ...extra });
  }

  it("a person moves an own draft to a brand and back; the tag audience stays", async () => {
    const store = ownDraft();
    const { harness } = await boot({ store });
    await markBrands(harness, "Acme Plumbing");
    const moved = await move(harness, MEMBER, "company:acme");
    expect(moved).toMatchObject({ moved: true, approvalReset: false, client: { kind: "company", id: "acme", name: "Acme Plumbing" } });
    expect(store.campaigns![0]).toMatchObject({ client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing", audience_mode: "tags", audience_tags: ["vip"], status: "draft" });
    await expect(move(harness, MEMBER, "company:acme")).resolves.toMatchObject({ moved: false });
    await expect(move(harness, MEMBER, null)).resolves.toMatchObject({ moved: true, client: null });
    expect(store.campaigns![0]).toMatchObject({ client_kind: null, client_ref: null, client_name: null, audience_mode: "tags" });
  });

  it("refuses an agent, a company that is not a brand, a client's campaign and a launched campaign", async () => {
    const store = ownDraft();
    store.crm_companies!.push({ id: "globex", company_id: CO, name: "Globex", domain: null, lifecycle: "customer", updated_at: "2026-01-01T00:00:00Z", deleted: false });
    store.campaigns!.push(campaign("camp-client", { status: "draft", audience_tags: ["vip"], audience_mode: "tags", client_kind: "company", client_ref: "globex", client_name: "Globex" }));
    store.campaigns!.push(campaign("camp-live", { status: "active", audience_tags: ["vip"], audience_mode: "tags" }));
    const { harness } = await boot({ store });
    await markBrands(harness, "Acme Plumbing");
    await expect(move(harness, AGENT, "company:acme")).rejects.toThrow(/Only a signed-in person/);
    await expect(move(harness, MEMBER, "company:globex")).rejects.toThrow(/only moves to one of our own brands/);
    await expect(move(harness, MEMBER, "company:acme", "camp-client")).rejects.toThrow(/a client's campaign/);
    await expect(move(harness, MEMBER, null, "camp-client")).rejects.toThrow(/a client's campaign/);
    await expect(move(harness, MEMBER, "company:acme", "camp-live")).rejects.toThrow(/Only a draft can move/);
    expect(store.campaigns!.map((row) => row.client_ref)).toEqual([null, "globex", null]);
  });

  it("refuses when no brand is marked, and when the audience is the contacts at a company", async () => {
    const store = brandStore({ audience_tags: [], audience_mode: "client_contacts" });
    const { harness } = await boot({ store });
    await expect(move(harness, MEMBER, null)).rejects.toThrow(/a client's campaign/);
    await markBrands(harness, "Acme Plumbing");
    await expect(move(harness, MEMBER, null)).rejects.toThrow(/Change the audience to tags first/);
    expect(store.campaigns![0]).toMatchObject({ client_ref: "acme", audience_mode: "client_contacts" });
  });

  it("moving cancels an open approval: the approver saw another sender", async () => {
    const store = ownDraft();
    const { harness } = await boot({ store });
    await markBrands(harness, "Acme Plumbing");
    const { issueId } = await requestApproval(harness, store);
    await expect(move(harness, MEMBER, "company:acme")).resolves.toMatchObject({ moved: true, approvalReset: true });
    expect(store.campaigns![0]).toMatchObject({ client_ref: "acme", approval_issue_id: null });
    expect((await harness.ctx.issues.get(issueId, CO))!.status).toBe("cancelled");
  });
});

describe("the own page groups our brands", () => {
  it("lists each brand with its campaigns beside our own, and marks them", async () => {
    const store = brandStore();
    store.campaigns!.push(campaign("camp-own", { status: "draft", audience_tags: ["vip"] }));
    const { harness } = await boot({ store });
    const load = () => harness.performAction<Record<string, any>>("campaigns.load", {}, { companyId: CO, actor: MEMBER as never });
    const before = await load();
    expect(before.campaigns.map((row: any) => row.id)).toEqual(["camp-own"]);
    expect(before.brands).toEqual([]);
    await markBrands(harness, "Acme Plumbing");
    const after = await load();
    expect(after.campaigns.map((row: any) => row.id)).toEqual(["camp-own"]);
    expect(after.brands).toHaveLength(1);
    expect(after.brands[0].client).toEqual({ kind: "company", id: "acme", name: "Acme Plumbing" });
    expect(after.brands[0].campaigns.map((row: any) => [row.id, row.ownBrand, row.state.key])).toEqual([["camp-1", true, "draft"]]);
    // The brand's own workspace says it is a brand; another client's does not.
    const workspace = await harness.performAction<Record<string, any>>("campaigns.load", { client: "company:acme" }, { companyId: CO, actor: MEMBER as never });
    expect(workspace).toMatchObject({ ownBrand: true, brands: [] });
    expect(workspace.campaigns.map((row: any) => row.id)).toEqual(["camp-1"]);
  });
});
