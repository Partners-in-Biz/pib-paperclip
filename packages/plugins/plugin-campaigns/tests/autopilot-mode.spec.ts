/**
 * Stage 3b, PR 2 (PAR-9234; plan PAR-9192 rev. 2, 5.2): the campaign mode, who paused it, and one activity entry per
 * mutation. Every path runs as an agent through the tool and through the page action, and as a person.
 */
import { describe, expect, it } from "vitest";
import { CAMPAIGNS_ACCESS_TABLE } from "../src/access-table.js";
import { boot, campaign, CO } from "./helpers/harness.js";

const AGENT = { companyId: CO, agentId: "agent-camp" };
const asPerson = { companyId: CO, actor: { type: "user" as const, userId: "user-peet", companyId: CO } };
const asAgentOnPage = { companyId: CO, actor: { type: "agent" as const, agentId: "agent-camp", companyId: CO } };

async function bootWith(extra: Record<string, unknown> = {}) {
  const booted = await boot();
  // A row as the previous version left it: no autopilot_mode, no paused_by.
  booted.store.campaigns!.push(campaign("camp-1", extra));
  return booted;
}

const row = (store: Awaited<ReturnType<typeof boot>>["store"], id = "camp-1") => store.campaigns!.find((c) => c.id === id)!;

describe("campaign mode (autopilot_mode)", () => {
  it("changing the mode is a decision: the tool and the page action need approve", () => {
    for (const key of ["tool:set-campaign-mode", "campaigns.set-mode"]) expect(CAMPAIGNS_ACCESS_TABLE[key], key).toEqual({ resource: "campaigns.campaigns", action: "approve" });
  });

  it("an existing campaign reads Safe", async () => {
    const { harness } = await bootWith();
    const listed = await harness.executeTool<{ data: { campaigns: Array<Record<string, unknown>> } }>("list-campaigns", {}, AGENT);
    expect(listed.data.campaigns.find((c) => c.id === "camp-1")).toMatchObject({ autopilotMode: "safe", pausedBy: null });
  });

  it("a new campaign starts in Safe; an agent may create it in Off but never in Auto, and nobody creates in Auto yet", async () => {
    const { harness, store } = await boot();
    const made = await harness.executeTool<{ data: { id: string; autopilotMode: string } }>("create-campaign", { name: "Spring" }, AGENT);
    expect(made.data.autopilotMode).toBe("safe");
    expect(row(store, made.data.id).autopilot_mode).toBe("safe");
    const off = await harness.executeTool<{ data: { id: string } }>("create-campaign", { name: "Quiet", autopilotMode: "off" }, AGENT);
    expect(row(store, off.data.id).autopilot_mode).toBe("off");
    const auto = await harness.executeTool<{ error?: string }>("create-campaign", { name: "Loud", autopilotMode: "full" }, AGENT);
    expect(auto.error).toMatch(/agent cannot create a campaign in Auto/);
    await expect(harness.performAction("campaigns.create-campaign", { name: "Loud", autopilotMode: "full" }, asAgentOnPage)).rejects.toThrow(/agent cannot create a campaign in Auto/);
    await expect(harness.performAction("campaigns.create-campaign", { name: "Loud", autopilotMode: "full" }, asPerson)).rejects.toThrow(/Auto mode arrives in a later release/);
    expect(store.campaigns!.map((c) => c.name)).toEqual(["Spring", "Quiet"]);
    expect(harness.activity).toHaveLength(0);
  });

  it("an agent lowers Safe to Off through the tool, with one activity entry, and cannot raise it again", async () => {
    const { harness, store } = await bootWith();
    const lowered = await harness.executeTool<{ data: Record<string, unknown> }>("set-campaign-mode", { campaignId: "camp-1", mode: "off" }, AGENT);
    expect(lowered.data).toEqual({ campaignId: "camp-1", mode: "off", previousMode: "safe", changed: true });
    expect(row(store).autopilot_mode).toBe("off");
    expect(harness.activity).toHaveLength(1);
    expect(harness.activity[0]).toMatchObject({
      entityType: "plugin_campaigns_campaign",
      entityId: "camp-1",
      metadata: { actor: "agent:agent-camp", action: "set-mode", campaignId: "camp-1", mode: "off", from: "safe" },
    });
    expect(harness.activity[0]!.message).toBe('agent:agent-camp set the mode to Off (was Safe) on campaign "camp-1" (mode Off)');

    const raised = await harness.executeTool<{ error?: string }>("set-campaign-mode", { campaignId: "camp-1", mode: "safe" }, AGENT);
    expect(raised.error).toMatch(/can lower a campaign's mode but not raise it \(Off to Safe\)/);
    await expect(harness.performAction("campaigns.set-mode", { campaignId: "camp-1", mode: "safe" }, asAgentOnPage)).rejects.toThrow(/not raise it/);
    expect(row(store).autopilot_mode).toBe("off");
    expect(harness.activity).toHaveLength(1);
  });

  it("an agent cannot choose Auto, through the tool or the page", async () => {
    const { harness, store } = await bootWith();
    expect((await harness.executeTool<{ error?: string }>("set-campaign-mode", { campaignId: "camp-1", mode: "full" }, AGENT)).error).toMatch(/not raise it \(Safe to Auto\)/);
    await expect(harness.performAction("campaigns.set-mode", { campaignId: "camp-1", mode: "full" }, asAgentOnPage)).rejects.toThrow(/not raise it/);
    expect(row(store).autopilot_mode).toBeUndefined();
    expect(harness.activity).toHaveLength(0);
  });

  it("a person sets Off and Safe on the page; Auto is refused with a sentence that it comes later", async () => {
    const { harness, store } = await bootWith({ autopilot_mode: "off" });
    expect(await harness.performAction("campaigns.set-mode", { campaignId: "camp-1", mode: "safe" }, asPerson)).toMatchObject({ mode: "safe", previousMode: "off", changed: true });
    expect(row(store).autopilot_mode).toBe("safe");
    expect(await harness.performAction("campaigns.set-mode", { campaignId: "camp-1", mode: "off" }, asPerson)).toMatchObject({ mode: "off", changed: true });
    await expect(harness.performAction("campaigns.set-mode", { campaignId: "camp-1", mode: "full" }, asPerson)).rejects.toThrow(/Auto mode arrives in a later release/);
    expect(row(store).autopilot_mode).toBe("off");
    expect(harness.activity.map((a) => [a.metadata?.actor, a.metadata?.mode])).toEqual([["user:user-peet", "safe"], ["user:user-peet", "off"]]);
  });

  it("the same mode again changes nothing and writes no entry; an unknown mode or caller is refused", async () => {
    const { harness } = await bootWith();
    expect(await harness.performAction("campaigns.set-mode", { campaignId: "camp-1", mode: "safe" }, asPerson)).toMatchObject({ changed: false });
    await expect(harness.performAction("campaigns.set-mode", { campaignId: "camp-1", mode: "turbo" }, asPerson)).rejects.toThrow(/mode must be off, safe or full/);
    await expect(harness.performAction("campaigns.set-mode", { campaignId: "camp-1", mode: "off" }, { companyId: CO })).rejects.toThrow(/signed-in person or an agent/);
    expect(harness.activity).toHaveLength(0);
  });
});

describe("paused_by", () => {
  it("a pause by an agent through the tool records the agent and writes one entry; a resume clears it", async () => {
    const { harness, store } = await bootWith();
    const paused = await harness.executeTool<{ data: Record<string, unknown> }>("pause-campaign", { campaignId: "camp-1" }, AGENT);
    expect(paused.data).toEqual({ campaignId: "camp-1", status: "paused", pausedBy: "agent:agent-camp" });
    expect(row(store)).toMatchObject({ status: "paused", paused_by: "agent:agent-camp" });
    expect(harness.activity).toHaveLength(1);
    expect(harness.activity[0]).toMatchObject({ entityId: "camp-1", metadata: { actor: "agent:agent-camp", action: "pause", mode: "safe", from: "active" } });

    await harness.performAction("campaigns.resume", { campaignId: "camp-1" }, asPerson);
    expect(row(store)).toMatchObject({ status: "active", paused_by: null });
  });

  it("a pause by a person on the page records the person; an agent on the page is recorded as the agent", async () => {
    const { harness, store } = await bootWith();
    await harness.performAction("campaigns.pause", { campaignId: "camp-1" }, asPerson);
    expect(row(store)).toMatchObject({ status: "paused", paused_by: "user:user-peet" });
    expect(harness.activity.map((a) => a.metadata?.actor)).toEqual(["user:user-peet"]);

    row(store).status = "active";
    await harness.performAction("campaigns.pause", { campaignId: "camp-1" }, asAgentOnPage);
    expect(row(store).paused_by).toBe("agent:agent-camp");
    expect(harness.activity).toHaveLength(2);
  });

  it("completing a paused campaign keeps who paused it", async () => {
    const { harness, store } = await bootWith({ status: "paused", paused_by: "user:user-peet" });
    await harness.performAction("campaigns.complete", { campaignId: "camp-1" }, asPerson);
    expect(row(store)).toMatchObject({ status: "completed", paused_by: "user:user-peet" });
  });

  it("a failed activity write does not undo the pause", async () => {
    const { harness, store } = await bootWith();
    harness.ctx.activity.log = async () => {
      throw new Error("activity down");
    };
    await harness.performAction("campaigns.pause", { campaignId: "camp-1" }, asPerson);
    expect(row(store)).toMatchObject({ status: "paused", paused_by: "user:user-peet" });
    expect(harness.logs.some((entry) => entry.message === "Could not write the campaign activity entry")).toBe(true);
  });
});
