/**
 * The "Needs you" digest: one Paperclip issue per sprint per week listing
 * only what a person truly has to do (one-time grants, out-of-scope PRs,
 * messages from personal accounts). Pure: merge, resolve, render.
 */
import { addDays } from "./time.js";
import { sprintLabel, withClientPrefix, type SprintCopy } from "./copy.js";

/** How the plugin knows an item is done without asking. `manual` = a person says so. */
export type NeedsYouCheck = "manual" | "site_project" | "service_account" | "gsc_access" | "bing_key" | "github_token" | "task_done";

export type NeedsYouKind = "grant" | "review" | "pr" | "message" | "task" | "indexing";

export interface NeedsYouLink {
  label: string;
  url: string;
}

export interface NeedsYouItem {
  /** Stable key; adding an item with the same key updates it (dedupe). */
  key: string;
  kind: NeedsYouKind;
  title: string;
  why: string;
  steps: string[];
  links: NeedsYouLink[];
  /** What the agent does once this is done. */
  after: string;
  /** Copy-ready text (email, DM, post) when the item is a message. */
  copy?: string | null;
  check: NeedsYouCheck;
  /** Tasks to resume (issue back to the agent) when the item is done. */
  taskIds?: string[];
  optional?: boolean;
  status: "open" | "done";
  addedAt: string;
  doneAt?: string | null;
  doneBy?: string | null;
  note?: string | null;
}

export type NewNeedsYouItem = Omit<NeedsYouItem, "status" | "addedAt" | "doneAt" | "doneBy">;

/** Monday of the week containing `date` (YYYY-MM-DD). */
export function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  return addDays(date, offset);
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Add or update an item. An open item keeps its place and gains the new
 * text and tasks; a done item is reopened only when `reopen` is set.
 */
export function mergeItem(items: NeedsYouItem[], item: NewNeedsYouItem, now: string, opts: { reopen?: boolean } = {}): { items: NeedsYouItem[]; changed: boolean; added: boolean } {
  const index = items.findIndex((i) => i.key === item.key);
  if (index < 0) {
    return { items: [...items, { ...item, taskIds: uniq(item.taskIds ?? []), status: "open", addedAt: now, doneAt: null, doneBy: null }], changed: true, added: true };
  }
  const current = items[index]!;
  if (current.status === "done" && !opts.reopen) return { items, changed: false, added: false };
  const next: NeedsYouItem = {
    ...current,
    ...item,
    taskIds: uniq([...(current.taskIds ?? []), ...(item.taskIds ?? [])]),
    status: "open",
    addedAt: current.status === "done" ? now : current.addedAt,
    doneAt: null,
    doneBy: null,
  };
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  const out = [...items];
  out[index] = next;
  return { items: out, changed, added: false };
}

export function resolveItem(items: NeedsYouItem[], key: string, by: string, now: string, note?: string | null): { items: NeedsYouItem[]; resolved: NeedsYouItem | null } {
  const index = items.findIndex((i) => i.key === key && i.status === "open");
  if (index < 0) return { items, resolved: null };
  const resolved: NeedsYouItem = { ...items[index]!, status: "done", doneAt: now, doneBy: by, note: note ?? items[index]!.note ?? null };
  const out = [...items];
  out[index] = resolved;
  return { items: out, resolved };
}

export function openItems(items: NeedsYouItem[]): NeedsYouItem[] {
  return items.filter((i) => i.status === "open");
}

/** Open items carried from last week's digest into this week's. */
export function carryOver(previous: NeedsYouItem[], current: NeedsYouItem[]): NeedsYouItem[] {
  const keys = new Set(current.map((i) => i.key));
  return [...current, ...openItems(previous).filter((i) => !keys.has(i.key))];
}

export function needsYouTitle(sprint: Pick<SprintCopy, "siteName" | "clientName">, week: string): string {
  const title = withClientPrefix(`Needs you: SEO ${sprintLabel(sprint)} (week of ${week})`, sprint.clientName);
  return title.length > 240 ? `${title.slice(0, 237)}…` : title;
}

export function needsYouDescription(sprint: SprintCopy, items: NeedsYouItem[], input: { week: string; cockpitPath: string | null }): string {
  const open = openItems(items);
  const required = open.filter((i) => !i.optional);
  const optional = open.filter((i) => i.optional);
  const done = items.filter((i) => i.status === "done");
  const lines: string[] = [
    `The SEO Specialist runs this sprint on its own. These are the only things it cannot do for **${sprint.siteName}** — each one is needed once. Week of ${input.week}.`,
    "",
  ];
  if (open.length === 0) lines.push("Nothing needs you right now.", "");
  let n = 0;
  const render = (item: NeedsYouItem) => {
    n += 1;
    lines.push(`### ${n}. ${item.title}${item.optional ? " (optional)" : ""}`, "", item.why, "");
    if (item.steps.length > 0) {
      item.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
      lines.push("");
    }
    if (item.links.length > 0) lines.push(item.links.map((l) => `[${l.label}](${l.url})`).join(" · "), "");
    if (item.copy && item.copy.trim()) lines.push("Copy-ready text:", "", "```text", item.copy.trim(), "```", "");
    lines.push(`**Then the agent:** ${item.after}`, "", `<sub>key: \`${item.key}\`${item.check !== "manual" ? " · closes on its own once the plugin sees it done" : ""}</sub>`, "");
  };
  required.forEach(render);
  if (optional.length > 0) {
    lines.push("---", "", "**Optional**", "");
    optional.forEach(render);
  }
  if (done.length > 0) {
    lines.push("---", "", "**Done**", "", ...done.map((i) => `- ~~${i.title}~~${i.doneAt ? ` (${i.doneAt.slice(0, 10)}${i.doneBy ? `, ${i.doneBy}` : ""})` : ""}`), "");
  }
  lines.push(
    input.cockpitPath
      ? `Mark an item done on [SEO → this sprint → Integrations](${input.cockpitPath}&tab=integrations), or close this issue when every item is done: the agent re-checks each item and carries on.`
      : "Mark an item done on the SEO page → this sprint → Integrations, or close this issue when every item is done: the agent re-checks each item and carries on.",
  );
  return lines.join("\n");
}
