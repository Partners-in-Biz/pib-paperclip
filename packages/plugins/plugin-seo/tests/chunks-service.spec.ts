import { describe, expect, it } from "vitest";
import type { SafeFetchResult } from "@partnersinbiz/pib-plugin-kit";
import type { SiteFetcher } from "../src/checks/site.js";
import * as db from "../src/db.js";
import { cancelGroups, groupBlockerFor, groupViews, healChunks, onChunkIssueUpdated, openIdleGroups, openNextGroup, planSplit, splitOnStart, splitTaskTool } from "../src/service/chunks.js";
import { companyInfo } from "../src/service/common.js";
import { checkTaskClose } from "../src/service/done-checks.js";
import { sprintToday } from "../src/service/sprints.js";
import { completeTask, createTaskIssue, skipTask, startTask } from "../src/service/tasks.js";
import { reply } from "./helpers/geo-site.js";
import { memTables } from "./helpers/mem-db.js";
import { resolveNeedsYou } from "../src/service/needs-you.js";
import { groupBlockedItem } from "../src/engine/chunks.js";
import { executed, needsYouRoutes, savedNeedsYouItems, seoHost, sprintRoutes, taskRow, type Row } from "./helpers/seo-host.js";

const agent = { kind: "agent" as const, agentId: "agent-1", runId: "run-1", responsibleUserId: null };
const person = { kind: "user" as const, userId: "user-1" };

const HOME = "https://acme.co.za/";
const pagesOf = (n: number) => Array.from({ length: n }, (_, i) => `https://acme.co.za/page-${i + 1}`);
/** A site whose sitemap lists `n` pages, the home page among them (null: no sitemap at all). */
function siteWith(n: number | null): { fetcher: SiteFetcher; calls: string[] } {
  const calls: string[] = [];
  const urls = [HOME, ...pagesOf(Math.max(0, (n ?? 0) - 1))];
  const fetcher: SiteFetcher = async (url): Promise<SafeFetchResult> => {
    calls.push(url);
    if (url.endsWith("/robots.txt")) return reply(200, "Sitemap: https://acme.co.za/sitemap.xml", {}, url);
    if (url.endsWith("/sitemap.xml") && n != null) return reply(200, `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`, {}, url);
    return reply(404);
  };
  return { fetcher, calls };
}

const altTask = (extra: Row = {}) => taskRow({ id: "t-1", template_key: "w1-alt-text", week: 1, phase: 1, due_day: 1, task_type: "alt-text-audit", title: "Describe every image (alt text)", playbook_key: "w1-alt-text", ...extra });
const chunkRow = (seq: number, status: string, extra: Row = {}): Row => ({
  id: `chunk-${seq}`, company_id: "co-1", sprint_id: "sp-1", task_id: "t-1", parent_issue_id: "issue-1", seq, total: 6, label: `pages ${seq}`, urls: pagesOf(9), status,
  issue_id: status === "queued" ? null : `grp-${seq}`, issue_identifier: status === "queued" ? null : `PIB-20${seq}`, opened_at: status === "queued" ? null : "2026-10-03T07:00:00Z", done_at: null, ...extra,
});

/** A host with the two tables in memory, the sprint, and the issues API reporting the statuses the test gives. */
function host(input: { tasks?: Row[]; chunks?: Row[]; site?: SiteFetcher; issueStatus?: Record<string, string> } = {}) {
  const mem = memTables({ sprint_tasks: input.tasks ?? [], task_chunks: input.chunks ?? [] });
  const h = seoHost({ routes: [...mem.routes, ...sprintRoutes], site: input.site ?? siteWith(null).fetcher });
  mem.attach(h);
  h.ctx.issues.get = (async (id: string) => ({ id, status: input.issueStatus?.[id] ?? "todo", identifier: `PIB-${id}` })) as never;
  return { ...h, mem };
}
type Host = ReturnType<typeof host>;

const taskOf = async (h: Host, id = "t-1") => (await db.getTask(h.env.ctx.db, "co-1", id))!;

async function openNew(h: Host) {
  const info = await companyInfo(h.env, "co-1");
  const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
  // A task that has no issue yet: the one the daily run is about to open.
  const task = { ...(await taskOf(h)), issueId: null };
  return createTaskIssue(h.env, { info, sprint, day: 32, agent: { id: "agent-1", status: "idle" }, projectId: "proj-1" }, task);
}

