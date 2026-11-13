/**
 * The Daily Paper through the real tools, page actions and the 15-minute tick,
 * on a fake host: publish and read back, the copy on the Daily brief issue,
 * the evening task, the compiled edition when none arrived, and the section
 * list changed by an agent.
 */
import { describe, expect, it } from "vitest";
import { ORIGIN } from "../src/constants.js";
import { saveRoles } from "../src/db.js";
import { getEdition, listMonth, paperTick, readPaperSettings, runPaperTool } from "../src/paper.js";
import type { PaperView } from "../src/paper.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { COCKPIT_TOOLS } from "../src/tools.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const A = "cccccccc-0000-4000-8000-000000000001";
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const OWNER = "user-owner";

type Result = { content: string; data: Record<string, any>; error?: string };

async function setup(at = "2026-11-13T05:00:00.000Z", options: { operator?: boolean } = {}) {
  const fake = fakeCtx({ savedConfigs: { [A]: {} }, prefixes: { [A]: "PAR" }, agents: [{ id: OP, companyId: A, name: "Thandi", status: "active" }] });
  const clock = fixedClock(at);
  const env = createEnv(fake.ctx, clock.now);
  registerCockpit(fake.ctx, env);
  await saveRoles(fake.ctx, { companyId: A, operatorAgentId: options.operator === false ? null : OP, reviewerAgentId: null, ownerUserId: OWNER, reviewOutward: false, createdAt: at, updatedAt: at, updatedBy: OWNER });
  const tool = (name: string, params: Record<string, unknown>) => runPaperTool(env, name, params, { companyId: A, agentId: OP, runId: "run-1", projectId: "" }) as Promise<Result>;
  const action = <T,>(name: string, params: Record<string, unknown> = {}, actor: Record<string, unknown> = { type: "user", userId: OWNER }) => fake.actions.get(name)!(params, { companyId: A, actor }) as Promise<T>;
  const tasks = () => [...fake.issues.values()].filter((i) => i.originKind === ORIGIN.paper);
  return { ...fake, env, clock, tool, action, tasks };
}

const EDITION = {
  edition: "morning",
  headline: "Queue at 65, oldest item waits 12 days",
  standfirst: "Cash is R33,313, revenue this month is R7,500 and nothing is overdue.",
  figures: [{ label: "Cash", value: "R33,313" }],
  sections: [
    { id: "needs-you", title: "Needs you", body: "- Approve the [Tvisha invoice](/PAR/issues/PAR-1) for R6,250." },
    { id: "risks", title: "Risks", body: "Your Mac has been unreachable since yesterday." },
  ],
};

describe("the paper tools are declared", () => {
  it("as paper-assignment, paper-publish and paper-settings", () => {
    expect(COCKPIT_TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(["paper-assignment", "paper-publish", "paper-settings"]));
  });
});

describe("paper-assignment", () => {
  it("gives the owner's sections in order, the rules and the last editions", async () => {
    const s = await setup();
    const first = await s.tool("paper-assignment", { edition: "morning" });
    expect(first.error).toBeUndefined();
    expect(first.content).toContain("Morning edition of The Company");
    expect(first.data).toMatchObject({ edition: "morning", date: "2026-11-13", dateLabel: "Friday, 13 November 2026", alreadyPublished: false, linkPrefix: "/PAR", previous: [], publishWith: "partnersinbiz.cockpit:paper-publish" });
    // Tech news is listed in the editor but off, so the writer is not asked for it.
    expect(first.data.sections.map((x: { id: string }) => x.id)).toEqual(["needs-you", "money", "clients", "sales-marketing", "risks", "team", "today", "good-news"]);
    expect(first.data.rules.length).toBeGreaterThan(4);

    await s.tool("paper-publish", EDITION);
    const evening = await s.tool("paper-assignment", { edition: "evening" });
    expect(evening.data.previous).toHaveLength(1);
    expect(evening.data.previous[0]).toMatchObject({ date: "2026-11-13", edition: "morning", headline: EDITION.headline });
    expect(evening.data.previous[0].text).toContain("Your Mac has been unreachable");
    expect((await s.tool("paper-assignment", { edition: "morning" })).content).toContain("Already published today");
    expect((await s.tool("paper-assignment", { edition: "noon" })).error).toContain("edition must be");
    // Left out: the edition of this part of the day (05:00 UTC is 07:00 SAST).
    expect((await s.tool("paper-assignment", {})).data.edition).toBe("morning");
    s.clock.set("2026-11-13T15:00:00.000Z");
    expect((await s.tool("paper-assignment", {})).data.edition).toBe("evening");
  });
});

