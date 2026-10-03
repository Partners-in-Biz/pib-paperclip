/**
 * Page groups: a site-wide task (a title, description and share image for every page; alt text for every image; noindex
 * for every private page) is split into child issues of N pages, so one agent run never has to touch hundreds of
 * pages. Pure: planning the groups, their wording, and what a parent task still waits for.
 *
 * The plugin opens one group at a time (the next one when the one before it is done), so a sprint never has a swarm
 * of runs on one checkout, and the parent task is completed only after every group is done.
 */
import { siteSection, withClientPrefix, type SiteCopy, type SprintCopy, type TaskCopy } from "./copy.js";
import type { NewNeedsYouItem } from "./needs-you.js";
import { playbookFor, qualifiedTool } from "../templates/playbooks.js";
import { PHASE_NAMES, type SprintPhase } from "../templates/outrank-90.js";

export interface SiteWideKind {
  /** Pages per group when the sprint does not say otherwise. */
  size: number;
  /** What one group does, in a sentence. */
  goal: string;
  steps: string[];
  done: string;
  evidence: string;
}

/** Task types whose work is "every page of the site". */
export const SITE_WIDE: Record<string, SiteWideKind> = {
  "meta-tag-audit": {
    size: 10,
    goal: "Every page in this group has a unique title (50–60 characters), meta description (70–160), canonical, og:title and og:image that fit what the page is about.",
    steps: [
      "`check-meta` on each page of the group (with sprintId, so the problems are recorded as findings).",
      "Write the missing or weak titles and descriptions around each page's real topic and target keyword. When many pages share one template (a page-builder default, an SEO plugin's title pattern), fix the pattern once instead of page by page and list the pages it covers.",
      "Make the changes the way the Site section below says: one branch and PR for this group, or one pass of the Connector's SEO tool.",
      "Re-run `check-meta` on the group's pages: the findings resolve once the live pages are right.",
    ],
    done: "`check-meta` reports no missing or duplicate title, description, og:image or canonical on any page of the group (or the page is listed with why it is left).",
    evidence: "The pages changed (count and a few examples with before and after), the PR or the Connector change ids.",
  },
  "alt-text-audit": {
    size: 10,
    goal: "Every meaningful image on the pages of this group has descriptive alt text; decorative images have an empty alt.",
    steps: [
      "`crawler-sim` on each page of the group: it counts the images without alt text and lists examples (WordPress: the Connector's `wp-media` op list with `missingAlt`, and `wp-content` op images for pictures inside the copy).",
      "Write alt text that describes the picture in context, plain words, under 300 characters, no keyword stuffing; leave decorative images empty.",
      "Make the changes the way the Site section below says (one PR or one Connector pass for this group). Images that sit in the theme's template files are a template edit, not a content edit.",
      "Re-run `crawler-sim` on the group's pages.",
    ],
    done: "`crawler-sim` reports no image without an alt attribute on any page of the group.",
    evidence: "Images fixed per page, and the PR or the Connector change ids.",
  },
  "noindex-add": {
    size: 40,
    goal: "Of the pages in this group, the private and thin ones are kept out of Google (noindex) and out of the sitemap; every page that should rank is left alone.",
    steps: [
      "Read the URLs of the group and decide for each: should a search engine show it? Out: login, account and dashboard pages, cart and checkout, thank-you pages, admin, internal search results, filter and sort pages, tag or date archives with nothing of their own, duplicates.",
      "`crawler-sim` on the ones you would take out, to see their current robots state. Never take out a page that earns traffic: check with `gsc-query` (the page filter) when unsure.",
      "Add `noindex` (the meta tag or the header) to those pages and remove them from the sitemap, the way the Site section below says.",
      "Re-run `crawler-sim` on them.",
    ],
    done: "Every page you took out reports noindex in `crawler-sim` and is gone from the sitemap; the rest of the group is unchanged.",
    evidence: "The URLs taken out (and why), and the PR or the Connector change ids; the number of pages left in.",
  },
  "canonical-check": {
    size: 25,
    goal: "Each page in this group has one self-referencing canonical (or a deliberate canonical to the preferred URL).",
    steps: [
      "`check-canonical` on each page of the group with sprintId.",
      "Fix missing canonicals, canonicals that point at another page by mistake, http against https and trailing-slash mismatches; a pattern shared by many pages is fixed once.",
      "Make the changes the way the Site section below says.",
      "Re-run `check-canonical` on the group's pages.",
    ],
    done: "`check-canonical` reports a matching canonical on every page of the group.",
    evidence: "Pages checked and fixed, and the PR or the Connector change ids.",
  },
};

export const MIN_GROUP_SIZE = 5;
export const MAX_GROUP_SIZE = 50;
/** Most pages one task is split over; a larger site is covered by fixing the shared template. */
export const MAX_SPLIT_PAGES = 400;
export const MAX_GROUPS = 40;