describe("opening a site-wide task on a big site", () => {
  it("splits it into groups, opens the first for the agent and leaves the parent unwoken", async () => {
    const h = host({ tasks: [altTask()], site: siteWith(57).fetcher });
    const parentId = (await openNew(h))!;
    const [parent, first] = h.created;
    expect(parentId).toBe(parent!.id);
    expect(parent!.input).toMatchObject({ originKind: "plugin:partnersinbiz.seo:task", originId: "seo:task:t-1", projectId: "proj-site", assigneeAgentId: "agent-1", parentId: "root-1" });
    expect(String(parent!.input.description)).toContain("## This task is split into 6 page groups");
    expect(String(parent!.input.description)).toContain("The site has 57 pages");
    // The coordinator is not woken (a wake would have the agent work the whole site in one run); the first group is.
    expect(first!.input).toMatchObject({ originKind: "plugin:partnersinbiz.seo:chunk", parentId, assigneeAgentId: "agent-1", projectId: "proj-site" });
    expect(first!.input.originId).toBe(`seo:chunk:${h.mem.chunks[0]!.id}`);
    expect(String(first!.input.title)).toContain("group 1 of 6");
    expect(h.wakeups).toEqual([first!.id]);
    expect(h.created).toHaveLength(2);
    // Six rows under the parent, in order, one open with its issue, five queued.
    expect(h.mem.chunks.map((c) => [c.seq, c.status])).toEqual([[1, "open"], [2, "queued"], [3, "queued"], [4, "queued"], [5, "queued"], [6, "queued"]]);
    expect(h.mem.chunks.every((c) => c.parent_issue_id === parentId && c.total === 6)).toBe(true);
    expect(h.mem.chunks.map((c) => c.label)).toEqual(["pages 1–10 of 57", "pages 11–20 of 57", "pages 21–30 of 57", "pages 31–39 of 57", "pages 40–48 of 57", "pages 49–57 of 57"]);
    expect(h.mem.chunks[0]).toMatchObject({ issue_id: first!.id, issue_identifier: `PIB-${first!.id}` });
    // The task carries its issue, which is what the group issues hang under.
    expect(h.mem.tasks[0]).toMatchObject({ issue_id: parentId, issue_status: "todo" });
    expect(h.mem.chunks.flatMap((c) => c.urls as string[])).toHaveLength(57);
    expect(executed(h, /INSERT INTO plugin_seo_8099f8879a\.task_chunks/)[0]!.sql).toContain("ON CONFLICT (parent_issue_id, seq) DO NOTHING");
    // The decision is remembered on the task so start-task does not read the sitemap again.
    expect(h.mem.tasks[0]!.evidence).toMatchObject({ split: { checkedOn: "2026-10-03", pages: 57, size: 10, groups: 6 } });
  });

  it("opens a small site's task exactly as before: one issue, the agent woken", async () => {
    const h = host({ tasks: [altTask()], site: siteWith(8).fetcher });
    await openNew(h);
    expect(h.created).toHaveLength(1);
    expect(String(h.created[0]!.input.description)).not.toContain("This task is split");
    expect(h.wakeups).toEqual([h.created[0]!.id]);
    expect(h.mem.chunks).toHaveLength(0);
    expect(h.mem.tasks[0]!.evidence).toMatchObject({ split: { pages: 8, groups: 0 } });
  });

  it("never fails the task because the sitemap could not be read", async () => {
    const broken: SiteFetcher = async () => {
      throw new Error("connection refused");
    };
    const h = host({ tasks: [altTask()], site: broken });
    expect(await openNew(h)).toBe(h.created[0]!.id);
    expect(h.created).toHaveLength(1);
    expect(h.wakeups).toEqual([h.created[0]!.id]);
  });

  it("leaves tasks that are not site-wide, optimizations and tasks with groups already alone", async () => {
    const calls = siteWith(57);
    const page = host({ tasks: [altTask({ task_type: "page-write", template_key: "w3-homepage" })], site: calls.fetcher });
    await openNew(page);
    expect(page.created).toHaveLength(1);
    expect(calls.calls).toHaveLength(0); // no sitemap read for a task that cannot be split
    const opt = host({ tasks: [altTask({ source: "optimization", template_key: null })], site: calls.fetcher });
    await openNew(opt);
    expect(opt.created).toHaveLength(1);
    const split = host({ tasks: [altTask()], chunks: [chunkRow(1, "open"), chunkRow(2, "queued")], site: calls.fetcher });
    await openNew(split);
    expect(split.created).toHaveLength(1);
    expect(split.mem.chunks).toHaveLength(2);
  });

  it("keeps the first group queued when the host refuses its issue, and the next sweep opens it (the parent is not woken to do the whole site)", async () => {
    const h = host({ tasks: [altTask()], site: siteWith(57).fetcher });
    const original = h.ctx.issues.create as unknown as (input: Row) => Promise<unknown>;
    let calls = 0;
    h.ctx.issues.create = (async (input: Row) => {
      calls += 1;
      if (calls > 1) throw new Error("host refused the child issue");
      return original(input);
    }) as never;
    const parentId = (await openNew(h))!;
    expect(h.mem.chunks.map((c) => c.status)).toEqual(Array(6).fill("queued"));
    expect(h.wakeups).toEqual([]);
    // The 5-minute job (and the hourly heal) look for a task with groups queued and none open.
    h.ctx.issues.create = original as never;
    expect(await openIdleGroups(h.env, "co-1")).toBe(1);
    expect(h.mem.chunks[0]).toMatchObject({ status: "open", parent_issue_id: parentId });
    expect(h.wakeups).toEqual([h.created.at(-1)!.id]);
  });

  it("wakes the agent on the task after all when the groups cannot even be recorded", async () => {
    const h = host({ tasks: [altTask()], site: siteWith(57).fetcher });
    const execute = h.ctx.db.execute.bind(h.ctx.db);
    h.ctx.db.execute = (async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO plugin_seo_8099f8879a\.task_chunks/.test(sql)) throw new Error("database busy");
      return execute(sql, params);
    }) as never;
    const parentId = (await openNew(h))!;
    expect(h.wakeups).toEqual([parentId]);
    expect(h.mem.chunks).toHaveLength(0);
  });
});

