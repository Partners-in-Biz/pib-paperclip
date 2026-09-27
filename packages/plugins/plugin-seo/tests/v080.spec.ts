/**
 * 0.8.0: routines ship on, the plan hands repurposing to Social (v4), the
 * team report, hire matching without the operating manual, and the tools
 * the owner and the agents rely on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { COMPANY_OS_SKILL_KEY, hireTaskDraft, matchesRole } from "@partnersinbiz/pib-plugin-kit";
import { cockpitSnapshot } from "../src/cockpit.js";
import { NAMESPACE } from "../src/namespace.js";
import { completionBlocker } from "../src/engine/guards.js";
import { createEnv } from "../src/service/common.js";
import { linkSocialPost } from "../src/service/data.js";
import { SEO_MATCH_ROLE, SEO_ROLE } from "../src/service/hire.js";
import { activateShippedRoutines, routinesItem, saveRoutineReport, scheduleTriggersOn, type RoutineView } from "../src/service/routines.js";
import { upgradeTarget, v4Target } from "../src/service/upgrade.js";
import { SKILL_BODY } from "../src/skills.js";
import { PLAYBOOKS } from "../src/templates/playbooks.js";
import { parseRoutine, routineRunning, switchOnRoutine } from "../src/ui/routine-client.js";
import type { SprintTask } from "../src/db.js";

afterEach(() => vi.unstubAllGlobals());

function ctxWith(extra: Record<string, unknown> = {}): PluginContext {
  const state = new Map<string, unknown>();
  return {
    db: { namespace: NAMESPACE, query: async () => [], execute: async () => ({ rowCount: 1 }) },
    state: { get: async (k: { stateKey: string }) => state.get(k.stateKey) ?? null, set: async (k: { stateKey: string }, v: unknown) => void state.set(k.stateKey, v) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...extra,
  } as unknown as PluginContext;
}

describe("SEO routines ship on", () => {
  const view = (extra: Partial<RoutineView> = {}): RoutineView => ({ key: "seo-run-today", title: "Run today's SEO", id: "r1", status: "active", triggersOn: true, ...extra });

  it("the setup item is done only when both routines are active with their schedules on", () => {
    const weekly = view({ key: "seo-weekly-review", title: "Weekly SEO review", id: "r2" });
    expect(routinesItem({ views: [view(), weekly], agentLinked: true })).toMatchObject({ status: "done", required: true });
    expect(routinesItem({ views: [view({ triggersOn: false }), weekly], agentLinked: true })).toMatchObject({ status: "missing", href: "/seo?routines=on" });
    expect(routinesItem({ views: [view({ status: "paused" }), weekly], agentLinked: true })).toMatchObject({ status: "missing", href: "/seo?routines=on" });
    expect(routinesItem({ views: [view({ triggersOn: null }), weekly], agentLinked: true })).toMatchObject({ status: "unknown", href: "/seo" });
    expect(routinesItem({ views: [view({ id: null, status: null }), weekly], agentLinked: false })).toMatchObject({ status: "blocked", blockedBy: ["agent"] });
    expect(routinesItem({ views: [view({ id: null, status: null }), weekly], agentLinked: true })).toMatchObject({ status: "missing", href: "/setup?section=team#team-seo-specialist" });
  });

  it("older paused routines go active unless a person changed them", async () => {
    const routines: Record<string, Record<string, unknown>> = {
      "seo-run-today": { id: "r1", status: "paused", assigneeAgentId: "a1", updatedByUserId: null, updatedByAgentId: null },
      "seo-weekly-review": { id: "r2", status: "paused", assigneeAgentId: "a1", updatedByUserId: "user-1", updatedByAgentId: null },
    };
    const update = vi.fn(async (key: string, _companyId: string, patch: { status: string }) => ({ ...routines[key], ...patch }));
    const ctx = ctxWith({ routines: { managed: { get: vi.fn(async (key: string) => ({ routineId: routines[key]!.id, routine: routines[key] })), update } } });
    expect(await activateShippedRoutines(createEnv(ctx), "co-1")).toEqual(["seo-run-today"]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("seo-run-today", "co-1", { status: "active" });
  });

  it("keeps the page's schedule report only for the plugin's own routines", async () => {
    const ctx = ctxWith({ routines: { managed: { get: vi.fn(async (key: string) => ({ routineId: key === "seo-run-today" ? "r1" : "r2", routine: null })) } } });
    const env = createEnv(ctx, { now: () => new Date("2026-09-27T08:00:00Z") });
    const saved = await saveRoutineReport(env, "co-1", { routineId: "r2", status: "active", triggers: [{ id: "t", kind: "schedule", enabled: true, archived: false }] });
    expect(saved).toMatchObject({ key: "seo-weekly-review", triggersOn: true, checkedAt: "2026-09-27T08:00:00.000Z" });
    await expect(saveRoutineReport(env, "co-1", { routineId: "other", triggers: [] })).rejects.toThrow(/not one of the SEO plugin's routines/);
    expect(scheduleTriggersOn([{ kind: "schedule", enabled: false, archived: true }])).toBe(false);
  });

  it("the page switches a routine on as the board user", async () => {
    let current = { id: "r1", status: "paused", triggers: [{ id: "t1", kind: "schedule", enabled: false, archived: false }] };
    const patches: Array<[string, unknown]> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        patches.push([url, body]);
        current = url.includes("routine-triggers") ? { ...current, triggers: current.triggers.map((t) => ({ ...t, enabled: body.enabled })) } : { ...current, status: body.status };
      }
      return new Response(JSON.stringify(current), { status: 200 });
    });
    const after = await switchOnRoutine(parseRoutine(current)!);
    expect(patches).toEqual([["/api/routines/r1", { status: "active" }], ["/api/routine-triggers/t1", { enabled: true }]]);
    expect(routineRunning(after)).toBe(true);
  });
});

describe("plan v4: Social owns repurposing", () => {
  const task = (extra: Partial<SprintTask> = {}) => ({ templateKey: "w5-repurpose-1", status: "not_started", owner: "agent", taskType: "post-repurpose", autopilotEligible: false, title: "Repurpose post 1 → LinkedIn post + X thread", ...extra }) as SprintTask;

  it("rewrites the open w5/w6 tasks on older sprints (and nothing else)", () => {
    expect(v4Target(task())).toMatchObject({ autopilotEligible: true, title: "Hand post 1 to Social: mark it live, then link its social posts", playbookKey: "w5-repurpose-1" });
    expect(v4Target(task({ status: "done" }))).toBeNull();
    expect(v4Target(task({ templateKey: "w5-post-1" }))).toBeNull();
    expect(upgradeTarget(task(), 3)).toMatchObject({ title: expect.stringContaining("Hand post 1 to Social") });
    expect(upgradeTarget(task(), 4)).toBeNull();
  });

  it("the playbook marks the post live and links Social's drafts; it never drafts social posts", () => {
    const playbook = PLAYBOOKS["w5-repurpose-1"]!;
    const text = playbook.steps.join(" ");
    expect(text).toContain("update-content");
    expect(text).toContain("link-social-post");
    expect(text).toContain("Do not draft social posts yourself");
    expect(playbook.tools).toEqual(["list-content", "update-content", "link-social-post", "partnersinbiz.social:list-posts"]);
    expect(JSON.stringify(PLAYBOOKS)).not.toContain("X thread");
    expect(SKILL_BODY).toContain("The Social agent owns repurposing");
  });

  it("the repurpose task completes only once the posts are linked", () => {
    const facts = { activeKeywords: 9, keywordsWithoutIntent: 0, priorityKeywords: 1, directoriesNotStarted: 0, latestSnapshotDay: null };
    expect(completionBlocker("post-repurpose", { ...facts, liveContentWithSocial: 0 }, "w5-repurpose-1")).toContain("link-social-post");
    expect(completionBlocker("post-repurpose", { ...facts, liveContentWithSocial: 1 }, "w5-repurpose-1")).toBeNull();
    expect(completionBlocker("post-repurpose", { ...facts, liveContentWithSocial: 1 }, "w6-repurpose-2")).toContain("needs 2");
  });

  it("link-social-post takes a known platform only", async () => {
    const ctx = ctxWith({ db: { namespace: NAMESPACE, query: async () => [{ id: "ct-1", company_id: "co-1", sprint_id: "sp-1", title: "Post", type: "post", status: "live", social_post_ids: [] }], execute: async () => ({ rowCount: 1 }) } });
    const env = createEnv(ctx);
    expect(await linkSocialPost(env, "co-1", { contentId: "ct-1", socialPostId: "p-1", platform: "linkedin" })).toEqual({ contentId: "ct-1", socialPosts: ["p-1|linkedin"] });
    await expect(linkSocialPost(env, "co-1", { contentId: "ct-1", socialPostId: "p-2", platform: "myspace" })).rejects.toThrow(/platform must be one of/);
  });
});

describe("team and hiring", () => {
  it("the hire role ends with the operating manual; matching leaves it out", () => {
    expect(SEO_ROLE.skills.at(-1)!.key).toBe(COMPANY_OS_SKILL_KEY);
    expect(SEO_MATCH_ROLE.skills.map((s) => s.slug)).toEqual(["pib-seo-sprint"]);
    // Every PiB agent carries the manual: it must not make a new Social agent look like the SEO hire.
    const socialAgent = { name: "Social Media Manager", adapterConfig: { paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-social/social-publish", COMPANY_OS_SKILL_KEY] } } };
    expect(matchesRole(socialAgent, SEO_MATCH_ROLE)).toBe(false);
    expect(matchesRole({ name: "Sam", adapterConfig: { paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-seo/seo-sprint"] } } }, SEO_MATCH_ROLE)).toBe(true);
    // The hire task still lists the manual.
    expect(hireTaskDraft(SEO_MATCH_ROLE).description).toContain("`pib-company-os`");
    expect(hireTaskDraft(SEO_ROLE).description.match(/pib-company-os` —/g)).toHaveLength(1);
  });

  it("reports the SEO Specialist and its status for the Cockpit's team", async () => {
    const ctx = ctxWith({
      db: { namespace: NAMESPACE, query: async () => [], execute: async () => ({ rowCount: 0 }) },
      state: { get: async (k: { namespace?: string }) => (k.namespace === "pib-hire" ? { agentId: "agent-9" } : null), set: async () => undefined },
      agents: { get: vi.fn(async (id: string) => ({ id, status: "idle", name: "SEO Specialist" })), managed: { get: vi.fn(async () => ({ agentId: null, agent: null })) } },
      config: { get: async () => ({}) },
    });
    const snap = await cockpitSnapshot(ctx, "co-1");
    expect(snap.team).toEqual([{ role: "seo-specialist", agentId: "agent-9", status: "idle" }]);
  });

  it("the skill points at the CRM lookup tools and ask-owner, never a plain comment", () => {
    expect(SKILL_BODY).toContain("partnersinbiz.crm:find-records");
    expect(SKILL_BODY).toContain("partnersinbiz.crm:get-company");
    expect(SKILL_BODY).toContain("partnersinbiz.cockpit:ask-owner");
    expect(SKILL_BODY).not.toContain("block and ask");
  });
});
