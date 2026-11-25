/**
 * Where a campaign stands, in plain words, and what needs a person. The list,
 * the "Needs attention" strip and the campaign screen all read this one
 * function, so they never disagree. Pure: the worker gathers the facts.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { CAMPAIGN_ORIGINS, parsePairOrigin } from "./origins.js";
import { PLUGIN_ID } from "./namespace.js";
import type { TaskCounts } from "./people.js";

export type CampaignStateKey =
  | "no-emails"
  | "draft"
  | "sent-back"
  | "with-reviewer"
  | "waiting-approval"
  | "approval-unknown"
  | "could-not-launch"
  | "launching"
  | "stuck"
  | "running"
  | "unchecked"
  | "scheduled"
  | "paused"
  | "finished";

export type StateTone = "ok" | "warn" | "bad" | "info" | "neutral";

export interface CampaignFacts {
  status: string;
  /** Steps counted by position (an A and a B version are one step). */
  stepCount: number;
  approvalIssueId: string | null;
  /** Status of the approval task. Null when there is none, and also when it could not be read: with an `approvalIssueId` that means "cannot tell". */
  approvalStatus: string | null;
  /** The approval task is still with an agent (the Reviewer looks first). */
  approvalWithAgent: boolean;
  launchError: string | null;
  stats: { enrolled: number; running: number; done: number };
  /** Emails sent so far (step events), or null when they could not be counted. A null is never shown as 0. */
  sent: number | null;
  /** Open step tasks of this campaign, or null when it has none. */
  tasks: TaskCounts | null;
  /** Step emails the Mailbox gave up on. */
  failedSends: number;
  /** The open step tasks and the failed sends were both read. False means "could not check": no all-clear is claimed. */
  sendsChecked: boolean;
  /** Per step number, what was never filled in ("NOT-ISSUED-YET", "{{code}}"). Only read for a running campaign. */
  placeholders: Array<{ number: number; items: string[] }>;
  /** An open "Revise campaign" task exists: a person sent the draft back. */
  reviseOpen: boolean;
}

export interface CampaignState {
  key: CampaignStateKey;
  /** One or two words for the pill. */
  label: string;
  tone: StateTone;
  /** One sentence under the pill: what is going on. Null when the label says it all. */
  detail: string | null;
  /** A person has something to do or to know. Feeds the "Needs attention" strip. */
  attention: string | null;
}

const DAY_MS = 86_400_000;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function daysText(sinceIso: string | null, now: Date): string | null {
  const since = sinceIso ? Date.parse(sinceIso) : Number.NaN;
  if (!Number.isFinite(since)) return null;
  const days = Math.floor((now.getTime() - since) / DAY_MS);
  return days >= 1 ? `for ${plural(days, "day")}` : null;
}

/** "Email 1 still says NOT-ISSUED-YET" from the unfilled placeholders of each step. */
export function placeholderText(placeholders: CampaignFacts["placeholders"]): string | null {
  const first = placeholders.find((entry) => entry.items.length > 0);
  if (!first) return null;
  const more = placeholders.filter((entry) => entry.items.length > 0).length - 1;
  return `Email ${first.number} still says ${first.items.slice(0, 2).join(" and ")}${more > 0 ? ` (and ${plural(more, "other email")} too)` : ""}`;
}