describe("opening the next group", () => {
  it("opens one group at a time and only the first queued one", async () => {
    const h = host({ tasks: [altTask({ issue_id: "issue-1", status: "in_progress" })], chunks: [chunkRow(1, "done"), chunkRow(2, "queued"), chunkRow(3, "queued")] });
    expect(await openNextGroup(h.env, "co-1", "t-1")).toMatchObject({ seq: 2 });
    expect(h.created).toHaveLength(1);
    expect(String(h.created[0]!.input.title)).toContain("group 2 of 6");
    expect(String(h.created[0]!.input.description)).toContain("Branch `seo/w1-alt-text-g2`");
    // The group is open now, which holds the queue.
    expect(await openNextGroup(h.env, "co-1", "t-1")).toBeNull();
    expect(h.created).toHaveLength(1);
    expect(h.mem.chunks.map((c) => c.status)).toEqual(["done", "open", "queued"]);
    // Nothing queued: nothing to open.
    expect(await openNextGroup(host({ tasks: [altTask({ issue_id: "issue-1" })], chunks: [chunkRow(1, "done")] }).env, "co-1", "t-1")).toBeNull();
  });

  it("opens nothing for a finished task, and frees the group when its issue cannot be created", async () => {
    const done = host({ tasks: [altTask({ issue_id: "issue-1", status: "done" })], chunks: [chunkRow(1, "queued")] });
    expect(await openNextGroup(done.env, "co-1", "t-1")).toBeNull();
    expect(done.created).toHaveLength(0);
    const failing = host({ tasks: [altTask({ issue_id: "issue-1", status: "in_progress" })], chunks: [chunkRow(1, "queued")] });
    failing.ctx.issues.create = (async () => {
      throw new Error("host down");
    }) as never;
    expect(await openNextGroup(failing.env, "co-1", "t-1")).toBeNull();
    expect(failing.mem.chunks[0]).toMatchObject({ status: "queued", opened_at: null });
  });
});

describe("a group's issue closes", () => {
  const task = () => altTask({ issue_id: "issue-1", status: "in_progress" });

  it("marks the group done, tells the parent, and opens the next group", async () => {
    const h = host({ tasks: [task()], chunks: [chunkRow(1, "open"), chunkRow(2, "queued"), chunkRow(3, "queued")], issueStatus: { "grp-1": "done" } });
    expect(await onChunkIssueUpdated(h.env, "co-1", "grp-1")).toBe(true);
    expect(h.mem.chunks.map((c) => c.status)).toEqual(["done", "open", "queued"]);
    expect(h.mem.chunks[0]!.done_at).toEqual(expect.any(String));
    expect(h.created).toHaveLength(1);
    expect(String(h.created[0]!.input.title)).toContain("group 2 of 6");
    expect(h.comments.find((c) => c.id === "issue-1")!.body).toMatch(/^Group 1 of 6 \(PIB-grp-1\) is done: 9 pages\. Group 2 is open/);
    expect(h.wakeups).not.toContain("issue-1"); // the parent waits for the last group
  });

  it("wakes the agent on the parent when the last group closes, to check the site as a whole", async () => {
    const h = host({ tasks: [task()], chunks: [chunkRow(1, "done"), chunkRow(2, "done"), chunkRow(3, "open", { total: 3 })], issueStatus: { "grp-3": "done" } });
    await onChunkIssueUpdated(h.env, "co-1", "grp-3");
    expect(h.created).toHaveLength(0);
    expect(h.comments.find((c) => c.id === "issue-1")!.body).toContain("Every group is finished");
    expect(h.wakeups).toContain("issue-1");
  });

  it("counts a cancelled group as finished, and reopens one that was closed by mistake", async () => {
    const cancelled = host({ tasks: [task()], chunks: [chunkRow(1, "open", { total: 1 })], issueStatus: { "grp-1": "cancelled" } });
    await onChunkIssueUpdated(cancelled.env, "co-1", "grp-1");
    expect(cancelled.mem.chunks[0]!.status).toBe("cancelled");
    expect(cancelled.wakeups).toContain("issue-1");
    const reopened = host({ tasks: [task()], chunks: [chunkRow(1, "done"), chunkRow(2, "queued")], issueStatus: { "grp-1": "in_progress" } });
    await onChunkIssueUpdated(reopened.env, "co-1", "grp-1");
    expect(reopened.mem.chunks[0]).toMatchObject({ status: "open", done_at: null });
    expect(reopened.created).toHaveLength(0); // a group is open again: nothing else opens
  });

  it("does nothing for an issue that is not a group, and nothing twice for a group already recorded as done", async () => {
    const h = host({ tasks: [task()], chunks: [chunkRow(1, "done"), chunkRow(2, "queued")], issueStatus: { "grp-1": "done" } });
    expect(await onChunkIssueUpdated(h.env, "co-1", "some-other-issue")).toBe(false);
    expect(await onChunkIssueUpdated(h.env, "co-1", "grp-1")).toBe(true);
    expect(h.created).toHaveLength(0);
    expect(h.comments).toHaveLength(0);
    expect(h.mem.chunks.map((c) => c.status)).toEqual(["done", "queued"]);
  });

  it("does not wake or open anything for a task that is already finished", async () => {
    const h = host({ tasks: [altTask({ issue_id: "issue-1", status: "done" })], chunks: [chunkRow(1, "open"), chunkRow(2, "queued")], issueStatus: { "grp-1": "done" } });
    await onChunkIssueUpdated(h.env, "co-1", "grp-1");
    expect(h.created).toHaveLength(0);
    expect(h.wakeups).toEqual([]);
    expect(h.mem.chunks[0]!.status).toBe("done");
  });
});

