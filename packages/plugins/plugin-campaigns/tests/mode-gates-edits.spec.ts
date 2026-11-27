/**
 * Stage 3b, PR 4 (PAR-9236; plan PAR-9192 rev. 2, 5.2 and 7): the mode gates on enroll, the A/B winner, the draft edits
 * and the results reads. Each path runs as an agent through the tool and, where one exists, through the page action, in
 * every mode. A refusal changes nothing and writes no entry; each change writes one activity entry. Stop-direction
 * tools are never refused.
 */
import { describe, expect, it } from "vitest";
import { boot, campaign, CO, enrollment, seed, step } from "./helpers/harness.js";

const MODES = ["off", "safe", "full"] as const;
type Mode = (typeof MODES)[number];
const LABEL: Record<Mode, string> = { off: "Off", safe: "Safe", full: "Auto" };

const AGENT = { companyId: CO, agentId: "agent-camp" };
const asPerson = { companyId: CO, actor: { type: "user" as const, userId: "user-peet", companyId: CO } };
const asAgentOnPage = { companyId: CO, actor: { type: "agent" as const, agentId: "agent-camp", companyId: CO } };

type Booted = Awaited<ReturnType<typeof boot>>;
type Harness = Booted["harness"];
type Via = "tool" | "page";

/** The call as an agent through the tool or the page action; the error text, or null when it went through. */
async function asAgent(harness: Harness, via: Via, name: string, params: Record<string, unknown>): Promise<string | null> {
  if (via === "tool") return (await harness.executeTool<{ error?: string }>(name, params, AGENT)).error ?? null;
  try {
    await harness.performAction(name, params, asAgentOnPage);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** camp-1 in `mode` and `status`, one email step, audience vip (Ada, Bob, Uma). */
function bootCampaign(mode: Mode, status: string, extra: Record<string, unknown> = {}): Promise<Booted> {
  const store = seed();
  store.campaigns!.push(campaign("camp-1", { status, audience_tags: ["vip"], owner_user_id: "user-peet", autopilot_mode: mode, ...extra }));
  store.campaign_steps!.push(step("camp-1", 1, "a", "Hi {{first_name|there}}", "Hello {{first_name}}. Reply STOP to stop these emails."));
  return boot({ store });
}

const row = (booted: Booted) => booted.store.campaigns!.find((c) => c.id === "camp-1")!;
const actions = (harness: Harness) => harness.activity.map((a) => a.metadata?.action);

const BODY = "Hello again {{first_name}}. Reply STOP to stop these emails.";
/** Every draft edit (plan 3.2): the call, and the activity key it writes. */
const DRAFT_EDITS: Array<{ via: Via; name: string; params: Record<string, unknown>; action: string }> = [
  { via: "tool", name: "update-campaign", params: { campaignId: "camp-1", name: "Renamed" }, action: "edit" },
  { via: "tool", name: "add-campaign-step", params: { campaignId: "camp-1", subject: "Two", body: BODY }, action: "add-step" },
  { via: "page", name: "campaigns.add-step", params: { campaignId: "camp-1", subject: "Two", body: BODY }, action: "add-step" },
  { via: "tool", name: "set-step-html", params: { campaignId: "camp-1", position: 1, html: "<p>Hi</p>" }, action: "set-step-html" },
  { via: "tool", name: "edit-campaign-step", params: { campaignId: "camp-1", position: 1, subject: "Hi there" }, action: "edit-step" },
  { via: "tool", name: "create-ab-variant", params: { campaignId: "camp-1", position: 1, subject: "Hey", body: BODY }, action: "add-variant" },
  { via: "tool", name: "request-campaign-approval", params: { campaignId: "camp-1" }, action: "request-approval" },
  { via: "page", name: "campaigns.request-approval", params: { campaignId: "camp-1" }, action: "request-approval" },
  { via: "tool", name: "enroll-contact", params: { campaignId: "camp-1", contactId: "bob" }, action: "enroll" },
  { via: "page", name: "campaigns.enroll", params: { campaignId: "camp-1", contactId: "bob" }, action: "enroll" },
];

describe("draft edits, ask for approval and enroll into a draft: an agent may in Safe and Auto, not in Off", () => {
  for (const edit of DRAFT_EDITS) {
    for (const mode of MODES) {
      it(`${edit.name} as an agent through the ${edit.via} in ${LABEL[mode]}`, async () => {
        const booted = await bootCampaign(mode, "draft");
        const before = JSON.stringify(booted.store);
        const error = await asAgent(booted.harness, edit.via, edit.name, edit.params);
        if (mode === "off") {
          const what = edit.action === "enroll" ? "enroll people into this draft" : "edit this draft";
          expect(error).toMatch(new RegExp(`An agent may not ${what} in Off mode`));
          expect(JSON.stringify(booted.store)).toBe(before);
          expect(booted.harness.activity).toHaveLength(0);
          return;
        }
        expect(error).toBeNull();
        expect(booted.harness.activity).toHaveLength(1);
        expect(booted.harness.activity[0]).toMatchObject({ entityId: "camp-1", metadata: { actor: "agent:agent-camp", action: edit.action, mode } });
      });
    }
  }

  it("a person edits and enrolls a draft in Off, one entry each", async () => {
    const { harness } = await bootCampaign("off", "draft");
    await harness.performAction("campaigns.add-step", { campaignId: "camp-1", subject: "Two", body: BODY }, asPerson);
    await harness.performAction("campaigns.enroll", { campaignId: "camp-1", contactId: "bob" }, asPerson);
    await harness.performAction("campaigns.request-approval", { campaignId: "camp-1" }, asPerson);
    expect(harness.activity.map((a) => [a.metadata?.actor, a.metadata?.action, a.metadata?.mode])).toEqual([
      ["user:user-peet", "add-step", "off"],
      ["user:user-peet", "enroll", "off"],
      ["user:user-peet", "request-approval", "off"],
    ]);
  });

  it("a page action with no known caller counts as an agent", async () => {
    const booted = await bootCampaign("off", "draft");
    await expect(booted.harness.performAction("campaigns.enroll", { campaignId: "camp-1", contactId: "bob" }, { companyId: CO })).rejects.toThrow(/The caller is not known, so it counts as an agent/);
    expect(booted.store.campaign_enrollments).toHaveLength(0);
  });

  it("creating is an edit too: an agent creates in Safe (tool and page), not in Off; from a template in Safe", async () => {
    const { harness, store } = await boot();
    expect((await harness.executeTool<{ error?: string }>("create-campaign", { name: "Hush", autopilotMode: "off" }, AGENT)).error).toMatch(/An agent may not edit this draft in Off mode/);
    await expect(harness.performAction("campaigns.create-campaign", { name: "Hush", autopilotMode: "off" }, asAgentOnPage)).rejects.toThrow(/An agent may not edit this draft in Off mode/);
    expect(store.campaigns).toHaveLength(0);
    await harness.performAction("campaigns.create-campaign", { name: "Spring" }, asAgentOnPage);
    const template = await harness.executeTool<{ data: { id: string } }>("create-campaign-template", { name: "T", steps: [{ subject: "Hi", body: BODY }] }, AGENT);
    const made = await harness.executeTool<{ data?: { campaignId: string }; error?: string }>("create-campaign-from-template", { templateId: template.data.id, name: "From T" }, AGENT);
    expect(made.error).toBeUndefined();
    expect(store.campaigns!.map((c) => [c.name, c.autopilot_mode ?? "safe"])).toEqual([["Spring", "safe"], ["From T", "safe"]]);
    expect(harness.activity.map((a) => [a.metadata?.actor, a.metadata?.action])).toEqual([["agent:agent-camp", "create"], ["agent:agent-camp", "create"]]);
  });
});

describe("enroll into a launched campaign: a person in every mode (Q4)", () => {
  for (const mode of MODES) {
    for (const via of ["tool", "page"] as const) {
      it(`refuses the agent through the ${via} in ${LABEL[mode]}`, async () => {
        const booted = await bootCampaign(mode, "active");
        const error = await asAgent(booted.harness, via, via === "tool" ? "enroll-contact" : "campaigns.enroll", { campaignId: "camp-1", contactId: "bob" });
        expect(error).toMatch(new RegExp(`An agent may not enroll people into a launched campaign in ${LABEL[mode]} mode\\. Say so on the campaign's task; a person does it on the campaign screen\\.`));
        expect(booted.store.campaign_enrollments).toHaveLength(0);
        expect(booted.harness.activity).toHaveLength(0);
      });
    }
  }

  it("a person enrolls on the page in Safe, one entry", async () => {
    const booted = await bootCampaign("safe", "active");
    await expect(booted.harness.performAction("campaigns.enroll", { campaignId: "camp-1", contactId: "bob" }, asPerson)).resolves.toMatchObject({ contactId: "bob", status: "running" });
    expect(booted.harness.activity).toHaveLength(1);
    expect(booted.harness.activity[0]).toMatchObject({ metadata: { actor: "user:user-peet", action: "enroll", mode: "safe", contactId: "bob", status: "active" } });
  });
});

/** 25 sends per version, B with more replies: suggest-ab-winner says B. */
function abEvents(bReplies: number) {
  const events: Array<Record<string, unknown>> = [];
  for (const arm of ["a", "b"] as const) {
    const replies = arm === "a" ? 5 : bReplies;
    for (let i = 0; i < 25; i += 1) {
      const id = `e-${arm}-${i}`;
      const at = `2026-09-${String(1 + (i % 20)).padStart(2, "0")}T08:00:00.000Z`;
      events.push({ id: `s-${id}`, company_id: CO, campaign_id: "camp-1", enrollment_id: id, step_position: 1, event_type: "sent", variant: arm, source_key: `sent:${id}`, meta: {}, occurred_at: at });
      if (i % Math.max(1, Math.round(25 / replies)) === 0) {
        events.push({ id: `r-${id}`, company_id: CO, campaign_id: "camp-1", enrollment_id: id, step_position: 1, event_type: "reply", variant: arm, source_key: `reply:${id}`, meta: {}, occurred_at: "2026-09-25T08:00:00.000Z" });
      }
    }
  }
  return events;
}

async function bootAb(mode: Mode, bReplies = 13): Promise<Booted> {
  const booted = await bootCampaign(mode, "active");
  booted.store.campaign_step_events = abEvents(bReplies);
  return booted;
}

describe("declare the A/B winner: a person in Off and Safe; in Auto the agent when the significance rule names it", () => {
  for (const mode of ["off", "safe"] as const) {
    for (const via of ["tool", "page"] as const) {
      it(`refuses the agent through the ${via} in ${LABEL[mode]}`, async () => {
        const booted = await bootAb(mode);
        const error = await asAgent(booted.harness, via, via === "tool" ? "declare-ab-winner" : "campaigns.declare-winner", { campaignId: "camp-1", winner: "b" });
        expect(error).toMatch(new RegExp(`An agent may not pick the A/B winner in ${LABEL[mode]} mode\\. Say so on the campaign's task; a person does it on the campaign screen\\.`));
        expect(row(booted).winner_variant ?? null).toBeNull();
        expect(booted.harness.activity).toHaveLength(0);
      });
    }
  }

  for (const via of ["tool", "page"] as const) {
    it(`in Auto the agent declares the suggested version through the ${via}, one entry; another version or no clear verdict is refused`, async () => {
      const booted = await bootAb("full");
      const name = via === "tool" ? "declare-ab-winner" : "campaigns.declare-winner";
      expect(await asAgent(booted.harness, via, name, { campaignId: "camp-1", winner: "a" })).toMatch(/In Auto mode an agent picks the A\/B winner only when suggest-ab-winner names that version/);
      expect(await asAgent(booted.harness, via, name, { campaignId: "camp-1", winner: "b" })).toBeNull();
      expect(row(booted).winner_variant).toBe("b");
      expect(booted.harness.activity).toHaveLength(1);
      expect(booted.harness.activity[0]).toMatchObject({ metadata: { actor: "agent:agent-camp", action: "declare-winner", mode: "full", winner: "b", suggestion: "b" } });

      const even = await bootAb("full", 5);
      expect(await asAgent(even.harness, via, name, { campaignId: "camp-1", winner: "b" })).toMatch(/names that version; now: /);
      expect(row(even).winner_variant ?? null).toBeNull();
    });
  }

  it("a person declares in Off, one entry", async () => {
    const booted = await bootAb("off");
    await booted.harness.performAction("campaigns.declare-winner", { campaignId: "camp-1", winner: "a" }, asPerson);
    expect(row(booted).winner_variant).toBe("a");
    expect(booted.harness.activity.map((a) => [a.metadata?.actor, a.metadata?.action, a.metadata?.mode])).toEqual([["user:user-peet", "declare-winner", "off"]]);
  });
});

const READS: Array<{ via: Via; name: string }> = [
  { via: "tool", name: "campaign-results" },
  { via: "tool", name: "campaign-funnel" },
  { via: "tool", name: "campaign-step-analytics" },
  { via: "tool", name: "campaign-stats" },
  { via: "tool", name: "suggest-ab-winner" },
  { via: "page", name: "campaigns.results" },
  { via: "page", name: "campaigns.stats" },
  { via: "page", name: "campaigns.ab-suggestion" },
];

describe("read results: an agent may in Safe and Auto, not in Off; a read writes no entry", () => {
  for (const read of READS) {
    for (const mode of MODES) {
      it(`${read.name} as an agent through the ${read.via} in ${LABEL[mode]}`, async () => {
        const { harness } = await bootCampaign(mode, "active");
        const error = await asAgent(harness, read.via, read.name, { campaignId: "camp-1" });
        if (mode === "off") expect(error).toMatch(/An agent may not read this campaign's results in Off mode/);
        // Past the gate. (The fake db has no route for some of the results queries; campaign-results.pg.spec runs those against Postgres.)
        else expect(error ?? "").not.toMatch(/may not|counts as an agent/);
        expect(harness.activity).toHaveLength(0);
      });
    }
  }

  it("a person reads results in Off", async () => {
    const { harness } = await bootCampaign("off", "active");
    await expect(harness.performAction("campaigns.stats", { campaignId: "camp-1" }, asPerson)).resolves.toMatchObject({ campaignId: "camp-1" });
    await expect(harness.performAction("campaigns.ab-suggestion", { campaignId: "camp-1" }, asPerson)).resolves.toMatchObject({ verdict: "inconclusive" });
  });
});

describe("stop-direction tools are never refused for an agent, even in Off", () => {
  it("pause, stop an enrollment, suppress an address and a phone", async () => {
    const booted = await bootCampaign("off", "active");
    booted.store.campaign_enrollments!.push(enrollment("e1", "camp-1", "ada"));
    const { harness, store } = booted;
    for (const [name, params] of [
      ["stop-enrollment", { enrollmentId: "e1" }],
      ["suppress-address", { email: "bob@beta.test" }],
      ["suppress-phone", { phone: "+27821234567" }],
      ["pause-campaign", { campaignId: "camp-1" }],
    ] as const) {
      const result = await harness.executeTool<{ error?: string }>(name, params, AGENT);
      expect(result.error, name).toBeUndefined();
    }
    expect(store.campaign_enrollments![0]!.status).toBe("stopped");
    expect(row(booted)).toMatchObject({ status: "paused", paused_by: "agent:agent-camp" });
    expect(actions(harness)).toEqual(["pause"]);

    // The page's Pause, as an agent, in Off.
    const page = await bootCampaign("off", "active");
    await expect(page.harness.performAction("campaigns.pause", { campaignId: "camp-1" }, asAgentOnPage)).resolves.toMatchObject({ status: "paused" });
  });
});
