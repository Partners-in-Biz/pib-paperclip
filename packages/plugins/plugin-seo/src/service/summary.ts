/**
 * `GET /client-summary`: the SEO line the CRM client workspace shows for one
 * client (a CRM company or contact). Own sprints never appear here.
 */
import type { PluginApiRequestInput, PluginApiResponse } from "@paperclipai/plugin-sdk";
import { parseClientParam, type ClientRef } from "@partnersinbiz/pib-plugin-kit/client-ref";
import * as db from "../db.js";
import { isRunning, OPEN_TASK_STATUSES, sprintClock } from "../engine/sprint.js";
import { PHASE_NAMES, type SprintPhase } from "../templates/outrank-90.js";
import { companyInfo, type Env } from "./common.js";

export interface ClientSummary {
  headline: string;
  stats: Array<{ label: string; value: string | number; tone?: "ok" | "warn" | "bad" }>;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

/** `kind` + `id` from the query, or null when either is not a valid client reference. */
export function summaryClient(query: PluginApiRequestInput["query"]): ClientRef | null {
  const kind = first(query.kind);
  const id = first(query.id);
  if (!kind || !id) return null;
  return parseClientParam(`${kind}:${id}`);
}

export function sprintHeadline(day: number, phase: number, status: string): string {
  const phaseName = PHASE_NAMES[Math.min(Math.max(phase, 0), 4) as SprintPhase];
  const when = day < 0 ? `Starts in ${-day} day${day === -1 ? "" : "s"}` : day <= 90 ? `Day ${day}/90` : `Day ${day}`;
  return `${status === "paused" ? "Paused · " : ""}${when} · ${phaseName}`;
}

function healthTone(score: number): "ok" | "warn" | "bad" {
  return score >= 70 ? "ok" : score >= 40 ? "warn" : "bad";
}

export async function clientSummary(env: Env, companyId: string, client: ClientRef): Promise<ClientSummary> {
  const sprints = (await db.listSprints(env.ctx.db, companyId, { scope: client })).filter((s) => s.status !== "archived");
  if (sprints.length === 0) return { headline: "No SEO sprint", stats: [] };
  const running = sprints.filter((s) => isRunning(s.status) && s.seededAt);
  const paused = sprints.filter((s) => s.status === "paused" && s.seededAt);
  const shown = running.length > 0 ? running : paused;
  if (shown.length === 0) return { headline: "SEO sprint not started (no 90-day plan yet)", stats: [] };

  const info = await companyInfo(env, companyId);
  let dueToday = 0;
  let overdue = 0;
  let blocked = 0;
  let keywords = 0;
  const scores: number[] = [];
  for (const sprint of shown) {
    const { day } = sprintClock(sprint.startDate, info.today);
    const [tasks, tracked] = await Promise.all([
      db.listTasks(env.ctx.db, companyId, sprint.id, { status: OPEN_TASK_STATUSES }),
      db.listKeywords(env.ctx.db, companyId, sprint.id),
    ]);
    for (const task of tasks) {
      if (task.status === "blocked") {
        blocked += 1;
        continue;
      }
      // Tasks without a due day are due at launch (day 0).
      const due = task.dueDay ?? 0;
      if (due === day || (due > day && task.dueDay == null)) dueToday += 1;
      else if (due < day) overdue += 1;
    }
    keywords += tracked.length;
    const score = (sprint.health as { score?: unknown }).score;
    if (typeof score === "number" && Number.isFinite(score)) scores.push(score);
  }

  const lead = shown[0]!;
  const clock = sprintClock(lead.startDate, info.today);
  const more = shown.length > 1 ? ` (+${shown.length - 1} more sprint${shown.length === 2 ? "" : "s"})` : "";
  const health = scores.length > 0 ? Math.min(...scores) : null;
  return {
    headline: `${sprintHeadline(clock.day, clock.phase, lead.status)}${more}`,
    stats: [
      { label: "Due today", value: dueToday },
      { label: "Overdue", value: overdue, tone: overdue > 0 ? "warn" : "ok" },
      { label: "Blocked", value: blocked, tone: blocked > 0 ? "warn" : "ok" },
      health == null ? { label: "Health", value: "—" } : { label: "Health", value: `${Math.round(health)}/100`, tone: healthTone(health) },
      { label: "Keywords tracked", value: keywords },
    ],
  };
}

export async function clientSummaryRoute(env: Env, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const client = summaryClient(input.query);
  if (!client) return { status: 400, body: { error: "Pass kind (company or contact) and id (a CRM id)." } };
  return { status: 200, body: await clientSummary(env, input.companyId, client) };
}