describe("completing a split task", () => {
  const task = () => altTask({ issue_id: "issue-1", status: "in_progress" });

  it("refuses an agent until the last group is done, naming what is open", async () => {
    const h = host({ tasks: [task()], chunks: [chunkRow(1, "done"), chunkRow(2, "open"), chunkRow(3, "queued")] });
    await expect(completeTask(h.env, "co-1", agent, { taskId: "t-1", summary: "all done" })).rejects.toThrow(/split into 6 page groups and 2 are not done \(open now: group 2, PIB-202\)/);
    expect(h.mem.tasks[0]!.status).toBe("in_progress");
  });

  it("lets the agent complete it once every group is finished, and a person any time", async () => {
    const finished = host({ tasks: [task()], chunks: [chunkRow(1, "done"), chunkRow(2, "cancelled")] });
    await expect(completeTask(finished.env, "co-1", agent, { taskId: "t-1", summary: "checked the sitemap and a sample of pages" })).resolves.toMatchObject({ status: "done" });
    const unfinished = host({ tasks: [task()], chunks: [chunkRow(1, "open")] });
    await expect(completeTask(unfinished.env, "co-1", person, { taskId: "t-1", summary: "done by hand" })).resolves.toMatchObject({ status: "done" });
  });

  it("completes a task that was never split exactly as before", async () => {
    const h = host({ tasks: [task()] });
    await expect(completeTask(h.env, "co-1", agent, { taskId: "t-1", summary: "small site" })).resolves.toMatchObject({ status: "done" });
  });

  it("reopens a parent an agent closes in the issue itself while groups are open, with what is missing", async () => {
    const h = host({ tasks: [task()], chunks: [chunkRow(1, "open"), chunkRow(2, "queued")] });
    const result = await checkTaskClose({ id: "issue-1", companyId: "co-1", originId: "seo:task:t-1" } as never, h.ctx);
    expect(result).toMatchObject({ done: false });
    expect((result as { missing: string[] }).missing.join(" ")).toMatch(/split into 6 page groups/);
  });

  it("only looks at the groups of the task's current issue (a moved task starts over)", async () => {
    const h = host({ tasks: [task()], chunks: [chunkRow(1, "open", { parent_issue_id: "old-issue" })] });
    expect(await groupBlockerFor(h.ctx.db as never, "co-1", { id: "t-1", issueId: "issue-1" })).toBeNull();
    expect(await groupBlockerFor(h.ctx.db as never, "co-1", { id: "t-1", issueId: "old-issue" })).toContain("1 is not done");
    expect(await groupBlockerFor(h.ctx.db as never, "co-1", { id: "t-1", issueId: null })).toBeNull();
  });
});

