/**
 * Our own brands (Velox, JagGids and the like): CRM companies the owner marked as ours. Their campaigns keep the
 * brand's own workspace, sender and do-not-email list, but are approved like our own campaigns, show grouped on the
 * own page, and a person can move a draft between our own work and a brand.
 */
import { describe, expect, it } from "vitest";
import { brandIds, isClientCampaign, isOwnBrandCampaign, ownBrands, withBrand } from "../src/brands.js";
import { boot, campaign, CO, issueUpdated, seed, setIssueStatus, setRoles, step, type Harness } from "./helpers/harness.js";

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
  it("reads the CRM company id at the start of each line; the name after it is only a label", () => {
    expect(brandIds("velox-1 Velox\n  jag_2   JagGids weekly\n\nvelox-1 again")).toEqual(["velox-1", "jag_2"]);
    expect(brandIds("Velox, JagGids")).toEqual([]);
    expect(brandIds("")).toEqual([]);
    expect(brandIds(undefined)).toEqual([]);
  });

  it("adds and removes one company by id and keeps the other lines", () => {
    const one = withBrand("", { id: "velox-1", name: "Velox" }, true);
    expect(one).toBe("velox-1 Velox");
    const two = withBrand(one, { id: "jag-2", name: "JagGids  weekly" }, true);
    expect(two).toBe("velox-1 Velox\njag-2 JagGids weekly");
    expect(withBrand(two, { id: "velox-1", name: "Velox renamed" }, true)).toBe("jag-2 JagGids weekly\nvelox-1 Velox renamed");
    expect(withBrand(two, { id: "velox-1", name: "Velox" }, false)).toBe("jag-2 JagGids weekly");
    expect(withBrand(two, { id: "nobody", name: "X" }, false)).toBe(two);
  });

  it("matches by CRM id only: a second company with the same name, a deleted one and another company's are not brands", async () => {
    const store = seed();
    store.crm_companies!.push(
      { id: "velox-1", company_id: CO, name: "Velox", domain: null, lifecycle: "customer", updated_at: "2026-01-01T00:00:00Z", deleted: false },
      { id: "velox-copy", company_id: CO, name: "velox ", domain: null, lifecycle: "lead", updated_at: "2026-01-01T00:00:00Z", deleted: false },
      { id: "velox-gone", company_id: CO, name: "Velox", domain: null, lifecycle: null, updated_at: "2026-01-01T00:00:00Z", deleted: true },
      { id: "velox-other", company_id: "other-co", name: "Velox", domain: null, lifecycle: null, updated_at: "2026-01-01T00:00:00Z", deleted: false },
    );
    const { harness } = await boot({ store });
    expect(await ownBrands(harness.ctx, CO)).toEqual([]);
    await markBrands(harness, "velox-1 Velox\nvelox-gone Velox\nvelox-other Velox\nno-such-id Velox\nVelox");
    expect(await ownBrands(harness.ctx, CO)).toEqual([{ id: "velox-1", name: "Velox" }]);
    expect(await isClientCampaign(harness.ctx, CO, { clientKind: "company", clientRef: "velox-1" })).toBe(false);
    expect(await isClientCampaign(harness.ctx, CO, { clientKind: "company", clientRef: "velox-copy" })).toBe(true);
  });

  it("a name alone marks nothing, so a company made with a brand's name is still a client", async () => {
    const { harness } = await boot({ store: seed() });
    await markBrands(harness, "Acme Plumbing");
    expect(await ownBrands(harness.ctx, CO)).toEqual([]);
    expect(await isClientCampaign(harness.ctx, CO, { clientKind: "company", clientRef: "acme" })).toBe(true);
  });

  it("when the list or the CRM copy cannot be read, the client rules apply", async () => {
    const { harness } = await boot({ store: seed() });
    await markBrands(harness, "acme Acme Plumbing");
    expect(await isClientCampaign(harness.ctx, CO, { clientKind: "company", clientRef: "acme" })).toBe(false);
    const brokenDb = { ...harness.ctx, db: { ...harness.ctx.db, query: async () => { throw new Error("db down"); } } } as typeof harness.ctx;
    expect(await isClientCampaign(brokenDb, CO, { clientKind: "company", clientRef: "acme" })).toBe(true);
    const brokenState = { ...harness.ctx, state: { ...harness.ctx.state, get: async () => { throw new Error("state down"); } } } as typeof harness.ctx;
    expect(await isClientCampaign(brokenState, CO, { clientKind: "company", clientRef: "acme" })).toBe(true);
  });

  it("only a company client can be a brand", () => {
    const brands = [{ id: "acme", name: "Acme Plumbing" }];
    expect(isOwnBrandCampaign(brands, { clientKind: "company", clientRef: "acme" })).toBe(true);
    expect(isOwnBrandCampaign(brands, { clientKind: "contact", clientRef: "acme" })).toBe(false);
    expect(isOwnBrandCampaign(brands, { clientKind: "company", clientRef: "other" })).toBe(false);
    expect(isOwnBrandCampaign(brands, { clientKind: null, clientRef: null })).toBe(false);
  });

  it("an agent or a plain member cannot change the list, through the preference or through the button", async () => {
    const { harness } = await boot({ store: seed() });
    for (const actor of [AGENT, MEMBER]) {
      const result = await harness.performAction<{ ok: boolean }>("campaigns.preferences-save", { patch: { ownBrands: "acme Acme Plumbing" } }, { companyId: CO, actor: actor as never });
      expect(result.ok).toBe(false);
      await expect(harness.performAction("campaigns.set-own-brand", { client: "company:acme", own: true }, { companyId: CO, actor: actor as never })).rejects.toThrow(/owner or admin/);
    }
    expect(await ownBrands(harness.ctx, CO)).toEqual([]);
  });

  it("an owner marks a company with the button and takes the mark away again; a contact or an unknown company is refused", async () => {
    const { harness } = await boot({ store: seed() });
    const board = { type: "user" as const, userId: "local-board" };
    const set = (client: string, own: boolean) => harness.performAction<Record<string, any>>("campaigns.set-own-brand", { client, own }, { companyId: CO, actor: board as never });
    await expect(set("company:acme", true)).resolves.toMatchObject({ ownBrand: true, client: { id: "acme", name: "Acme Plumbing" } });
    expect(await ownBrands(harness.ctx, CO)).toEqual([{ id: "acme", name: "Acme Plumbing" }]);
    await expect(set("contact:ada", true)).rejects.toThrow(/A contact cannot be a brand/);
    await expect(set("company:nobody", true)).rejects.toThrow(/was not found/);
    await expect(set("company:acme", false)).resolves.toMatchObject({ ownBrand: false });
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
    await markBrands(harness, "acme Acme Plumbing");
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
    await markBrands(harness, "acme Acme Plumbing");
    const { hash } = await requestApproval(harness, store);
    await expect(approve(harness, MEMBER, { audienceHash: hash })).rejects.toThrow(/reaches 1 current client, so only the company owner/);
    await expect(approve(harness, OWNER, { audienceHash: hash })).resolves.toMatchObject({ launched: true });
  });

  it("the mark is read at the moment of the decision: taking it away brings the client rules back", async () => {
    const store = brandStore();
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    await markBrands(harness, "acme Acme Plumbing");
    const { hash } = await requestApproval(harness, store);
    await markBrands(harness, "");
    await expect(approve(harness, OWNER, { audienceHash: hash })).rejects.toThrow(/Record the client's yes/);
    expect(store.campaigns![0]!.status).toBe("draft");
  });
});

