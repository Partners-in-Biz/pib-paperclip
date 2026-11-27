/**
 * Stage 3b, PR 3 (PAR-9235; plan PAR-9192 rev. 2, 5.2 and 7): the mode gates on launch, launch on a paused campaign,
 * resume and complete. Each path runs as an agent through the tool and through the page action, in every mode, and as
 * a person. A refusal changes nothing and writes no entry; each change writes one activity entry.
 */
import { describe, expect, it } from "vitest";
import { boot, campaign, CO, enrollment, seed, seedIssue, step } from "./helpers/harness.js";

const MODES = ["off", "safe", "full"] as const;
type Mode = (typeof MODES)[number];
const LABEL: Record<Mode, string> = { off: "Off", safe: "Safe", full: "Auto" };

const AGENT = { companyId: CO, agentId: "agent-camp" };
const asPerson = { companyId: CO, actor: { type: "user" as const, userId: "user-peet", companyId: CO } };
const asAgentOnPage = { companyId: CO, actor: { type: "agent" as const, agentId: "agent-camp", companyId: CO } };

type Harness = Awaited<ReturnType<typeof boot>>["harness"];
type Via = "tool" | "page";

const TOOL = { launch: "launch-campaign", resume: "resume-campaign", complete: "complete-campaign" } as const;
const ACTION = { launch: "campaigns.launch", resume: "campaigns.resume", complete: "campaigns.complete" } as const;