describe("start-task and split-task on a task that is already open", () => {
  const open = (extra: Row = {}) => altTask({ issue_id: "issue-1", status: "in_progress", issue_status: "todo", ...extra });

  it("splits a big site's task when the agent starts it, and tells the agent to stop working the pages", async () => {
    const h = host({ tasks: [open()], site: siteWith(57).fetcher });
    const result = (await startTask(h.env, "co-1", agent, { taskId: "t-1" })) as Record<string, any>;
    expect(result.split).toMatchObject({ groups: 6, pages: 57 });
    expect(result.split.next).toMatch(/End your run on this issue/);
    expect(h.mem.chunks).toHaveLength(6);
    expect(h.comments.find((c) => c.id === "issue-1")!.body).toMatch(/Split into 6 page groups: 57 pages, 10 or fewer each/);
    expect(h.created).toHaveLength(1); // the first group
    // A second start-task (the agent was woken again) finds the groups and does nothing more.
    const again = (await startTask(h.env, "co-1", agent, { taskId: "t-1" })) as Record<string, unknown>;
    expect(again).not.toHaveProperty("split");
    expect(h.created).toHaveLength(1);
  });

  it("does not split for a person's start, a small site, a task with groups, or a decision made this week", async () => {
    const big = siteWith(57);
    const byPerson = host({ tasks: [open()], site: big.fetcher });
    expect(await startTask(byPerson.env, "co-1", person, { taskId: "t-1" })).not.toHaveProperty("split");
    expect(big.calls).toHaveLength(0);
    const small = host({ tasks: [open()], site: siteWith(8).fetcher });
    expect(await startTask(small.env, "co-1", agent, { taskId: "t-1" })).not.toHaveProperty("split");
    const withGroups = host({ tasks: [open()], chunks: [chunkRow(1, "open")], site: big.fetcher });
    expect(await splitOnStart(withGroups.env, await taskOf(withGroups))).toBeNull();
    // A "no split needed" answer from three days ago holds: the sitemap is not read again.
    const calls = siteWith(57);
    const remembered = host({ tasks: [open({ evidence: { split: { checkedOn: "2026-09-30", pages: 8, size: 10, groups: 0 } } })], site: calls.fetcher });
    expect(await splitOnStart(remembered.env, await taskOf(remembered))).toBeNull();
    expect(calls.calls).toHaveLength(0);
    const old = host({ tasks: [open({ evidence: { split: { checkedOn: "2026-09-20", pages: 8, size: 10, groups: 0 } } })], site: siteWith(57).fetcher });
    expect(await splitOnStart(old.env, await taskOf(old))).toMatchObject({ groups: 6 });
  });

  it("split-task shows the plan on a dry run, and opens the groups for real otherwise", async () => {
    const dry = host({ tasks: [open()], site: siteWith(57).fetcher });
    const plan = (await splitTaskTool(dry.env, "co-1", agent, { taskId: "t-1", dryRun: true })) as Record<string, any>;
    expect(plan).toMatchObject({ split: false, dryRun: true, plan: { groups: 6, pages: 57, perGroup: 10, source: "sitemap" } });
    expect(plan.plan.sample).toHaveLength(3);
    expect(dry.mem.chunks).toHaveLength(0);
    const real = host({ tasks: [open()], site: siteWith(57).fetcher });
    const result = (await splitTaskTool(real.env, "co-1", agent, { taskId: "t-1", size: 20 })) as Record<string, any>;
    expect(result).toMatchObject({ split: true, plan: { groups: 3, perGroup: 20 } });
    expect(result.next).toMatch(/End your run on this issue now/);
    expect(real.mem.chunks).toHaveLength(3);
    expect(real.mem.chunks[0]!.status).toBe("open");
  });

  it("split-task takes the pages it is given, refuses a task without an issue or a finished one, and says when no split is needed", async () => {
    const own = host({ tasks: [open()], site: siteWith(null).fetcher });
    const result = (await splitTaskTool(own.env, "co-1", person, { taskId: "t-1", urls: [...pagesOf(25), "https://evil.example/x"], dryRun: true })) as Record<string, any>;
    expect(result.plan).toMatchObject({ groups: 3, pages: 25, source: "given" }); // the page on another host is dropped
    await expect(splitTaskTool(host({ tasks: [open({ issue_id: null })], site: siteWith(57).fetcher }).env, "co-1", agent, { taskId: "t-1" })).rejects.toThrow(/no issue yet/);
    await expect(splitTaskTool(host({ tasks: [open({ status: "done" })], site: siteWith(57).fetcher }).env, "co-1", agent, { taskId: "t-1" })).rejects.toThrow(/already done/);
    await expect(splitTaskTool(own.env, "co-1", agent, { taskId: "nope" })).rejects.toThrow(/Task not found/);
    const small = host({ tasks: [open()], site: siteWith(8).fetcher });
    expect(await splitTaskTool(small.env, "co-1", agent, { taskId: "t-1" })).toMatchObject({ split: false, pages: 8, next: "Work the whole task in this run." });
    const already = host({ tasks: [open()], chunks: [chunkRow(1, "open"), chunkRow(2, "queued")], site: siteWith(57).fetcher });
    expect(await splitTaskTool(already.env, "co-1", agent, { taskId: "t-1" })).toMatchObject({ split: true, alreadySplit: true, progress: { total: 2, open: 1, queued: 1 } });
  });

  it("plans from the site's own pages, the sprint's known pages first", async () => {
    const h = host({ tasks: [open()], site: siteWith(57).fetcher });
    const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
    const { plan, pages } = await planSplit(h.env, sprint, { taskType: "meta-tag-audit" });
    expect(pages).toBe(57);
    expect(plan!.groups).toHaveLength(6);
    expect(plan!.source).toBe("sitemap");
    expect(plan!.groups[0]!.urls[0]).toBe(HOME);
  });
});