/** A task the plugin may split: a site-wide type the plan or the agent made (not an approved optimization of one page). */
export function isSiteWideTask(task: { taskType: string; source?: string | null }): boolean {
  return task.source !== "optimization" && task.taskType in SITE_WIDE;
}

export function groupSizeFor(taskType: string, override?: number | null): number {
  const base = SITE_WIDE[taskType]?.size ?? 10;
  if (override == null || !Number.isFinite(override)) return base;
  return Math.min(MAX_GROUP_SIZE, Math.max(MIN_GROUP_SIZE, Math.round(override)));
}

export interface GroupPlan {
  seq: number;
  total: number;
  urls: string[];
  /** "pages 11–20 of 57" */
  label: string;
}

/**
 * Split `urls` into groups of `size` or fewer, in order. null when one run can do them all (no more than `size` pages).
 * At most MAX_SPLIT_PAGES pages and MAX_GROUPS groups: a group never has more than `size` pages, so a big site with a small
 * `size` is split over its first MAX_GROUPS x `size` pages (the rest is the shared template's job).
 */
export function planGroups(urls: string[], size: number): GroupPlan[] | null {
  const unique = [...new Set(urls)].slice(0, Math.min(MAX_SPLIT_PAGES, MAX_GROUPS * size));
  if (unique.length <= size) return null;
  const count = Math.ceil(unique.length / size);
  // Even groups: 57 pages over 6 groups is 9 or 10 each, not five of 10 and one of 7.
  const base = Math.floor(unique.length / count);
  const extra = unique.length % count;
  const groups: GroupPlan[] = [];
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    const n = base + (i < extra ? 1 : 0);
    groups.push({ seq: i + 1, total: count, urls: unique.slice(at, at + n), label: `pages ${at + 1}–${at + n} of ${unique.length}` });
    at += n;
  }
  return groups;
}

export type ChunkStatus = "queued" | "open" | "done" | "cancelled";

export interface ChunkState {
  seq: number;
  total: number;
  status: ChunkStatus;
  issueIdentifier?: string | null;
}

/** What a parent task still waits for, or null when every group is finished (done or cancelled). */
export function chunkBlocker(chunks: ChunkState[]): string | null {
  const unfinished = chunks.filter((c) => c.status === "queued" || c.status === "open");
  if (unfinished.length === 0) return null;
  const open = unfinished.find((c) => c.status === "open");
  const total = chunks[0]?.total ?? chunks.length;
  return `This task is split into ${total} page groups and ${unfinished.length} ${unfinished.length === 1 ? "is" : "are"} not done${open ? ` (open now: group ${open.seq}${open.issueIdentifier ? `, ${open.issueIdentifier}` : ""})` : ""}. Work the group issues in order and close each one; you are woken here when the last one is done, then verify across the site and complete this task.`;
}

export function chunkProgress(chunks: ChunkState[]): { total: number; done: number; open: number; queued: number; cancelled: number } {
  return {
    total: chunks.length,
    done: chunks.filter((c) => c.status === "done").length,
    open: chunks.filter((c) => c.status === "open").length,
    queued: chunks.filter((c) => c.status === "queued").length,
    cancelled: chunks.filter((c) => c.status === "cancelled").length,
  };
}

function pathLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

/** The section the parent task's issue gets once it is split. */
export function splitSection(input: { groups: number; pages: number; size: number; firstGroupLabel?: string | null; capped?: boolean }): string[] {
  return [
    `## This task is split into ${input.groups} page groups`,
    `The site has ${input.pages} pages, too many for one run to do well. The plugin opens the groups as child issues of this one, ${input.size} pages or fewer each, one at a time: the next opens when the one before it is done. **Do not work the pages in this issue** and do not call \`complete-task\` until every group is done.`,
    "When the last group is done you are woken here: check the site as a whole (the sitemap, a sample of pages across the groups) and call `complete-task` with the totals. If a group's pages cannot be done, cancel its issue with the reason; that counts as finished.",
    input.capped ? `Only the first ${input.pages} pages are split. Where many pages share a template, fix the template once and list the pages it covers.` : null,
    "",
  ].filter((line): line is string => line !== null);
}

export interface GroupCopyInput {
  task: TaskCopy;
  sprint: SprintCopy;
  group: GroupPlan;
  taskId: string;
  chunkId: string;
  parentIdentifier?: string | null;
  site?: SiteCopy | null;
  cockpitPath?: string | null;
}

export function groupIssueTitle(task: { title: string; week: number }, sprint: Pick<SprintCopy, "siteName" | "clientName">, group: Pick<GroupPlan, "seq" | "total">): string {
  const title = withClientPrefix(`SEO W${task.week} · ${task.title} · group ${group.seq} of ${group.total} — ${sprint.siteName}`, sprint.clientName);
  return title.length > 240 ? `${title.slice(0, 237)}…` : title;
}

