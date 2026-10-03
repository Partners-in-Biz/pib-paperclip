import { describe, expect, it } from "vitest";
import { collectSitePages } from "../src/checks/pages.js";
import * as db from "../src/db.js";
import {
  chunkBlocker,
  chunkProgress,
  groupBlockedItem,
  groupBlockedKey,
  groupDoneComment,
  groupIssueDescription,
  groupIssueTitle,
  groupSizeFor,
  isSiteWideTask,
  MAX_GROUP_SIZE,
  MAX_GROUPS,
  MAX_SPLIT_PAGES,
  MIN_GROUP_SIZE,
  planGroups,
  SITE_WIDE,
  splitSection,
} from "../src/engine/chunks.js";
import { PLAYBOOKS } from "../src/templates/playbooks.js";
import { CODE_TASK_TYPES } from "../src/engine/site-change.js";
import { GEO_CODE_TYPES } from "../src/templates/geo.js";
import { reply } from "./helpers/geo-site.js";
import type { SiteFetcher } from "../src/checks/site.js";
import type { SafeFetchResult } from "@partnersinbiz/pib-plugin-kit";

const pagesOf = (n: number, host = "https://acme.co.za") => Array.from({ length: n }, (_, i) => `${host}/page-${i + 1}`);

describe("planning page groups", () => {
  it("does not split a site one run can do", () => {
    expect(planGroups(pagesOf(10), 10)).toBeNull();
    expect(planGroups(pagesOf(3), 10)).toBeNull();
    expect(planGroups([], 10)).toBeNull();
  });

  it("splits the rest evenly, in order, with a label per group", () => {
    const groups = planGroups(pagesOf(57), 10)!;
    expect(groups).toHaveLength(6);
    expect(groups.map((g) => g.urls.length)).toEqual([10, 10, 10, 9, 9, 9]);
    expect(groups.flatMap((g) => g.urls)).toEqual(pagesOf(57));
    expect(groups[0]).toMatchObject({ seq: 1, total: 6, label: "pages 1–10 of 57" });
    expect(groups[5]).toMatchObject({ seq: 6, total: 6, label: "pages 49–57 of 57" });
    expect(Math.max(...groups.map((g) => g.urls.length))).toBeLessThanOrEqual(10);
  });

  it("repeats nothing and never makes a group bigger than asked, however big the site", () => {
    const dupes = [...pagesOf(12), ...pagesOf(12)];
    expect(planGroups(dupes, 10)!.flatMap((g) => g.urls)).toHaveLength(12);
    const huge = planGroups(pagesOf(1000), 10)!;
    expect(huge).toHaveLength(MAX_GROUPS);
    expect(huge.flatMap((g) => g.urls)).toHaveLength(MAX_SPLIT_PAGES);
    expect(huge.every((g) => g.urls.length <= 10)).toBe(true);
    // A small group size covers fewer pages instead of making fat groups.
    const small = planGroups(pagesOf(1000), MIN_GROUP_SIZE)!;
    expect(small.every((g) => g.urls.length <= MIN_GROUP_SIZE)).toBe(true);
    expect(small).toHaveLength(MAX_GROUPS);
    expect(small.flatMap((g) => g.urls)).toHaveLength(MAX_GROUPS * MIN_GROUP_SIZE);
  });

  it("knows which tasks are site-wide, and the group size each takes", () => {
    for (const type of ["meta-tag-audit", "alt-text-audit", "noindex-add", "canonical-check"]) expect(isSiteWideTask({ taskType: type, source: "template" }), type).toBe(true);
    expect(isSiteWideTask({ taskType: "page-write", source: "template" })).toBe(false);
    expect(isSiteWideTask({ taskType: "alt-text-audit", source: "optimization" })).toBe(false);
    expect([groupSizeFor("meta-tag-audit"), groupSizeFor("alt-text-audit"), groupSizeFor("canonical-check"), groupSizeFor("noindex-add")]).toEqual([10, 10, 25, 40]);
    expect(groupSizeFor("meta-tag-audit", 1)).toBe(MIN_GROUP_SIZE);
    expect(groupSizeFor("meta-tag-audit", 500)).toBe(MAX_GROUP_SIZE);
    expect(groupSizeFor("meta-tag-audit", 15)).toBe(15);
    expect(groupSizeFor("custom")).toBe(10);
  });

  it("has steps, a goal and evidence for every site-wide type, and the plan's playbooks tell the agent about groups", () => {
    for (const [type, kind] of Object.entries(SITE_WIDE)) {
      expect(kind.steps.length, type).toBeGreaterThanOrEqual(3);
      expect(kind.goal.length, type).toBeGreaterThan(40);
      expect(kind.done, type).toBeTruthy();
    }
    for (const key of ["w0-meta-tags", "w1-alt-text", "w1-noindex", "w1-canonical-check"]) {
      expect(PLAYBOOKS[key]!.steps.join(" "), key).toMatch(/splits this task into page groups/);
    }
  });
});