describe("skipping, healing and reporting groups", () => {
  it("cancels the groups of a skipped task, their issues included", async () => {
    const h = host({ tasks: [altTask({ issue_id: "issue-1", status: "in_progress" })], chunks: [chunkRow(1, "done"), chunkRow(2, "open"), chunkRow(3, "queued")] });
    await skipTask(h.env, "co-1", person, { taskId: "t-1", reason: "the client moved the site" });
    expect(h.mem.chunks.map((c) => c.status)).toEqual(["done", "cancelled", "cancelled"]);
    expect(h.updates.some((u) => u.id === "grp-2" && u.patch.status === "cancelled")).toBe(true);
    expect(h.updates.some((u) => u.id === "grp-1")).toBe(false); // the finished group is left alone
    expect(h.comments.find((c) => c.id === "grp-2")!.body).toContain("the client moved the site");
  });

  it("re-reads open groups after a missed event, and opens the next one", async () => {
    const h = host({ tasks: [altTask({ issue_id: "issue-1", status: "in_progress" })], chunks: [chunkRow(1, "open"), chunkRow(2, "queued")], issueStatus: { "grp-1": "done" } });
    expect(await healChunks(h.env, "co-1")).toMatchObject({ synced: 1 });
    expect(h.mem.chunks.map((c) => c.status)).toEqual(["done", "open"]);
    expect(h.comments.some((c) => /Group 1 of 6/.test(c.body))).toBe(true);
    expect(h.created).toHaveLength(1);
  });

  it("frees a group whose issue was never created, but not one that is only a minute old", async () => {
    const old = host({ tasks: [altTask({ issue_id: "issue-1", status: "in_progress" })], chunks: [chunkRow(1, "open", { issue_id: null, opened_at: "2026-10-03T07:00:00Z" })] });
    expect((await healChunks(old.env, "co-1")).released).toBe(1);
    const fresh = host({ tasks: [altTask({ issue_id: "issue-1", status: "in_progress" })], chunks: [chunkRow(1, "open", { issue_id: null, opened_at: new Date().toISOString() })] });
    expect((await healChunks(fresh.env, "co-1")).released).toBe(0);
  });

  it("frees an issue-less group only after ten minutes", async () => {
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
    const at = async (n: number) => (await healChunks(host({ tasks: [altTask({ issue_id: "issue-1", status: "in_progress" })], chunks: [chunkRow(1, "open", { issue_id: null, opened_at: minutesAgo(n) })] }).env, "co-1")).released;
    expect(await at(9)).toBe(0);
    expect(await at(11)).toBe(1);
  });

  it("closes the groups of a task that is already finished", async () => {
    const h = host({ tasks: [altTask({ issue_id: "issue-1", status: "done" })], chunks: [chunkRow(2, "open")] });
    expect((await healChunks(h.env, "co-1")).cancelled).toBe(1);
    expect(h.updates.some((u) => u.id === "grp-2" && u.patch.status === "cancelled")).toBe(true);
    expect(await cancelGroups(h.env, "co-1", "t-1", "closed")).toBe(0); // nothing left to cancel
  });

  it("opens the next group of a task that has none open (a missed close)", async () => {
    const h = host({ tasks: [altTask({ issue_id: "issue-1", status: "in_progress" })], chunks: [chunkRow(1, "done"), chunkRow(2, "queued")] });
    expect(await healChunks(h.env, "co-1")).toMatchObject({ opened: 1 });
    expect(h.mem.chunks.map((c) => c.status)).toEqual(["done", "open"]);
  });

  it("reports each split task's progress for today and the page, only for unfinished groups", async () => {
    const h = host({ tasks: [altTask({ issue_id: "issue-1", status: "in_progress" }), altTask({ id: "t-2", issue_id: "issue-2", template_key: "w1-noindex" })], chunks: [chunkRow(1, "done"), chunkRow(2, "open"), chunkRow(3, "queued"), chunkRow(1, "done", { id: "other-1", task_id: "t-2", parent_issue_id: "issue-2", total: 1 })] });
    const views = await groupViews(h.env, "co-1", "sp-1");
    expect(views.get("t-1")).toEqual({ taskId: "t-1", total: 3, done: 1, open: 1, queued: 1, cancelled: 0, openIssue: { issueId: "grp-2", identifier: "PIB-202", seq: 2 } });
    expect(views.size).toBe(1); // t-2's only group is done
  });
});

