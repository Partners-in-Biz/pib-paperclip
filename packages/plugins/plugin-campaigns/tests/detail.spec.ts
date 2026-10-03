import { describe, expect, it } from "vitest";
import { approvalState, bodyPreview, deliveryLabel, nextSend, orderedSteps, stepTiming } from "../src/detail.js";
import { boot, campaign, CO, contact, enrollment, FUTURE, PAST, seed, seedIssue, step } from "./helpers/harness.js";

const BOARD = { type: "user" as const, userId: "user-peet" };

describe("campaign detail wording", () => {
  it("names the delivery in plain words", () => {
    expect(deliveryLabel("issue")).toBe("Task for the agent");
    expect(deliveryLabel("email")).toBe("Email from Gmail");
    expect(deliveryLabel("auto")).toBe("Automatic: email, SMS, WhatsApp");
    expect(deliveryLabel(undefined)).toBe("Task for the agent");
  });

  it("says when each step goes out, counting later steps from the one before", () => {
    expect(stepTiming(0, null)).toBe("Goes out at launch");
    expect(stepTiming(2, null)).toBe("2 days after launch");
    expect(stepTiming(1, 1)).toBe("1 day after step 1");
    expect(stepTiming(0, 2)).toBe("Straight after step 2");
  });

  it("numbers steps 1, 2, 3 with their B versions, even when positions skip", () => {
    const steps = orderedSteps([
      { position: 1, delayDays: 0, subject: "Hi", body: "", variant: "a" as const },
      { position: 1, delayDays: 0, subject: "Hey", body: "", variant: "b" as const },
      { position: 3, delayDays: 4, subject: "Follow up", body: "", variant: "a" as const },
    ]);
    expect(steps.map((s) => [s.number, s.position, s.a.subject, s.b?.subject ?? null, s.timing])).toEqual([
      [1, 1, "Hi", "Hey", "Goes out at launch"],
      [2, 3, "Follow up", null, "4 days after step 1"],
    ]);
  });

  it("previews a long body on a word boundary", () => {
    expect(bodyPreview("Short one")).toEqual({ text: "Short one", cut: false });
    const long = bodyPreview(`${"word ".repeat(100)}end`, 40);
    expect(long.cut).toBe(true);
    expect(long.text.endsWith("…")).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(41);
  });

  it("reads the approval state from the approver's side", () => {
    const draft = { status: "draft", approvalIssueId: null, approvalStatus: null };
    expect(approvalState(draft).key).toBe("not-requested");
    expect(approvalState({ ...draft, approvalIssueId: "i", approvalStatus: "todo" })).toEqual({ key: "waiting", label: "Waiting for approval" });
    expect(approvalState({ ...draft, approvalIssueId: "i", approvalStatus: "done" }).key).toBe("approved");
    expect(approvalState({ ...draft, approvalIssueId: "i", approvalStatus: "todo", launchError: "No steps" }).key).toBe("could-not-launch");
    expect(approvalState({ status: "active", approvalIssueId: "i", approvalStatus: "done" }).label).toBe("Approved and launched");
  });

  it("finds the next email out and what waits for the agent", () => {
    const soon = "2026-10-01T08:00:00.000Z";
    const next = nextSend([
      { stepPosition: 2, nextDueAt: "2026-10-05T08:00:00.000Z", waiting: false, sending: false },
      { stepPosition: 1, nextDueAt: soon, waiting: false, sending: false },
      { stepPosition: 1, nextDueAt: "2026-10-01T20:00:00.000Z", waiting: false, sending: false },
      { stepPosition: 1, nextDueAt: PAST, waiting: true, sending: false },
      { stepPosition: 1, nextDueAt: PAST, waiting: false, sending: true },
    ]);
    expect(next).toEqual({ at: soon, stepPosition: 1, contacts: 2, waitingOnAgent: 1, sending: 1 });
    expect(nextSend([])).toEqual({ at: null, stepPosition: null, contacts: 0, waitingOnAgent: 0, sending: 0 });
  });
});