describe("every way a brand campaign can launch", () => {
  /** A person marks the approval issue done by hand; the host then sends issue.updated. */
  async function markDone(harness: Harness, store: Store, issueId: string, userId: string) {
    await setIssueStatus(harness, store, issueId, "done");
    await harness.ctx.issues.update(issueId, { assigneeAgentId: null, assigneeUserId: userId }, CO);
    const row = store.issues!.find((issue) => issue.id === issueId)!;
    row.assignee_agent_id = null;
    row.assignee_user_id = userId;
    await issueUpdated(harness, issueId, { type: "user", id: userId });
  }

  it("the approval issue marked done by a member launches a brand campaign that reaches no current client", async () => {
    const store = brandStore();
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    await markBrands(harness, "acme Acme Plumbing");
    const { issueId } = await requestApproval(harness, store);
    await markDone(harness, store, issueId, "user-member");
    expect(store.campaigns![0]).toMatchObject({ status: "active", approved_by_user_id: "user-member" });
  });

  it("the approval issue marked done by a member does not launch one that reaches a current client; the owner's does", async () => {
    const store = brandStore();
    store.crm_contacts!.find((row) => row.id === "bob")!.lifecycle = "customer";
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    await markBrands(harness, "acme Acme Plumbing");
    const { issueId } = await requestApproval(harness, store);
    await markDone(harness, store, issueId, "user-member");
    expect(store.campaigns![0]).toMatchObject({ status: "draft" });
    expect(String(store.campaigns![0]!.launch_error)).toMatch(/reaches 1 current client, so only the company owner approves it/);
    expect(store.campaign_enrollments ?? []).toHaveLength(0);
    await markDone(harness, store, issueId, "user-owner");
    expect(store.campaigns![0]).toMatchObject({ status: "active", approved_by_user_id: "user-owner" });
  });

  it("the same rule now holds for an own campaign marked done by hand", async () => {
    const store = brandStore({ client_kind: null, client_ref: null, client_name: null });
    store.crm_contacts!.find((row) => row.id === "bob")!.lifecycle = "customer";
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    const { issueId } = await requestApproval(harness, store);
    await markDone(harness, store, issueId, "user-member");
    expect(store.campaigns![0]).toMatchObject({ status: "draft" });
    await markDone(harness, store, issueId, "user-owner");
    expect(store.campaigns![0]).toMatchObject({ status: "active" });
  });

  /** Approved by a member whose issue.updated event never arrived. */
  async function approvedUnheard() {
    const store = brandStore();
    store.crm_contacts!.find((row) => row.id === "bob")!.lifecycle = "customer";
    const { harness } = await boot({ store });
    await setRoles(harness, { ownerUserId: "user-owner" });
    await markBrands(harness, "acme Acme Plumbing");
    const { issueId } = await requestApproval(harness, store);
    await setIssueStatus(harness, store, issueId, "done");
    await harness.ctx.issues.update(issueId, { assigneeAgentId: null, assigneeUserId: "user-member" }, CO);
    Object.assign(store.issues!.find((issue) => issue.id === issueId)!, { assignee_agent_id: null, assignee_user_id: "user-member" });
    return { harness, store, issueId };
  }

  it("the catch-up job follows the same rule and hands the approval back with the reason", async () => {
    const { harness, store, issueId } = await approvedUnheard();
    await harness.runJob("open-due-steps");
    expect(store.campaigns![0]).toMatchObject({ status: "draft" });
    expect(String(store.campaigns![0]!.launch_error)).toMatch(/only the company owner approves it/);
    expect((await harness.ctx.issues.get(issueId, CO))!.status).toBe("todo");
    expect(store.campaign_enrollments ?? []).toHaveLength(0);
  });

  it("the launch tool follows the same rule", async () => {
    const { harness, store } = await approvedUnheard();
    const tool = await harness.executeTool<{ data?: unknown; error?: string }>("launch-campaign", { campaignId: "camp-1" }, { companyId: CO, agentId: "agent-camp" });
    expect(tool.error ?? "").toMatch(/only the company owner approves it/);
    expect(store.campaigns![0]).toMatchObject({ status: "draft" });
    expect(store.campaign_enrollments ?? []).toHaveLength(0);
  });

  it("the Reviewer's pass hands a brand campaign to its approver, and to the owner when it reaches a current client", async () => {
    for (const customer of [false, true]) {
      const store = brandStore({ owner_user_id: "user-member" });
      if (customer) store.crm_contacts!.find((row) => row.id === "bob")!.lifecycle = "customer";
      const { harness } = await boot({ store, agents: [{ id: "agent-camp", status: "idle" }, { id: "agent-reviewer", status: "idle" }] });
      await setRoles(harness, { reviewerAgentId: "agent-reviewer", reviewerStatus: "idle", reviewOutward: true, ownerUserId: "user-owner" });
      await markBrands(harness, "acme Acme Plumbing");
      const { issueId } = await requestApproval(harness, store);
      expect((await harness.ctx.issues.get(issueId, CO))!.assigneeAgentId).toBe("agent-reviewer");
      const verdict = await harness.executeTool<{ data?: Record<string, any>; error?: string }>("review-campaign-approval", { campaignId: "camp-1", verdict: "pass", note: "Read all steps." }, { companyId: CO, agentId: "agent-reviewer" });
      expect(verdict.error).toBeUndefined();
      // Reaching a current client: the owner. Otherwise the approver by the usual chain, which a client's campaign never gets.
      if (customer) expect(verdict.data!.assignedToUserId).toBe("user-owner");
      else expect(typeof verdict.data!.assignedToUserId).toBe("string");
    }
  });

  it("the bar's data says how many current clients a brand campaign reaches", async () => {
    const store = brandStore();
    store.crm_contacts!.find((row) => row.id === "bob")!.lifecycle = "customer";
    const { harness } = await boot({ store });
    await markBrands(harness, "acme Acme Plumbing");
    await requestApproval(harness, store);
    const detail = await harness.performAction<Record<string, any>>("campaigns.detail", { campaignId: "camp-1" }, { companyId: CO, actor: MEMBER as never });
    expect(detail.campaign.ownBrand).toBe(true);
    expect(detail.audience.customers).toBe(1);
  });

  it("the approval task of a brand campaign does not ask for a client's yes; a client's still does", async () => {
    for (const marked of [true, false]) {
      const store = brandStore();
      const { harness } = await boot({ store });
      if (marked) await markBrands(harness, "acme Acme Plumbing");
      const { issueId } = await requestApproval(harness, store);
      const description = String((await harness.ctx.issues.get(issueId, CO))!.description);
      if (marked) expect(description).not.toMatch(/where the client said yes/);
      else expect(description).toMatch(/where the client said yes/);
    }
  });
});