describe("what a parent task still waits for", () => {
  const chunk = (seq: number, status: "queued" | "open" | "done" | "cancelled", id?: string) => ({ seq, total: 4, status, issueIdentifier: id ?? null });
  it("is nothing once every group is done or cancelled", () => {
    expect(chunkBlocker([chunk(1, "done"), chunk(2, "cancelled"), chunk(3, "done"), chunk(4, "done")])).toBeNull();
    expect(chunkBlocker([])).toBeNull();
  });
  it("names the group that is open and how many are left", () => {
    const text = chunkBlocker([chunk(1, "done"), chunk(2, "open", "PIB-201"), chunk(3, "queued"), chunk(4, "queued")])!;
    expect(text).toContain("split into 4 page groups and 3 are not done");
    expect(text).toContain("open now: group 2, PIB-201");
    expect(text).toMatch(/you are woken here when the last one is done/);
    expect(chunkBlocker([chunk(4, "queued")])).toContain("1 is not done");
    expect(chunkProgress([chunk(1, "done"), chunk(2, "open"), chunk(3, "queued"), chunk(4, "cancelled")])).toEqual({ total: 4, done: 1, open: 1, queued: 1, cancelled: 1 });
  });
});

describe("the issues' wording", () => {
  const input = {
    task: { id: "t-1", title: "Describe every image (alt text)", week: 1, phase: 1, focus: "Tech Audit", taskType: "alt-text-audit", owner: "agent" as const, autopilotEligible: true, playbookKey: "w1-alt-text", source: "template", description: null },
    sprint: { id: "sp-1", siteName: "Acme Accounting", siteUrl: "https://acme.co.za", clientName: "Acme Accounting (Pty) Ltd", autopilotMode: "safe" as const, notes: "Deploys from Vercel" },
    group: { seq: 2, total: 6, urls: pagesOf(9), label: "pages 11–19 of 57" },
    taskId: "t-1",
    chunkId: "chunk-2",
    parentIdentifier: "PIB-150",
    site: { access: "repo", repoUrl: "https://github.com/pib/acme", defaultBranch: "development", branch: "seo/w1-alt-text-g2", changePolicy: "merge_seo_scope", hosting: "vercel" },
  };

  it("gives a group its pages, steps, own branch and the way to close it, without telling it to complete the task", () => {
    const text = groupIssueDescription(input).join("\n");
    expect(text).toContain("**group 2 of 6** (pages 11–19 of 57)");
    expect(text).toContain("One page group of the site-wide task \"Describe every image (alt text)\" (PIB-150)");
    expect(text).toContain("Do not call `complete-task`");
    expect(text).toContain("1. https://acme.co.za/page-1 (/page-1)");
    expect(text).toContain("9. https://acme.co.za/page-9 (/page-9)");
    expect(text).toContain("crawler-sim");
    expect(text).toContain("Branch `seo/w1-alt-text-g2`");
    expect(text).toContain("Deploys from Vercel");
    expect(text).toContain("Mark this issue **done**");
    expect(text).toContain("sprintId: `sp-1` · taskId: `t-1` · group: `chunk-2`");
    // A group is never told the whole-site playbook step ("home page and core pages").
    expect(text).not.toContain("home page and core pages");
  });

  it("promises only what the plugin does when a group is blocked: the Needs you list, and cancelling counts as finished", () => {
    const text = groupIssueDescription(input).join("\n");
    // The plugin raises the Needs you line when a group's issue goes blocked (service/chunks.ts) and cancelled counts as finished.
    expect(text).toContain("set this issue to **blocked**");
    expect(text).toContain("The plugin puts it on the sprint's Needs you list");
    expect(text).toContain("this issue comes back to you");
    expect(text).toContain("**Cancel** this issue with the reason: a cancelled group counts as finished and the next group opens");
    // The old text promised the "parent's task digest" would list a blocked group: nothing built that.
    expect(text).not.toContain("task digest");
    expect(text).not.toContain("the parent's");
  });

  it("makes the Needs you line for a blocked group: one per group, no task ids, so the parent task is neither parked nor woken", () => {
    const item = groupBlockedItem({ chunkId: "chunk-2", seq: 2, total: 6, taskTitle: "Describe every image (alt text)", issueIdentifier: "PIB-202" });
    expect(groupBlockedKey("chunk-2")).toBe("chunk:chunk-2");
    expect(item).toMatchObject({ key: "chunk:chunk-2", kind: "task", check: "manual", taskIds: [], title: "Page group 2 of 6 is blocked: Describe every image (alt text)" });
    expect(item.optional).toBeUndefined(); // a stalled task is not optional
    expect(item.why).toContain("PIB-202");
    expect(item.why).toMatch(/next groups do not open/);
    expect(item.steps.join(" ")).toMatch(/mark this item done: the group goes back to the SEO Specialist/);
    expect(item.steps.join(" ")).toMatch(/cancel its issue instead: a cancelled group counts as finished/);
    // Not a `task:` key, which the parking sweep and the task-handoff closing rules treat specially.
    expect(item.key.startsWith("task:")).toBe(false);
  });

  it("titles a group with its place in the task and the client's name", () => {
    expect(groupIssueTitle(input.task, input.sprint, input.group)).toBe("[Acme Accounting (Pty) Ltd] SEO W1 · Describe every image (alt text) · group 2 of 6 — Acme Accounting");
    expect(groupIssueTitle({ title: "x".repeat(300), week: 1 }, { siteName: "Acme", clientName: null }, input.group).length).toBeLessThanOrEqual(240);
  });

  it("says in the parent that it only coordinates, and what happens at the end", () => {
    const text = splitSection({ groups: 6, pages: 57, size: 10 }).join("\n");
    expect(text).toContain("## This task is split into 6 page groups");
    expect(text).toContain("The site has 57 pages");
    expect(text).toContain("**Do not work the pages in this issue**");
    expect(text).toContain("When the last group is done you are woken here");
    expect(text).toContain("cancel its issue with the reason; that counts as finished");
    expect(splitSection({ groups: 40, pages: 400, size: 10, capped: true }).join("\n")).toContain("Only the first 400 pages are split");
  });

  it("closes the loop on the parent in one short line each time", () => {
    expect(groupDoneComment({ seq: 1, total: 6, issueIdentifier: "PIB-201", pages: 10, next: { seq: 2, issueIdentifier: "PIB-202" } })).toBe("Group 1 of 6 (PIB-201) is done: 10 pages. Group 2 is open (PIB-202).");
    const last = groupDoneComment({ seq: 6, total: 6, pages: 9, next: null });
    expect(last).toContain("Every group is finished");
    expect(last).toContain("`complete-task`");
    expect(last.length).toBeLessThan(400);
  });
});