describe("campaigns.detail", () => {
  it("shows a draft's emails in order, who would get it (suppressed left out) and the approval", async () => {
    const store = seed();
    store.campaigns!.push(campaign("camp-1", { status: "draft", audience_tags: ["vip"], approval_issue_id: "iss-1", delivery: "issue" }));
    store.campaign_steps!.push(step("camp-1", 2, "a", "Follow up", "Any thoughts?", 3), step("camp-1", 1, "a", "Hi {{first_name|there}}", "Hello."));
    store.suppressions!.push({ company_id: CO, email: "uma@x.test", reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.crm", contact_id: null, campaign_id: null });
    const { harness } = await boot({ store });
    seedIssue(harness, store, { id: "iss-1", status: "todo", assigneeUserId: "user-peet", title: "Approve campaign camp-1" });
    const detail = await harness.performAction<Record<string, any>>("campaigns.detail", { campaignId: "camp-1" }, { companyId: CO, actor: BOARD });
    expect(detail.campaign.steps.map((s: { subject: string }) => s.subject)).toEqual(["Hi {{first_name|there}}", "Follow up"]);
    expect(detail.audience).toEqual({ matching: 3, willGet: 2, leftOut: 1, notReachable: 0, reach: { email: 2, sms: 0, whatsapp: 0 }, sample: ["Ada Lovelace", "Bob Builder"] });
    expect(detail.approval).toMatchObject({ issueId: "iss-1", status: "todo", withPerson: true, withAgent: false });
    expect(detail.enrolled).toMatchObject({ total: 0, running: 0, done: 0, stopped: 0, sample: [] });
    expect(detail.next).toMatchObject({ at: null, waitingOnAgent: 0 });
  });

  it("shows who is enrolled with names, and the next send of a running campaign", async () => {
    const store = seed();
    store.crm_contacts!.push(contact("dora", "Dora Explorer", ["dora@x.test"]));
    store.campaigns!.push(campaign("camp-2", { status: "active", delivery: "issue", launched_at: "2026-09-25 17:09:53.906307+02" }));
    store.campaign_steps!.push(step("camp-2", 1, "a", "Hello", "Quick hello"), step("camp-2", 2, "a", "Again", "Hello again", 2));
    store.campaign_enrollments!.push(
      enrollment("e-1", "camp-2", "ada", { open_issue_id: "task-1", next_due_at: PAST }),
      enrollment("e-2", "camp-2", "bob", { step_position: 2, next_due_at: FUTURE }),
      enrollment("e-3", "camp-2", "dora", { status: "done", next_due_at: null }),
      enrollment("e-4", "camp-2", "gone", { status: "stopped", next_due_at: null }),
    );
    const { harness } = await boot({ store });
    const detail = await harness.performAction<Record<string, any>>("campaigns.detail", { campaignId: "camp-2" }, { companyId: CO, actor: BOARD });
    expect(detail.campaign.launchedAt).toBe("2026-09-25T15:09:53.906Z");
    expect(detail.enrolled).toMatchObject({ total: 4, running: 2, done: 1, stopped: 1 });
    expect(detail.enrolled.sample.map((row: { name: string | null; status: string }) => [row.name, row.status])).toEqual([
      ["Ada Lovelace", "running"], ["Bob Builder", "running"], ["Dora Explorer", "done"], [null, "stopped"],
    ]);
    expect(detail.enrolled.sample[0]).toMatchObject({ waiting: true });
    expect(detail.next).toEqual({ at: new Date(FUTURE).toISOString(), stepPosition: 2, contacts: 1, waitingOnAgent: 1, sending: 0 });
  });

  it("refuses another company's campaign", async () => {
    const store = seed();
    store.campaigns!.push(campaign("camp-x", { company_id: "co-other" }));
    const { harness } = await boot({ store });
    await expect(harness.performAction("campaigns.detail", { campaignId: "camp-x" }, { companyId: CO, actor: BOARD })).rejects.toThrow(/not found/);
  });
});

describe("add-campaign-step numbering", () => {
  it("adds after the last step, not after the number of rows (a B version shares its step)", async () => {
    const store = seed();
    store.campaigns!.push(campaign("camp-ab", { status: "draft" }));
    store.campaign_steps!.push(step("camp-ab", 1, "a", "Hi", "A"), step("camp-ab", 1, "b", "Hey", "B"));
    const { harness } = await boot({ store });
    const added = await harness.executeTool<{ data: { step: { position: number } } }>("add-campaign-step", { campaignId: "camp-ab", subject: "Follow up", body: "More" }, { companyId: CO, agentId: "agent-camp" });
    expect(added.data.step.position).toBe(2);
  });
});