/** The agent's call through the tool or the page action; the error text, or null when it went through. */
async function asAgent(harness: Harness, path: keyof typeof TOOL, via: Via): Promise<string | null> {
  if (via === "tool") {
    const result = await harness.executeTool<{ error?: string }>(TOOL[path], { campaignId: "camp-1" }, AGENT);
    return result.error ?? null;
  }
  try {
    await harness.performAction(ACTION[path], { campaignId: "camp-1" }, asAgentOnPage);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A launchable campaign in `status` with one step and two people tagged vip who can get it, in `mode`. */
async function bootCampaign(mode: Mode, extra: Record<string, unknown> = {}) {
  const store = seed();
  store.campaigns!.push(campaign("camp-1", { audience_tags: ["vip"], owner_user_id: "user-peet", autopilot_mode: mode, ...extra }));
  store.campaign_steps!.push(step("camp-1", 1, "a", "Hi {{first_name|there}}", "Hello {{first_name}}. Reply STOP to stop these emails."));
  return boot({ store });
}

const row = (store: Awaited<ReturnType<typeof boot>>["store"]) => store.campaigns!.find((c) => c.id === "camp-1")!;

describe("launch-campaign on a paused campaign (resume and enroll again): a person in every mode", () => {
  for (const pausedBy of ["user:user-peet", "agent:agent-camp", "auto", null]) {
    for (const mode of MODES) {
      for (const via of ["tool", "page"] as const) {
        it(`refuses the agent through the ${via} in ${LABEL[mode]}, paused by ${pausedBy ?? "nobody recorded"}`, async () => {
          const { harness, store } = await bootCampaign(mode, { status: "paused", paused_by: pausedBy });
          const error = await asAgent(harness, "launch", via);
          expect(error).toMatch(new RegExp(`An agent may not launch a paused campaign .* in ${LABEL[mode]} mode\\. Say so on the campaign's task; a person does it on the campaign screen\\.`));
          expect(row(store)).toMatchObject({ status: "paused", paused_by: pausedBy });
          expect(store.campaign_enrollments).toHaveLength(0);
          expect(harness.activity).toHaveLength(0);
        });
      }
    }
  }

  it("a person launches it again on the page: active, the audience enrolled, the pauser cleared, one entry", async () => {
    const { harness, store } = await bootCampaign("safe", { status: "paused", paused_by: "auto" });
    const result = await harness.performAction<{ status: string; enrolled: number }>("campaigns.launch", { campaignId: "camp-1" }, asPerson);
    expect(result).toMatchObject({ status: "active", enrolled: 3 });
    expect(row(store)).toMatchObject({ status: "active", paused_by: null });
    expect(harness.activity).toHaveLength(1);
    expect(harness.activity[0]).toMatchObject({
      entityId: "camp-1",
      metadata: { actor: "user:user-peet", action: "launch-paused", mode: "safe", from: "paused", enrolled: 3, pausedBy: "auto" },
    });
  });
});

describe("first launch of a draft: a person in every mode", () => {
  function approvedDraft(mode: Mode) {
    return bootCampaign(mode, { status: "draft", approval_issue_id: "appr-1" });
  }

  for (const mode of MODES) {
    for (const via of ["tool", "page"] as const) {
      it(`refuses the agent through the ${via} in ${LABEL[mode]}, even with a person's approval done`, async () => {
        const { harness, store } = await approvedDraft(mode);
        seedIssue(harness, store, { id: "appr-1", status: "done", assigneeUserId: "user-peet" });
        expect(await asAgent(harness, "launch", via)).toMatch(new RegExp(`An agent may not launch this campaign in ${LABEL[mode]} mode\\. Say so on the campaign's task; a person does it`));
        expect(row(store).status).toBe("draft");
        expect(store.campaign_enrollments).toHaveLength(0);
        expect(harness.activity).toHaveLength(0);
      });
    }
  }

  it("names the owner when the own campaign reaches a current client", async () => {
    const { harness, store } = await approvedDraft("safe");
    store.crm_contacts!.find((c) => c.id === "bob")!.lifecycle = "customer";
    expect(await asAgent(harness, "launch", "tool")).toMatch(/the company owner does it on the campaign screen/);
  });

  it("a person's approval launches it, with one entry for the person", async () => {
    const { harness, store } = await approvedDraft("safe");
    seedIssue(harness, store, { id: "appr-1", status: "done", assigneeUserId: "user-peet" });
    const result = await harness.performAction<{ status: string }>("campaigns.launch", { campaignId: "camp-1" }, asPerson);
    expect(result.status).toBe("active");
    expect(harness.activity.map((a) => a.metadata)).toEqual([expect.objectContaining({ actor: "user:user-peet", action: "launch", from: "draft", mode: "safe" })]);
  });

  it("a call nobody can name (a page action without a person) counts as an agent", async () => {
    const { harness, store } = await approvedDraft("safe");
    seedIssue(harness, store, { id: "appr-1", status: "done", assigneeUserId: "user-peet" });
    await expect(harness.performAction("campaigns.launch", { campaignId: "camp-1" }, { companyId: CO })).rejects.toThrow(/counts as an agent/);
    expect(row(store).status).toBe("draft");
  });
});

describe("resume", () => {
  const cases: Array<{ pausedBy: string | null; label: string; agentMay: Mode[] }> = [
    { pausedBy: "agent:agent-camp", label: "the agent's own pause", agentMay: ["full"] },
    { pausedBy: "agent:agent-other", label: "another agent's pause", agentMay: [] },
    { pausedBy: "user:user-peet", label: "a person's pause", agentMay: [] },
    { pausedBy: "auto", label: "an automatic pause", agentMay: [] },
    { pausedBy: null, label: "a pause from before paused_by", agentMay: [] },
  ];
  for (const { pausedBy, label, agentMay } of cases) {
    for (const mode of MODES) {
      for (const via of ["tool", "page"] as const) {
        const allowed = agentMay.includes(mode);
        it(`after ${label}, in ${LABEL[mode]}, through the ${via}: ${allowed ? "the agent may" : "a person"}`, async () => {
          const { harness, store } = await bootCampaign(mode, { status: "paused", paused_by: pausedBy });
          const error = await asAgent(harness, "resume", via);
          if (allowed) {
            expect(error).toBeNull();
            expect(row(store)).toMatchObject({ status: "active", paused_by: null });
            expect(harness.activity.map((a) => a.metadata)).toEqual([expect.objectContaining({ actor: "agent:agent-camp", action: "resume", from: "paused", pausedBy })]);
          } else {
            expect(error).toMatch(/Say so on the campaign's task; a person does it on the campaign screen\./);
            expect(row(store)).toMatchObject({ status: "paused", paused_by: pausedBy });
            expect(harness.activity).toHaveLength(0);
          }
        });
      }
    }
  }

  it("a person resumes after an automatic pause in Off, with one entry", async () => {
    const { harness, store } = await bootCampaign("off", { status: "paused", paused_by: "auto" });
    await harness.performAction("campaigns.resume", { campaignId: "camp-1" }, asPerson);
    expect(row(store)).toMatchObject({ status: "active", paused_by: null });
    expect(harness.activity.map((a) => a.metadata)).toEqual([expect.objectContaining({ actor: "user:user-peet", action: "resume", mode: "off", pausedBy: "auto" })]);
  });
});

describe("complete", () => {
  for (const mode of MODES) {
    for (const via of ["tool", "page"] as const) {
      it(`in ${LABEL[mode]} through the ${via}: ${mode === "full" ? "the agent may once every enrollment is finished" : "a person"}`, async () => {
        const { harness, store } = await bootCampaign(mode);
        store.campaign_enrollments!.push(enrollment("e-1", "camp-1", "ada"));
        const error = await asAgent(harness, "complete", via);
        if (mode === "full") expect(error).toMatch(/only when every enrollment is finished; 1 still running/);
        else expect(error).toMatch(new RegExp(`An agent may not complete this campaign in ${LABEL[mode]} mode\\. Say so on the campaign's task`));
        expect(row(store).status).toBe("active");
        expect(harness.activity).toHaveLength(0);
        if (mode !== "full") return;
        store.campaign_enrollments![0]!.status = "done";
        expect(await asAgent(harness, "complete", via)).toBeNull();
        expect(row(store).status).toBe("completed");
        expect(harness.activity.map((a) => a.metadata)).toEqual([expect.objectContaining({ actor: "agent:agent-camp", action: "complete", mode: "full", from: "active" })]);
      });
    }
  }

  it("a person completes in Safe with people still running, with one entry", async () => {
    const { harness, store } = await bootCampaign("safe");
    store.campaign_enrollments!.push(enrollment("e-1", "camp-1", "ada"));
    await harness.performAction("campaigns.complete", { campaignId: "camp-1" }, asPerson);
    expect(row(store).status).toBe("completed");
    expect(harness.activity).toHaveLength(1);
    expect(harness.activity[0]!.metadata).toMatchObject({ actor: "user:user-peet", action: "complete", mode: "safe" });
  });
});

describe("pause stays open to agents in every mode", () => {
  for (const mode of MODES) {
    it(`${LABEL[mode]}: the agent pauses through the tool`, async () => {
      const { harness, store } = await bootCampaign(mode);
      const result = await harness.executeTool<{ error?: string }>("pause-campaign", { campaignId: "camp-1" }, AGENT);
      expect(result.error).toBeUndefined();
      expect(row(store)).toMatchObject({ status: "paused", paused_by: "agent:agent-camp" });
    });
  }
});