describe("a brand still sends as itself", () => {
  it("a brand campaign without its own sender is refused before approval, marked or not", async () => {
    const store = brandStore();
    store.sender_identities = [];
    const { harness } = await boot({ store });
    await markBrands(harness, "acme Acme Plumbing");
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
    await markBrands(harness, "acme Acme Plumbing");
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
    await markBrands(harness, "acme Acme Plumbing");
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
    await markBrands(harness, "acme Acme Plumbing");
    await expect(move(harness, MEMBER, null)).rejects.toThrow(/Change the audience to tags first/);
    expect(store.campaigns![0]).toMatchObject({ client_ref: "acme", audience_mode: "client_contacts" });
  });

  it("a draft that launched while the move was under way stays where it is", async () => {
    const store = ownDraft();
    const { harness } = await boot({ store });
    await markBrands(harness, "acme Acme Plumbing");
    // The launch lands between the action's read and its write.
    const realGet = harness.ctx.issues.get.bind(harness.ctx.issues);
    const execute = harness.ctx.db.execute.bind(harness.ctx.db);
    harness.ctx.db.execute = (async (sql: string, params?: unknown[]) => {
      if (/UPDATE [^ ]*campaigns\s+SET client_kind/.test(sql)) store.campaigns![0]!.status = "active";
      return execute(sql, params);
    }) as typeof harness.ctx.db.execute;
    await expect(move(harness, MEMBER, "company:acme")).rejects.toThrow(/launched or changed just now/);
    expect(store.campaigns![0]).toMatchObject({ status: "active", client_ref: null });
    void realGet;
  });

  it("moving cancels an open approval: the approver saw another sender", async () => {
    const store = ownDraft();
    const { harness } = await boot({ store });
    await markBrands(harness, "acme Acme Plumbing");
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
    await markBrands(harness, "acme Acme Plumbing");
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