describe("paper-publish", () => {
  it("stores the edition, lists it, posts the copy on the Daily brief issue and says what is missing", async () => {
    const s = await setup();
    const r = await s.tool("paper-publish", EDITION);
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("Published the morning edition for 2026-11-13 (No. 1,");
    expect(r.content).toContain("Sections the owner asked for that are not in it: Money, Client desk");
    expect(r.data).toMatchObject({ date: "2026-11-13", edition: "morning", number: 1, replaced: false, href: "/PAR/cockpit?tab=paper&date=2026-11-13&edition=morning" });

    const doc = await getEdition(s.env, A, "2026-11-13", "morning");
    expect(doc).toMatchObject({ number: 1, name: "The Company cccccccc-0000-4000-8000-000000000001 Daily", author: "Thandi", source: "agent", revision: 1 });
    expect(doc!.sections.map((x) => x.id)).toEqual(["needs-you", "risks"]);
    expect((await listMonth(s.env, A, "2026-11")).map((e) => e.headline)).toEqual([EDITION.headline]);

    const brief = [...s.issues.values()].find((i) => i.originKind === ORIGIN.brief)!;
    expect(brief.id).toBe(r.data.briefIssueId);
    const copy = s.comments.find((c) => c.issueId === brief.id)!;
    expect(copy.authorAgentId).toBe(OP);
    expect(copy.body).toContain(`## ${EDITION.headline}`);
    expect(copy.body).toContain("[Read it as a paper](/PAR/cockpit?tab=paper&date=2026-11-13&edition=morning)");
  });

  it("replaces the same day's edition and keeps its number; the next edition counts on", async () => {
    const s = await setup();
    await s.tool("paper-publish", EDITION);
    const again = await s.tool("paper-publish", { ...EDITION, headline: "Rewritten" });
    expect(again.data).toMatchObject({ number: 1, replaced: true });
    expect((await getEdition(s.env, A, "2026-11-13", "morning"))!).toMatchObject({ headline: "Rewritten", revision: 2 });
    const evening = await s.tool("paper-publish", { ...EDITION, edition: "evening", headline: "Evening" });
    expect(evening.data.number).toBe(2);
    expect((await listMonth(s.env, A, "2026-11")).map((e) => e.headline)).toEqual(["Evening", "Rewritten"]);
  });

  it("refuses a bad edition with the reason", async () => {
    const s = await setup();
    expect((await s.tool("paper-publish", { ...EDITION, headline: "" })).error).toContain("headline is required");
    expect((await s.tool("paper-publish", { ...EDITION, sections: [] })).error).toContain("sections is required");
    expect(await getEdition(s.env, A, "2026-11-13", "morning")).toBeNull();
  });
});