describe("what the agent is told today about a split task", () => {
  /** The sprint's open tasks as the list query asks for them. */
  const listOpenTasks = (h: Host) => h.routes.unshift([/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE company_id = \$1 AND sprint_id = \$2 AND status IN/, () => h.mem.tasks]);

  it("lists the groups of a task in progress and points at the open group issue, not the task's own issue", async () => {
    const h = host({ tasks: [altTask({ issue_id: "issue-1", issue_identifier: "PIB-1", status: "in_progress" })], chunks: [chunkRow(1, "done"), chunkRow(2, "open"), chunkRow(3, "queued")] });
    listOpenTasks(h);
    const today = await sprintToday(h.env, await companyInfo(h.env, "co-1"), (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!);
    const [task] = today.inProgress;
    expect(task).toMatchObject({ taskId: "t-1", pageGroups: { total: 3, done: 1, open: 1, queued: 1, openIssue: { issueId: "grp-2", identifier: "PIB-202" } } });
    expect(today.next.some((line) => /is split into 3 page groups \(1 done\): work the open group issue PIB-202, not the task's own issue/.test(line))).toBe(true);
  });

  it("says nothing about groups for a task that was not split", async () => {
    const h = host({ tasks: [altTask({ issue_id: "issue-1", status: "in_progress" })] });
    listOpenTasks(h);
    const today = await sprintToday(h.env, await companyInfo(h.env, "co-1"), (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!);
    expect(today.inProgress[0]).not.toHaveProperty("pageGroups");
    expect(today.next.some((line) => /page groups/.test(line))).toBe(false);
  });
});

describe("a page group the agent blocked", () => {
  const task = () => altTask({ issue_id: "issue-1", status: "in_progress" });
  const waiting = () => ({ ...groupBlockedItem({ chunkId: "chunk-2", seq: 2, total: 6, taskTitle: "Describe every image (alt text)", issueIdentifier: "PIB-202" }), status: "open", addedAt: "2026-10-03T07:30:00Z" });
  /** The digest as the plugin reads it: with the blocked group's line open when `open` is set. */
  function blockedHost(issueStatus: string, opts: { open?: boolean; chunks?: Row[]; tasks?: Row[] } = {}) {
    const h = host({ tasks: opts.tasks ?? [task()], chunks: opts.chunks ?? [chunkRow(1, "done"), chunkRow(2, "open"), chunkRow(3, "queued")], issueStatus: { "grp-2": issueStatus } });
    h.routes.unshift(...needsYouRoutes(opts.open ? [waiting()] : [], { open: opts.open ?? false }));
    return h;
  }

  it("is put on the sprint's Needs you list, because groups open one at a time and the whole task waits", async () => {
    const h = blockedHost("blocked");
    expect(await onChunkIssueUpdated(h.env, "co-1", "grp-2")).toBe(true);
    const item = savedNeedsYouItems(h).find((i) => i.key === "chunk:chunk-2")!;
    expect(item).toMatchObject({ kind: "task", status: "open", check: "manual", taskIds: [], title: "Page group 2 of 6 is blocked: Describe every image (alt text)" });
    expect(String(item.why)).toContain("PIB-grp-2");
    // The group stays open: the next one does not start, the parent is not woken, parked or told anything.
    expect(h.mem.chunks.map((c) => c.status)).toEqual(["done", "open", "queued"]);
    expect(h.created).toHaveLength(0);
    expect(h.wakeups).toEqual([]);
    expect(h.updates.filter((u) => u.id === "issue-1")).toEqual([]);
    expect(h.comments.filter((c) => c.id === "issue-1")).toEqual([]);
  });

  it("is found again by the daily heal when the event was missed", async () => {
    const h = blockedHost("blocked");
    await healChunks(h.env, "co-1");
    expect(savedNeedsYouItems(h).map((i) => i.key)).toContain("chunk:chunk-2");
  });

  it("does not read the sprint or the digest's items when a group that was never blocked changes", async () => {
    const h = blockedHost("in_progress");
    await onChunkIssueUpdated(h.env, "co-1", "grp-2");
    // One cheap read of the open digests says nothing waits on this group; nothing else is loaded or written.
    expect(h.queries.some((q) => /FROM plugin_seo_8099f8879a\.needs_you n JOIN/.test(q.sql))).toBe(true);
    expect(h.queries.some((q) => /FROM plugin_seo_8099f8879a\.sprints WHERE id = \$1/.test(q.sql))).toBe(false);
    expect(executed(h, /needs_you/)).toEqual([]);
  });

  it("raises nothing for a task that is already finished", async () => {
    const h = blockedHost("blocked", { tasks: [altTask({ issue_id: "issue-1", status: "done" })] });
    await onChunkIssueUpdated(h.env, "co-1", "grp-2");
    expect(savedNeedsYouItems(h)).toEqual([]);
  });

  it("closes its line when the issue is unblocked, done or cancelled, without touching the issue again", async () => {
    for (const [status, by] of [["in_progress", "the group's issue was unblocked"], ["todo", "the group's issue was unblocked"], ["done", "the group's issue was closed"], ["cancelled", "the group's issue was closed"]] as const) {
      const h = blockedHost(status, { open: true });
      await onChunkIssueUpdated(h.env, "co-1", "grp-2");
      expect(savedNeedsYouItems(h).find((i) => i.key === "chunk:chunk-2"), status).toMatchObject({ status: "done", doneBy: by });
      expect(h.updates.filter((u) => u.id === "grp-2"), status).toEqual([]); // a person already moved it: nothing is patched back
    }
  });

  it("hands the group back to the SEO Specialist (todo and a wake) when a person says its line is done, and never wakes the parent", async () => {
    const h = blockedHost("blocked", { open: true });
    const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
    const result = await resolveNeedsYou(h.env, await companyInfo(h.env, "co-1"), sprint, "chunk:chunk-2", "user user-1");
    expect(result).toMatchObject({ resolved: true, tasksContinued: 1 });
    expect(h.updates.find((u) => u.id === "grp-2")!.patch).toMatchObject({ status: "todo", assigneeAgentId: "agent-1" });
    expect(h.comments.find((c) => c.id === "grp-2")!.body).toContain("What this group waited for is done (user user-1)");
    expect(h.wakeups).toEqual(["grp-2"]);
    expect(h.updates.filter((u) => u.id === "issue-1")).toEqual([]); // the parent task was not parked, resumed or woken
    expect(savedNeedsYouItems(h).find((i) => i.key === "chunk:chunk-2")).toMatchObject({ status: "done", doneBy: "user user-1" });
  });

  it("does nothing more when the person had already moved the issue on", async () => {
    const h = blockedHost("in_progress", { open: true });
    const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
    expect(await resolveNeedsYou(h.env, await companyInfo(h.env, "co-1"), sprint, "chunk:chunk-2", "user user-1")).toMatchObject({ resolved: true, tasksContinued: 0 });
    expect(h.updates.filter((u) => u.id !== "ny-issue")).toEqual([]); // only the digest issue is edited (it has nothing left open)
    expect(h.wakeups).toEqual([]);
  });

  it("leaves a finished group alone when its line is closed late", async () => {
    const h = blockedHost("blocked", { open: true, chunks: [chunkRow(1, "done"), chunkRow(2, "cancelled")] });
    const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
    expect(await resolveNeedsYou(h.env, await companyInfo(h.env, "co-1"), sprint, "chunk:chunk-2", "user user-1")).toMatchObject({ resolved: true, tasksContinued: 0 });
    expect(h.updates.filter((u) => u.id !== "ny-issue")).toEqual([]);
    expect(h.wakeups).toEqual([]);
  });
});

describe("when the page list cannot be trusted", () => {
  const open = (extra: Row = {}) => altTask({ issue_id: "issue-1", status: "in_progress", issue_status: "todo", ...extra });
  const sitemapDown: SiteFetcher = async (url): Promise<SafeFetchResult> => (url.endsWith("/robots.txt") ? reply(200, "Sitemap: https://acme.co.za/sitemap.xml", {}, url) : url.endsWith("/sitemap.xml") ? reply(503) : reply(404));

  it("does not remember 'no split needed' for a site whose sitemap failed with a server error, so the next start asks again", async () => {
    const down = host({ tasks: [open()], site: sitemapDown });
    expect(await startTask(down.env, "co-1", agent, { taskId: "t-1" })).not.toHaveProperty("split");
    expect(down.mem.tasks[0]!.evidence ?? {}).not.toHaveProperty("split");
    // A site that really has no sitemap (404) is an answer: remembered for a week.
    const none = host({ tasks: [open()], site: siteWith(null).fetcher });
    await startTask(none.env, "co-1", agent, { taskId: "t-1" });
    expect(none.mem.tasks[0]!.evidence).toMatchObject({ split: { groups: 0 } });
  });

  it("split-task says nothing was decided when the page list could not be read in full", async () => {
    const h = host({ tasks: [open()], site: sitemapDown });
    const result = (await splitTaskTool(h.env, "co-1", agent, { taskId: "t-1" })) as Record<string, any>;
    expect(result).toMatchObject({ split: false });
    expect(result.reason).toMatch(/could not be read in full/);
    expect(result.next).toMatch(/nothing was decided/);
    expect(h.mem.tasks[0]!.evidence ?? {}).not.toHaveProperty("split");
  });

  it("a dry run decides nothing and leaves no record on the task", async () => {
    const dry = host({ tasks: [open()], site: siteWith(8).fetcher });
    expect(await splitTaskTool(dry.env, "co-1", agent, { taskId: "t-1", dryRun: true })).toMatchObject({ split: false });
    expect(dry.mem.tasks[0]!.evidence ?? {}).not.toHaveProperty("split");
    const real = host({ tasks: [open()], site: siteWith(8).fetcher });
    await splitTaskTool(real.env, "co-1", agent, { taskId: "t-1" });
    expect(real.mem.tasks[0]!.evidence).toMatchObject({ split: { pages: 8, groups: 0 } });
  });
});