describe("the pages of a site", () => {
  const urlset = (urls: string[]) => `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
  const fetcherFor = (files: Record<string, string>): { fetcher: SiteFetcher; calls: string[] } => {
    const calls: string[] = [];
    const fetcher: SiteFetcher = async (url): Promise<SafeFetchResult> => {
      calls.push(url);
      return files[url] != null ? reply(200, files[url]!, {}, url) : reply(404);
    };
    return { fetcher, calls };
  };

  it("reads a sitemap, home page first, then the pages the sprint knows, then the sitemap's order, once each", async () => {
    const { fetcher } = fetcherFor({
      "https://acme.co.za/robots.txt": "Sitemap: https://acme.co.za/sitemap.xml",
      "https://acme.co.za/sitemap.xml": urlset(["https://acme.co.za/a", "https://acme.co.za/", "https://acme.co.za/b/", "https://acme.co.za/logo.png", "https://other.com/x", "https://acme.co.za/a#top", "https://acme.co.za/feed.xml"]),
    });
    const result = await collectSitePages(fetcher, "https://acme.co.za", { known: ["https://acme.co.za/b", "https://acme.co.za/c"] });
    expect(result.urls).toEqual(["https://acme.co.za/", "https://acme.co.za/b", "https://acme.co.za/c", "https://acme.co.za/a"]);
    expect(result).toMatchObject({ source: "sitemap", partial: false, capped: false, sitemapUrl: "https://acme.co.za/sitemap.xml" });
  });

  it("follows a sitemap index to its child sitemaps and says when it could not read them all", async () => {
    const children = Array.from({ length: 10 }, (_, i) => `https://acme.co.za/sm-${i}.xml`);
    const files: Record<string, string> = {
      "https://acme.co.za/robots.txt": "Sitemap: https://acme.co.za/index.xml",
      "https://acme.co.za/index.xml": `<sitemapindex>${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join("")}</sitemapindex>`,
    };
    children.forEach((c, i) => (files[c] = urlset([`https://acme.co.za/p-${i}-1`, `https://acme.co.za/p-${i}-2`])));
    const { fetcher, calls } = fetcherFor(files);
    const result = await collectSitePages(fetcher, "https://acme.co.za");
    expect(result.partial).toBe(true); // 10 children, only 8 are read
    expect(calls.filter((c) => c.includes("/sm-"))).toHaveLength(8);
    expect(result.urls).toHaveLength(1 + 16);
    expect(result.urls[0]).toBe("https://acme.co.za/");
  });

  it("calls the list partial when the sitemap answers a server error (it says nothing about the site's size)", async () => {
    const down: SiteFetcher = async (url) => (url.endsWith("/sitemap.xml") ? reply(503) : reply(404));
    expect((await collectSitePages(down, "https://acme.co.za", { known: ["https://acme.co.za/a"] })).partial).toBe(true);
    // A 404 is an honest "no sitemap".
    const none: SiteFetcher = async () => reply(404);
    expect((await collectSitePages(none, "https://acme.co.za")).partial).toBe(false);
  });

  it("falls back to the known pages without a sitemap, and says so", async () => {
    const { fetcher } = fetcherFor({});
    const result = await collectSitePages(fetcher, "https://acme.co.za", { known: ["https://acme.co.za/services"] });
    expect(result).toMatchObject({ urls: ["https://acme.co.za/", "https://acme.co.za/services"], source: "known", sitemapUrl: null });
    expect((await collectSitePages(fetcher, "https://acme.co.za")).source).toBe("none");
  });

  it("keeps the first pages when the site has more than it will split", async () => {
    const { fetcher } = fetcherFor({
      "https://acme.co.za/robots.txt": "",
      "https://acme.co.za/sitemap.xml": urlset(pagesOf(30)),
    });
    const result = await collectSitePages(fetcher, "https://acme.co.za", { maxUrls: 12 });
    expect(result.urls).toHaveLength(12);
    expect(result.capped).toBe(true);
  });
});

describe("the code types", () => {
  it("treats the GEO site-change types as code tasks, exactly the ones geo.ts lists", () => {
    for (const type of GEO_CODE_TYPES) expect(CODE_TASK_TYPES.has(type), type).toBe(true);
    expect([...CODE_TASK_TYPES].filter((t) => t.startsWith("geo-")).sort()).toEqual([...GEO_CODE_TYPES].sort());
  });
});