describe("paper-settings", () => {
  it("adds, updates, moves and removes a section on the owner's word", async () => {
    const s = await setup();
    const got = await s.tool("paper-settings", {});
    expect(got.data.presets.map((p: { preset: string }) => p.preset)).toContain("on-x");

    const added = await s.tool("paper-settings", { action: "add", edition: "evening", title: "On X: @levelsio", instruction: "What @levelsio posted since the last edition.", source: "web" });
    expect(added.error).toBeUndefined();
    const ids = () => readPaperSettings(s.env, A).then((v) => v.editions.evening.sections.map((x) => x.id));
    expect((await ids()).at(-1)).toBe("on-x-levelsio");

    await s.tool("paper-settings", { action: "move", edition: "evening", id: "on-x-levelsio", position: 1 });
    expect((await ids())[0]).toBe("on-x-levelsio");
    await s.tool("paper-settings", { action: "update", edition: "evening", id: "tech-news", enabled: true });
    expect((await readPaperSettings(s.env, A)).editions.evening.sections.find((x) => x.id === "tech-news")!.enabled).toBe(true);
    await s.tool("paper-settings", { action: "remove", edition: "evening", id: "clients" });
    expect(await ids()).not.toContain("clients");
    await s.tool("paper-settings", { action: "set", edition: "evening", time: "18:30", days: "weekdays", note: "Keep it short." });
    expect((await readPaperSettings(s.env, A)).editions.evening).toMatchObject({ time: "18:30", days: "weekdays", note: "Keep it short." });
    expect((await readPaperSettings(s.env, A)).updatedBy).toBe(`agent:${OP}`);

    expect((await s.tool("paper-settings", { action: "remove", edition: "evening", id: "nope" })).error).toContain("No section \"nope\"");
    expect((await s.tool("paper-settings", { action: "add", edition: "morning", title: "Bare" })).error).toContain("needs an instruction");
    // The preset fills what is left out.
    expect((await s.tool("paper-settings", { action: "add", edition: "morning", preset: "business-news" })).error).toBeUndefined();
    expect((await readPaperSettings(s.env, A)).editions.morning.sections.at(-1)).toMatchObject({ id: "business-news", source: "web" });
  });
});

describe("the tick", () => {
  it("opens the evening task for the Operator at its time, once, and publishing closes it", async () => {
    const s = await setup("2026-11-13T14:45:00.000Z");
    expect(await paperTick(s.env)).toMatchObject({ requested: 0, compiled: 0 });
    s.clock.set("2026-11-13T15:00:00.000Z");
    expect(await paperTick(s.env)).toMatchObject({ requested: 1 });
    const [task] = s.tasks();
    expect(task).toMatchObject({ title: "Evening paper, Fri 13 Nov", assigneeAgentId: OP, status: "todo", priority: "high" });
    expect(task!.description).toContain("partnersinbiz.cockpit:paper-assignment");
    expect(task!.description).toContain("windowHours 12");
    expect(s.wakeups).toContain(task!.id);
    s.clock.set("2026-11-13T15:15:00.000Z");
    expect(await paperTick(s.env)).toMatchObject({ requested: 0 });
    expect(s.tasks()).toHaveLength(1);

    const view = await s.action<PaperView>("paper.load");
    expect(view.writing).toEqual({ evening: task!.id });

    const r = await s.tool("paper-publish", { ...EDITION, edition: "evening" });
    expect(r.data.closedTaskId).toBe(task!.id);
    expect(s.issues.get(task!.id)!.status).toBe("done");
    s.clock.set("2026-11-13T17:30:00.000Z");
    expect(await paperTick(s.env)).toMatchObject({ requested: 0, compiled: 0 });
  });

  it("compiles the edition itself two hours after its time when none arrived, and never over a written one", async () => {
    // The paper was switched on the day before, so today's morning edition is expected.
    const s = await setup("2026-11-12T12:00:00.000Z");
    expect(await paperTick(s.env)).toMatchObject({ compiled: 0 });
    s.clock.set("2026-11-13T06:45:00.000Z");
    expect(await paperTick(s.env)).toMatchObject({ compiled: 0 });
    s.clock.set("2026-11-13T07:00:00.000Z");
    expect(await paperTick(s.env)).toMatchObject({ compiled: 1 });
    const doc = (await getEdition(s.env, A, "2026-11-13", "morning"))!;
    expect(doc).toMatchObject({ source: "auto", author: null, number: 1 });
    expect(doc.standfirst).toContain("the written edition did not arrive");
    expect(doc.sections.map((x) => x.id)).toContain("needs-you");
    s.clock.set("2026-11-13T07:15:00.000Z");
    expect(await paperTick(s.env)).toMatchObject({ compiled: 0 });

    // The Operator's late edition replaces the compiled one.
    await s.tool("paper-publish", EDITION);
    expect((await getEdition(s.env, A, "2026-11-13", "morning"))!).toMatchObject({ source: "agent", number: 1, revision: 2 });
    await expect(s.action("paper.compile-now", { edition: "morning" })).rejects.toThrow("A written edition is already published");
  });

  it("does nothing for an edition that is switched off", async () => {
    const s = await setup("2026-11-12T12:00:00.000Z");
    await paperTick(s.env);
    s.clock.set("2026-11-13T17:30:00.000Z");
    for (const edition of ["morning", "evening"]) await s.tool("paper-settings", { action: "set", edition, enabled: false });
    expect(await paperTick(s.env)).toEqual({ requested: 0, compiled: 0, failed: 0 });
    expect(s.tasks()).toHaveLength(0);
  });
});