export function campaignState(facts: CampaignFacts, now: Date = new Date()): CampaignState {
  const { status, stats } = facts;
  const people = plural(stats.enrolled, "person", "people");
  if (status === "completed") {
    const detail = !stats.enrolled ? null : facts.sent === null ? `It went to ${people}.` : `${plural(facts.sent, "email")} sent to ${people}.`;
    return { key: "finished", label: "Finished", tone: "neutral", detail, attention: null };
  }
  if (status === "paused") {
    return { key: "paused", label: "Paused", tone: "warn", detail: `Nothing goes out until it is resumed. ${plural(stats.running, "person", "people")} part-way.`, attention: null };
  }
  if (status === "scheduled") return { key: "scheduled", label: "Scheduled", tone: "info", detail: null, attention: null };

  if (status === "draft") {
    if (facts.stepCount === 0) return { key: "no-emails", label: "Draft", tone: "neutral", detail: "No emails written yet.", attention: null };
    if (!facts.approvalIssueId) {
      if (facts.reviseOpen) return { key: "sent-back", label: "Sent back", tone: "info", detail: "The agent is fixing it and will ask for approval again.", attention: null };
      return { key: "draft", label: "Draft", tone: "neutral", detail: "Not sent for approval yet.", attention: null };
    }
    if (facts.launchError) {
      return { key: "could-not-launch", label: "Could not launch", tone: "bad", detail: facts.launchError, attention: `Approved but it could not launch: ${facts.launchError}` };
    }
    // The approval task could not be read: neither "approved" nor "needs you" is known.
    if (facts.approvalStatus === null) {
      return { key: "approval-unknown", label: "Approval asked", tone: "neutral", detail: "Its approval task could not be read just now. Reload the page.", attention: null };
    }
    // While an agent holds the task it is not a person's decision yet, also when that agent closed it (the close is handed to a person).
    if (facts.approvalWithAgent) return { key: "with-reviewer", label: "With the reviewer", tone: "info", detail: "The Reviewer checks it first, then it comes to you.", attention: null };
    if (facts.approvalStatus === "done") return { key: "launching", label: "Approved", tone: "ok", detail: "Approved. It starts soon; if it cannot, this page says why.", attention: null };
    return { key: "waiting-approval", label: "Needs your approval", tone: "warn", detail: "Read the emails, then approve or send back.", attention: "Waiting for your approval" };
  }

  // Active. A problem that was read is reported even when another read failed.
  const problems: string[] = [];
  const blocked = facts.tasks?.blocked ?? 0;
  const waiting = facts.tasks?.waiting ?? 0;
  const placeholder = placeholderText(facts.placeholders);
  if (blocked > 0) {
    const since = daysText(facts.tasks?.oldestAt ?? null, now);
    problems.push(`${plural(blocked, "email")} held${since ? ` ${since}` : ""}: ${blocked === 1 ? "its task is" : "their tasks are"} blocked`);
  } else if (waiting > 0 && facts.tasks?.oldestAt && now.getTime() - Date.parse(facts.tasks.oldestAt) > DAY_MS) {
    problems.push(`${plural(waiting, "email")} waiting on the agent ${daysText(facts.tasks.oldestAt, now) ?? "for over a day"}`);
  }
  if (facts.failedSends > 0) problems.push(`${plural(facts.failedSends, "email")} could not be sent`);
  // "Nothing sent yet" counts only when the sends were counted: an unknown count never makes a campaign stuck.
  if (placeholder && (blocked > 0 || waiting > 0 || facts.failedSends > 0 || facts.sent === 0)) problems.push(placeholder);
  if (problems.length > 0) {
    const text = `${problems.join(". ")}.`;
    return { key: "stuck", label: "Stuck", tone: "bad", detail: text, attention: text };
  }
  // The tasks or the failed sends could not be read: do not call it running.
  if (!facts.sendsChecked) {
    return { key: "unchecked", label: "Active", tone: "neutral", detail: "Whether its emails are going out could not be checked just now. Reload the page.", attention: null };
  }
  const tail = `${stats.done ? `, ${stats.done} finished` : ""}${waiting ? `, ${waiting} waiting on the agent` : ""}.`;
  const progress = !stats.enrolled ? "Nobody is enrolled." : facts.sent === null ? `${people} enrolled${tail}` : `${plural(facts.sent, "email")} sent to ${people}${tail}`;
  return { key: "running", label: "Running", tone: "ok", detail: progress, attention: null };
}

/** Campaign ids that have an open "Revise campaign" task (a person sent the draft back). */
export async function openReviseCampaigns(ctx: PluginContext, companyId: string): Promise<Set<string>> {
  const rows = await ctx.db.query<{ origin_id: string | null }>(
    `SELECT i.origin_id
       FROM public.issues i
      WHERE i.company_id = $1::uuid AND i.origin_kind = $2 AND i.origin_id LIKE $3 AND i.status NOT IN ('done', 'cancelled')
      LIMIT 500`,
    [companyId, `plugin:${PLUGIN_ID}`, `${CAMPAIGN_ORIGINS.revise}%`],
  );
  const ids = new Set<string>();
  for (const row of rows) {
    const parsed = parsePairOrigin(row.origin_id, CAMPAIGN_ORIGINS.revise);
    if (parsed) ids.add(parsed.id);
  }
  return ids;
}

/** Failed step emails per campaign (the Mailbox gave up and a person has not dealt with it yet). */
export function failedByCampaign(rows: Array<{ campaignId: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.campaignId, (counts.get(row.campaignId) ?? 0) + 1);
  return counts;
}