/** The child issue for one group of pages. */
export function groupIssueDescription(input: GroupCopyInput): string[] {
  const { task, group } = input;
  const kind = SITE_WIDE[task.taskType];
  const playbook = playbookFor(task.playbookKey);
  const phase = PHASE_NAMES[Math.min(Math.max(task.phase, 0), 4) as SprintPhase];
  const lines: string[] = [
    `**Sprint:** ${input.sprint.siteName} — ${input.sprint.siteUrl}`,
    `**Week ${task.week} · ${phase}${task.focus ? ` · ${task.focus}` : ""}** · owner: SEO Specialist · **group ${group.seq} of ${group.total}** (${group.label})`,
    "",
    `> One page group of the site-wide task "${task.title}"${input.parentIdentifier ? ` (${input.parentIdentifier})` : ""}. Work only the pages listed here, in this run. Do not call \`complete-task\`: the parent task is completed after the last group.`,
    "",
    "## Goal",
    kind?.goal ?? playbook.goal,
    "",
    `## Pages in this group (${group.urls.length})`,
    ...group.urls.map((url, i) => `${i + 1}. ${url} (${pathLabel(url)})`),
    "",
    "## Steps",
    ...(kind?.steps ?? playbook.steps).map((step, i) => `${i + 1}. ${step}`),
    "",
    "## Tools",
    ...playbook.tools.map((t) => `- \`${qualifiedTool(t)}\``),
    "",
    "## Definition of done",
    kind?.done ?? playbook.done,
    "",
    "## Evidence to record",
    kind?.evidence ?? playbook.evidence,
    "",
  ];
  if (input.site) lines.push(...siteSection(input.site));
  if (input.sprint.notes?.trim()) lines.push("## Sprint notes (site access, constraints)", input.sprint.notes.trim(), "");
  lines.push(
    "## Close it",
    "Mark this issue **done** with one short comment: how many pages you changed, what changed, and the PR, commit or Connector change ids. That is all the parent task needs from you.",
    "Blocked on a person (a one-time grant or a judgement)? Do the pages you can, then say in a comment exactly what you need and from whom, and set this issue to **blocked**. The plugin puts it on the sprint's Needs you list; when the person has done it, this issue comes back to you. Cannot be done at all? **Cancel** this issue with the reason: a cancelled group counts as finished and the next group opens.",
    "",
    `sprintId: \`${input.sprint.id}\` · taskId: \`${input.taskId}\` · group: \`${input.chunkId}\``,
  );
  if (input.cockpitPath) lines.push(`Cockpit: [SEO → this sprint](${input.cockpitPath})`);
  return lines;
}

/** The comment on the parent when a group closes. Short on purpose (threads are capped). */
export function groupDoneComment(input: { seq: number; total: number; issueIdentifier?: string | null; pages: number; next?: { seq: number; issueIdentifier?: string | null } | null }): string {
  const head = `Group ${input.seq} of ${input.total}${input.issueIdentifier ? ` (${input.issueIdentifier})` : ""} is done: ${input.pages} pages.`;
  if (input.next) return `${head} Group ${input.next.seq} is open${input.next.issueIdentifier ? ` (${input.next.issueIdentifier})` : ""}.`;
  return `${head} Every group is finished: check the site as a whole (the sitemap, a sample of pages across the groups) and call \`complete-task\` with the totals.`;
}

/** The Needs you key of a blocked group (one line per group, so a repeat of the same block changes nothing). */
export function groupBlockedKey(chunkId: string): string {
  return `chunk:${chunkId}`;
}

/**
 * The Needs you line for a group whose issue the agent blocked. Groups open one at a time, so a blocked group stalls the whole
 * task: a person has to be told. No task ids: the parent task must not be parked or woken for it.
 */
export function groupBlockedItem(input: { chunkId: string; seq: number; total: number; taskTitle: string; issueIdentifier?: string | null }): NewNeedsYouItem {
  const issue = input.issueIdentifier ?? "its issue";
  return {
    key: groupBlockedKey(input.chunkId),
    kind: "task",
    title: `Page group ${input.seq} of ${input.total} is blocked: ${input.taskTitle}`,
    why: `The SEO Specialist blocked the issue of page group ${input.seq} of "${input.taskTitle}" (${issue}) and says why in a comment on it. The next groups do not open, and the task cannot be completed, until it is unblocked or cancelled.`,
    steps: [
      `Open ${issue} and read the SEO Specialist's last comment: it says what it needs and from whom.`,
      "Do that (or decide it), then mark this item done: the group goes back to the SEO Specialist.",
      "If the group cannot be done, cancel its issue instead: a cancelled group counts as finished and the next group opens.",
    ],
    links: [],
    after: "The group's issue goes back to the SEO Specialist, who carries on with its pages.",
    check: "manual",
    taskIds: [],
  };
}