describe("the page actions", () => {
  it("load the newest edition, or the one asked for, with the archive", async () => {
    const s = await setup();
    const empty = await s.action<PaperView>("paper.load");
    expect(empty).toMatchObject({ edition: null, recent: [], months: [], today: "2026-11-13", operator: { id: OP, name: "Thandi" } });
    await s.tool("paper-publish", { ...EDITION, date: "2026-11-12", headline: "Yesterday" });
    await s.tool("paper-publish", EDITION);
    const latest = await s.action<PaperView>("paper.load");
    expect(latest.edition!.headline).toBe(EDITION.headline);
    expect(latest.recent.map((e) => e.date)).toEqual(["2026-11-13", "2026-11-12"]);
    expect(latest.months).toEqual(["2026-11"]);
    expect((await s.action<PaperView>("paper.load", { date: "2026-11-12" })).edition!.headline).toBe("Yesterday");
    expect((await s.action<PaperView>("paper.load", { date: "2026-11-01" })).edition).toBeNull();
    expect((await s.action<{ entries: unknown[] }>("paper.month", { month: "2026-11" })).entries).toHaveLength(2);
  });

  it("save the owner's list, for a board user only", async () => {
    const s = await setup();
    const settings = await readPaperSettings(s.env, A);
    settings.editions.morning.sections.push({ id: "", title: "Weather in Ballito", instruction: "Rain or shine today.", source: "web", enabled: true });
    settings.name = "The PiB Post";
    const saved = await s.action<{ settings: typeof settings }>("paper.save", { settings });
    expect(saved.settings.name).toBe("The PiB Post");
    expect(saved.settings.editions.morning.sections.at(-1)).toMatchObject({ id: "weather-in-ballito", source: "web" });
    expect(saved.settings.updatedBy).toBe(`user:${OWNER}`);
    await expect(s.action("paper.save", { settings }, { type: "agent", agentId: OP })).rejects.toThrow("Only a board user");
    await expect(s.action("paper.save", { settings: { ...settings, editions: { ...settings.editions, morning: { ...settings.editions.morning, sections: [] } } } })).rejects.toThrow("needs at least one section");
    const reset = await s.action<{ settings: typeof settings }>("paper.reset");
    expect(reset.settings.name).toBe("The PiB Post");
    expect(reset.settings.editions.morning.sections.map((x) => x.id)).not.toContain("weather-in-ballito");
  });

  it("ask the Operator for an edition now, and say when there is none", async () => {
    const s = await setup();
    const r = await s.action<{ requested: boolean; created: boolean; issueId: string }>("paper.write-now", { edition: "morning" });
    expect(r).toMatchObject({ requested: true, created: true });
    expect(s.tasks()[0]).toMatchObject({ title: "Morning paper, Fri 13 Nov", assigneeAgentId: OP });
    // Asking again wakes the same task.
    const again = await s.action<{ created: boolean; issueId: string }>("paper.write-now", { edition: "morning" });
    expect(again).toMatchObject({ created: false, issueId: r.issueId });
    expect(s.wakeups.filter((id) => id === r.issueId).length).toBe(2);

    const none = await setup("2026-11-13T05:00:00.000Z", { operator: false });
    expect(await none.action("paper.write-now", { edition: "evening" })).toEqual({ requested: false, reason: "no-operator" });
  });
});
