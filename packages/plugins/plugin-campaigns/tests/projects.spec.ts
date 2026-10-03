import { describe, expect, it } from "vitest";
import { boot, campaign, CO, contact, enrollment, issueUpdated, PAST, seed, seedIssue, setIssueStatus, step } from "./helpers/harness.js";
import { campaignsProjectId } from "../src/projects.js";
import type { Store } from "./helpers/fake-db.js";

const CRM = "plugin.partnersinbiz.crm.client.projects.updated";
const AGENT = { companyId: CO, agentId: "agent-camp" };

const project = (id: string, extra: Record<string, unknown> = {}) => ({ id, companyId: CO, name: id, archivedAt: null, ...extra }) as never;

const link = (harness: Awaited<ReturnType<typeof boot>>["harness"], projectIds: string[], updatedAt = new Date().toISOString(), ref = "acme") =>
  harness.emit(CRM as `plugin.${string}`, { clientKind: "company", clientRef: ref, projectIds, updatedAt }, { companyId: CO });

function store(): Store {
  const s = seed();
  s.campaigns!.push(
    campaign("camp-own", { delivery: "issue" }),
    campaign("camp-acme", { delivery: "issue", client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing" }),
  );
  s.campaign_steps!.push(step("camp-own", 1, "a", "Hi", "Hello"), step("camp-acme", 1, "a", "Hi", "Hello"));
  return s;
}

async function stepIssueFor(harness: Awaited<ReturnType<typeof boot>>["harness"], s: Store, enrollmentId: string, campaignId: string) {
  s.campaign_enrollments!.push(enrollment(enrollmentId, campaignId, "ada", { next_due_at: PAST }));
  await harness.runJob("open-due-steps");
  const issues = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" });
  return issues.find((issue) => issue.originId === `campaigns:step:${enrollmentId}:1`)!;
}

describe("client work opens in the client's own project", () => {
  it("a client's step issue goes to the project the CRM linked, and PiB's own work to the managed Campaigns project", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    harness.seed({ projects: [project("proj-acme")] });
    await link(harness, ["proj-acme"]);
    const own = await stepIssueFor(harness, s, "e-own", "camp-own");
    const client = await stepIssueFor(harness, s, "e-acme", "camp-acme");
    expect(client.projectId).toBe("proj-acme");
    const managed = await campaignsProjectId(harness.ctx, CO);
    expect(managed).toBeTruthy();
    expect(own.projectId).toBe(managed);
    expect(client.projectId).not.toBe(managed);
  });

  it("falls back to the Campaigns project for a client with no link, a link that was removed, and a project that no longer exists or is archived", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    harness.seed({ projects: [project("proj-archived", { archivedAt: new Date("2026-09-01") })] });
    const managed = (await campaignsProjectId(harness.ctx, CO))!;
    // Never linked.
    expect((await stepIssueFor(harness, s, "e1", "camp-acme")).projectId).toBe(managed);
    // Linked to an archived project, and to one that does not exist.
    await link(harness, ["proj-archived", "proj-gone"], new Date(Date.now() + 1000).toISOString());
    s.campaign_enrollments!.push(enrollment("e2", "camp-acme", "bob", { next_due_at: PAST }));
    await harness.runJob("open-due-steps");
    const issues = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" });
    expect(issues.find((issue) => issue.originId === "campaigns:step:e2:1")!.projectId).toBe(managed);
  });

  it("a later list replaces an earlier one (unlinking is an empty list) and an older event is ignored", async () => {
    const s = store();
    const { harness } = await boot({ store: s });
    harness.seed({ projects: [project("proj-acme"), project("proj-new")] });
    const t0 = Date.now();
    await link(harness, ["proj-acme"], new Date(t0).toISOString());
    expect((await stepIssueFor(harness, s, "e1", "camp-acme")).projectId).toBe("proj-acme");
    // An older list that arrives late changes nothing.
    await link(harness, ["proj-new"], new Date(t0 - 60_000).toISOString());
    s.campaign_enrollments!.push(enrollment("e2", "camp-acme", "bob", { next_due_at: PAST }));
    await harness.runJob("open-due-steps");
    let issues = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" });
    expect(issues.find((i) => i.originId === "campaigns:step:e2:1")!.projectId).toBe("proj-acme");
    // Unlinked: back to the Campaigns project.
    await link(harness, [], new Date(t0 + 60_000).toISOString());
    s.campaign_enrollments!.push(enrollment("e3", "camp-acme", "uma", { next_due_at: PAST }));
    await harness.runJob("open-due-steps");
    issues = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" });
    expect(issues.find((i) => i.originId === "campaigns:step:e3:1")!.projectId).toBe(await campaignsProjectId(harness.ctx, CO));
  });

  it("one client's link never serves another client", async () => {
    const s = store();
    s.campaigns!.push(campaign("camp-beta", { delivery: "issue", client_kind: "company", client_ref: "beta", client_name: "Beta Co" }));
    s.campaign_steps!.push(step("camp-beta", 1, "a", "Hi", "Hello"));
    const { harness } = await boot({ store: s });
    harness.seed({ projects: [project("proj-acme")] });
    await link(harness, ["proj-acme"]);
    const beta = await stepIssueFor(harness, s, "e-beta", "camp-beta");
    expect(beta.projectId).not.toBe("proj-acme");
  });

  it("also covers the approval, the reply, the failed send and the revision a client's campaign opens", async () => {
    const s = store();
    s.campaigns![1]!.status = "draft";
    s.campaigns![1]!.owner_user_id = "user-peet";
    s.sender_identities = [{ company_id: CO, sender_key: "company:acme", from_address: "hello@acme.test", from_name: "Acme", reply_to: null, sms_from: null, whatsapp_from: null }];
    const { harness } = await boot({ store: s });
    harness.seed({ projects: [project("proj-acme")] });
    await link(harness, ["proj-acme"]);
    s.campaigns![1]!.delivery = "email";
    const asked = await harness.executeTool<{ data: { approvalIssueId: string } }>("request-campaign-approval", { campaignId: "camp-acme" }, AGENT);
    expect((await harness.ctx.issues.get(asked.data.approvalIssueId, CO))!.projectId).toBe("proj-acme");
    // Refused: the revise issue is the client's project's work too.
    const issue = (await harness.ctx.issues.get(asked.data.approvalIssueId, CO))!;
    seedIssue(harness, s, { id: issue.id, status: "todo", assigneeUserId: "user-peet" });
    await setIssueStatus(harness, s, issue.id, "cancelled");
    await issueUpdated(harness, issue.id, { type: "user", id: "user-peet" });
    const revise = (await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" })).find((i) => /^campaigns:revise:/.test(i.originId ?? ""));
    expect(revise?.title).toMatch(/^\[Acme Plumbing\] Revise campaign camp-acme/);
    expect(revise?.projectId).toBe("proj-acme");
    // A failed send of an active campaign.
    s.campaigns![1]!.status = "active";
    s.campaign_enrollments!.push(enrollment("e-f", "camp-acme", "ada", { sending_key: "campaigns:step:e-f:1", next_due_at: PAST }));
    s.outbox!.push({ key: "campaigns:step:e-f:1", company_id: CO, event: "mail.send.requested", payload: {}, status: "failed", attempts: 20, last_error: "Gmail not connected", result: null });
    await harness.runJob("redeliver-mail");
    const failed = (await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" })).find((i) => /^campaigns:send-failed:/.test(i.originId ?? ""));
    expect(failed?.projectId).toBe("proj-acme");
    // A reply to one of its emails.
    await harness.emit("plugin.partnersinbiz.mailbox.mail.received" as `plugin.${string}`, {
      key: "mail:m-1", messageId: "m-1", threadId: "t-1", from: { email: "ada@acme.test", name: "Ada" }, subject: "Re: Hi", snippet: "Please call me",
      replyTo: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: "e-f" },
    }, { companyId: CO });
    const reply = (await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" })).find((i) => /^campaigns:reply:/.test(i.originId ?? ""));
    expect(reply).toBeTruthy();
    expect(reply?.projectId).toBe("proj-acme");
  });

  it("PiB's own campaign revision opens in the managed Campaigns project, not a client's", async () => {
    const s = store();
    s.campaigns![0]!.status = "draft";
    s.campaigns![0]!.owner_user_id = "user-peet";
    s.campaigns![0]!.delivery = "email";
    const { harness } = await boot({ store: s });
    harness.seed({ projects: [project("proj-acme")] });
    await link(harness, ["proj-acme"]);
    const asked = await harness.executeTool<{ data: { approvalIssueId: string } }>("request-campaign-approval", { campaignId: "camp-own" }, AGENT);
    seedIssue(harness, s, { id: asked.data.approvalIssueId, status: "todo", assigneeUserId: "user-peet" });
    await setIssueStatus(harness, s, asked.data.approvalIssueId, "cancelled");
    await issueUpdated(harness, asked.data.approvalIssueId, { type: "user", id: "user-peet" });
    const revise = (await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" })).find((i) => /^campaigns:revise:/.test(i.originId ?? ""));
    expect(revise).toBeTruthy();
    expect(revise?.projectId).toBe(await campaignsProjectId(harness.ctx, CO));
    expect(revise?.projectId).not.toBe("proj-acme");
  });
});
