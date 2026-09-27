/**
 * `GET /client-summary`: the SEO line the CRM client workspace shows for one
 * client (a CRM company or contact). Own sprints never appear here.
 */
import type { PluginApiRequestInput, PluginApiResponse } from "@paperclipai/plugin-sdk";
import { parseClientParam, type ClientRef } from "@partnersinbiz/pib-plugin-kit/client-ref";
import * as db from "../db.js";
import { sprintClock } from "../engine/sprint.js";
import { PHASE_NAMES, type SprintPhase } from "../templates/outrank-90.js";
import { planOf } from "../templates/plans.js";
import { resolveAgent } from "./agent.js";
import { companyInfo, type Env } from "./common.js";
import { isActiveSprint, sprintOverviews } from "./overview.js";

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
  const running = sprints.filter(isActiveSprint);
  const paused = sprints.filter((s) => s.status === "paused" && s.seededAt);
  const shown = running.length > 0 ? running : paused;
  if (shown.length === 0) return { headline: "SEO sprint not started (no 90-day plan yet)", stats: [] };

  const info = await companyInfo(env, companyId);
  // The same numbers as the SEO page and the Cockpit (engine/due.ts).
  const overviews = await sprintOverviews(env.ctx.db, companyId, shown, info.today, await resolveAgent(env, companyId));
  const sum = { due: 0, overdue: 0, stuck: 0, waitingOnYou: 0 };
  let keywords = 0;
  const scores: number[] = [];
  for (const sprint of shown) {
    const n = overviews.get(sprint.id)?.numbers;
    if (n) {
      sum.due += n.due;
      sum.overdue += n.overdue;
      sum.stuck += n.stuck;
      sum.waitingOnYou += n.waitingOnYou;
    }
    keywords += (await db.listKeywords(env.ctx.db, companyId, sprint.id)).length;
    const score = (sprint.health as { score?: unknown }).score;
    if (typeof score === "number" && Number.isFinite(score)) scores.push(score);
  }

  const lead = shown[0]!;
  const clock = sprintClock(lead.startDate, info.today);
  const more = shown.length > 1 ? ` (+${shown.length - 1} more sprint${shown.length === 2 ? "" : "s"})` : "";
  const health = scores.length > 0 ? Math.min(...scores) : null;
  const stats: ClientSummary["stats"] = [
    { label: "Due now", value: sum.due },
    { label: "Overdue", value: sum.overdue, tone: sum.overdue > 0 ? "warn" : "ok" },
    ...(sum.stuck > 0 ? [{ label: "Stuck (agent needs attention)", value: sum.stuck, tone: "bad" as const }] : []),
    { label: "Needs you", value: sum.waitingOnYou, tone: sum.waitingOnYou > 0 ? "warn" : "ok" },
    health == null ? { label: "Health", value: "—" } : { label: "Health", value: `${Math.round(health)}/100`, tone: healthTone(health) },
    { label: "Keywords tracked", value: keywords },
  ];
  return { headline: `${sprintHeadline(clock.day, clock.phase, lead.status)} · ${planOf(lead.templateId).label}${more}`, stats };
}

export async function clientSummaryRoute(env: Env, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const client = summaryClient(input.query);
  if (!client) return { status: 400, body: { error: "Pass kind (company or contact) and id (a CRM id)." } };
  return { status: 200, body: await clientSummary(env, input.companyId, client) };
}
