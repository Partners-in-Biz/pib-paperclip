/**
 * Close-out reviews, worker part (Q2-1). The rules and the issue text are in
 * `closeout-model.ts`; the numbers come from `measure.ts` (`readScopeRuns`).
 *
 * Three ways in, all deduplicated by (scope, period) in `closeout_reviews` so a
 * piece of work is reviewed once however often it is noticed:
 * - `project.updated` when a project is set to completed;
 * - `issue.updated` (called from the Cockpit's one handler) when an issue
 *   closes and its whole tree is now closed (an epic finished);
 * - the daily `closeout-sweep`, which also finds finished projects after a
 *   quiet spell and the milestones of evergreen projects.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { agentDesiredSkills, configSaved, createWorkIssue } from "@partnersinbiz/pib-plugin-kit";
import { recordActivity } from "./activity.js";
import { ORIGIN, ORIGIN_ID } from "./constants.js";
import { getRoles, listRoles } from "./db.js";
import type { Env } from "./env.js";
import { message, throwIfEveryCompanyFailed } from "./env.js";
import { agentNames, readScopeRuns } from "./measure.js";
import {
  CLOSEOUT,
  closeoutContent,
  humanWorkSql,
  isEvergreen,
  planProject,
  planTree,
  type CloseoutAgent,
  type CloseoutKind,
  type CloseoutPlan,
  type Cursor,
  type ProjectFacts,
  type TreeFacts,
} from "./closeout-model.js";
import { currentRoles, routeFromRoles } from "./roles.js";
import { NAMESPACE } from "./namespace.js";

const T = `${NAMESPACE}.closeout_reviews`;
type Raw = Record<string, unknown>;

const text = (value: unknown): string | null => (value == null || value === "" ? null : String(value));
const num = (value: unknown): number => Number(value) || 0;
const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (value == null || value === "") return null;
  const t = Date.parse(String(value).includes("T") ? String(value) : String(value).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// ---------------------------------------------------------------------------
// Reading what finished
// ---------------------------------------------------------------------------

const PROJECT_FACTS = `SELECT p.id::text AS id, p.name, p.status, count(i.id)::text AS total,
       count(i.id) FILTER (WHERE i.status NOT IN ('done', 'cancelled'))::text AS open,
       count(i.id) FILTER (WHERE i.status = 'done')::text AS done,
       count(i.id) FILTER (WHERE i.status = 'cancelled')::text AS cancelled,
       min(i.created_at) AS first_created, max(i.created_at) AS last_created, max(i.updated_at) AS last_updated, max(i.completed_at) AS last_completed
  FROM public.projects p
  LEFT JOIN public.issues i ON i.project_id = p.id AND i.company_id = $1::uuid AND i.hidden_at IS NULL AND ${humanWorkSql("i")}`;

function projectFrom(r: Raw): ProjectFacts {
  return {
    projectId: String(r.id),
    name: String(r.name ?? "Project"),
    status: String(r.status ?? ""),
    total: num(r.total),
    open: num(r.open),
    done: num(r.done),
    cancelled: num(r.cancelled),
    firstCreated: iso(r.first_created),
    lastCreated: iso(r.last_created),
    lastUpdated: iso(r.last_updated),
    lastCompleted: iso(r.last_completed),
  };
}

/**
 * Every live project with real work: how many issues, how many are closed, and
 * when it last moved. Routine executions and plugin housekeeping operations are
 * not counted (`humanWorkSql`), so a project made only of those is not listed.
 */
export async function readProjectFacts(ctx: PluginContext, companyId: string): Promise<ProjectFacts[]> {
  const rows = await ctx.db.query<Raw>(`${PROJECT_FACTS} WHERE p.company_id = $2::uuid AND p.archived_at IS NULL GROUP BY p.id, p.name, p.status HAVING count(i.id) > 0 LIMIT 300`, [companyId, companyId]);
  return rows.map(projectFrom);
}

export async function readProjectFact(ctx: PluginContext, companyId: string, projectId: string): Promise<ProjectFacts | null> {
  const rows = await ctx.db.query<Raw>(`${PROJECT_FACTS} WHERE p.company_id = $2::uuid AND p.id = $3::uuid GROUP BY p.id, p.name, p.status`, [companyId, companyId, projectId]);
  return rows[0] ? projectFrom(rows[0]) : null;
}

/** The last review (or baseline) of each project: when, and how many issues were closed then. */
export async function readCursors(ctx: PluginContext, companyId: string): Promise<Map<string, Cursor>> {
  const rows = await ctx.db.query<Raw>(
    `SELECT DISTINCT ON (scope_id) scope_id, period_key, opened_at, closed_count FROM ${T} WHERE company_id = $1 AND scope_kind = 'project' ORDER BY scope_id, opened_at DESC, (period_key = 'baseline') ASC, period_key DESC`,
    [companyId],
  );
  return new Map(rows.map((r) => [String(r.scope_id), { at: iso(r.opened_at) ?? new Date(0).toISOString(), closed: num(r.closed_count), baseline: String(r.period_key) === "baseline" }]));
}

/**
 * The epic an issue belongs to: climbs to the root and counts the tree under
 * it. Null when the issue does not exist in this company.
 */
export async function readTreeFacts(ctx: PluginContext, companyId: string, issueId: string): Promise<TreeFacts | null> {
  const rows = await ctx.db.query<Raw>(
    `WITH RECURSIVE up AS (
       SELECT i.id, i.parent_id, 0 AS depth FROM public.issues i WHERE i.company_id = $1::uuid AND i.id = $2::uuid
       UNION ALL
       SELECT p.id, p.parent_id, up.depth + 1 FROM public.issues p JOIN up ON p.id = up.parent_id AND p.company_id = $3::uuid WHERE up.depth < 20),
     root AS (SELECT id FROM up ORDER BY depth DESC LIMIT 1),
     tree AS (
       SELECT i.id, i.status, i.completed_at, 0 AS depth FROM public.issues i WHERE i.company_id = $4::uuid AND i.id = (SELECT id FROM root)
       UNION ALL
       SELECT c.id, c.status, c.completed_at, tree.depth + 1 FROM public.issues c JOIN tree ON c.parent_id = tree.id AND c.company_id = $5::uuid WHERE tree.depth < 20 AND ${humanWorkSql("c")})
     SELECT (SELECT id::text FROM root) AS root_id, r.identifier, r.title, count(*)::text AS total,
            count(*) FILTER (WHERE tree.status NOT IN ('done', 'cancelled'))::text AS open,
            bool_or(tree.depth = 0 AND tree.status = 'done') AS root_done, max(tree.completed_at) AS last_completed
       FROM tree CROSS JOIN public.issues r WHERE r.id = (SELECT id FROM root) AND r.company_id = $6::uuid AND ${humanWorkSql("r")}
      GROUP BY r.identifier, r.title`,
    [companyId, issueId, companyId, companyId, companyId, companyId],
  );
  const r = rows[0];
  if (!r || !r.root_id) return null;
  return { rootId: String(r.root_id), identifier: text(r.identifier), title: text(r.title), total: num(r.total), open: num(r.open), rootDone: r.root_done === true || r.root_done === "true" || r.root_done === "t", lastCompleted: iso(r.last_completed) };
}

/** Done roots with children that closed or had a child close since `since`: the epics the daily sweep checks. */
export async function readTreeCandidates(ctx: PluginContext, companyId: string, since: string): Promise<string[]> {
  const rows = await ctx.db.query<Raw>(
    `SELECT r.id::text AS id FROM public.issues r
      WHERE r.company_id = $1::uuid AND r.parent_id IS NULL AND r.status = 'done' AND r.hidden_at IS NULL AND ${humanWorkSql("r")}
        AND (r.completed_at >= $2::timestamptz OR EXISTS (SELECT 1 FROM public.issues c WHERE c.parent_id = r.id AND c.company_id = $3::uuid AND c.completed_at >= $4::timestamptz))
        AND EXISTS (SELECT 1 FROM public.issues c2 WHERE c2.parent_id = r.id AND c2.company_id = $5::uuid)
      ORDER BY r.updated_at DESC LIMIT 40`,
    [companyId, since, companyId, since, companyId],
  );
  return rows.map((r) => String(r.id));
}

// ---------------------------------------------------------------------------
// Opening a review
// ---------------------------------------------------------------------------

interface Scope {
  kind: "project" | "tree";
  id: string;
  name: string;
  /** `the Hunt and Gun project`, `the epic PAR-12`. */
  label: string;
  projectId: string | null;
  closed: number;
}

export type OpenResult = { action: "opened"; issueId: string } | { action: "exists" | "skipped"; reason: string } | { action: "failed"; reason: string };

/** Records that a scope was seen, so counting for an evergreen project starts now (no review, no issue). */
async function baseline(env: Env, companyId: string, project: ProjectFacts): Promise<void> {
  await env.ctx.db.execute(
    `INSERT INTO ${T} (company_id, scope_kind, scope_id, period_key, kind, issue_id, scope_name, closed_count, opened_at) VALUES ($1, 'project', $2, 'baseline', 'milestone', NULL, $3, $4, $5) ON CONFLICT (company_id, scope_kind, scope_id, period_key) DO NOTHING`,
    [companyId, project.projectId, project.name.slice(0, 120), project.done + project.cancelled, env.now().toISOString()],
  );
}

async function skillsOf(env: Env, companyId: string, agentId: string): Promise<string[]> {
  try {
    const agent = (await env.ctx.agents.get(agentId, companyId)) as unknown as Record<string, unknown> | null;
    return agent ? agentDesiredSkills(agent).map((k) => k.split("/").pop() ?? k).filter((k) => k !== "paperclip") : [];
  } catch {
    return [];
  }
}

async function openReview(env: Env, companyId: string, scope: Scope, plan: CloseoutPlan, since: string | null): Promise<OpenResult> {
  const now = env.now();
  // Claim the period first: a second event or the sweep finding the same work never opens a second issue.
  const claim = await env.ctx.db.execute(
    `INSERT INTO ${T} (company_id, scope_kind, scope_id, period_key, kind, scope_name, closed_count, opened_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (company_id, scope_kind, scope_id, period_key) DO NOTHING`,
    [companyId, scope.kind, scope.id, plan.periodKey, plan.kind, scope.name.slice(0, 120), scope.closed, now.toISOString()],
  );
  if ((claim.rowCount ?? 0) === 0) return { action: "exists", reason: "This work was already reviewed for this period." };
  try {
    const measured = await readScopeRuns(env.ctx, companyId, { kind: scope.kind, id: scope.id }, since, now);
    const names = await agentNames(env, companyId);
    const agents: CloseoutAgent[] = [];
    for (const a of measured.agents.slice(0, 6)) agents.push({ ...a, name: names.get(a.agentId) ?? null, skills: await skillsOf(env, companyId, a.agentId) });
    const spanDays = measured.issues.createdFirst && measured.issues.completedLast ? (Date.parse(measured.issues.completedLast) - Date.parse(measured.issues.createdFirst)) / 86_400_000 : null;
    const company = await env.ctx.companies.get(companyId).catch(() => null);
    const prefix = company?.issuePrefix ?? null;
    const content = closeoutContent({
      kind: plan.kind,
      scopeName: `${scope.name} (${plan.kind === "milestone" ? `milestone, ${now.toISOString().slice(0, 10)}` : plan.kind === "tree" ? "epic closed" : "finished"})`,
      scopeLabel: scope.label,
      reason: plan.reason,
      fromLabel: since ? `since ${since.slice(0, 10)}` : "since the work began",
      total: measured.total,
      agents,
      issues: measured.issues,
      reopenWakes: measured.reopenWakes,
      unblockWakes: measured.unblockWakes,
      closedPerDay: spanDays && spanDays >= 1 ? (measured.issues.done + measured.issues.cancelled) / spanDays : null,
      prefix,
      projectId: scope.kind === "project" && plan.kind === "final" ? scope.id : null,
    });
    const route = routeFromRoles(await currentRoles(env, companyId), ["operator"]);
    const issue = await createWorkIssue(env.ctx, {
      companyId,
      title: content.title,
      description: content.description,
      priority: "medium",
      originKind: ORIGIN.closeout as `plugin:${string}`,
      originId: `${ORIGIN_ID.closeout}${scope.kind}:${scope.id}:${plan.periodKey}`,
      ...(route.assigneeAgentId ? { assigneeAgentId: route.assigneeAgentId } : route.assigneeUserId ? { assigneeUserId: route.assigneeUserId } : {}),
      wakeReason: `Close-out review: ${scope.name}`,
    });
    await env.ctx.db.execute(`UPDATE ${T} SET issue_id = $5 WHERE company_id = $1 AND scope_kind = $2 AND scope_id = $3 AND period_key = $4`, [companyId, scope.kind, scope.id, plan.periodKey, issue.id]);
    await recordActivity(env.ctx, companyId, {
      key: `closeout:${scope.kind}:${scope.id}:${plan.periodKey}`,
      kind: "closeout",
      at: now.toISOString(),
      text: `Opened a close-out review for ${scope.name} (${plan.kind})`,
      href: `/issues/${issue.id}`,
      agentId: route.assigneeAgentId,
    }).catch(() => false);
    return { action: "opened", issueId: issue.id };
  } catch (error) {
    // Let the next event or sweep try again.
    await env.ctx.db.execute(`DELETE FROM ${T} WHERE company_id = $1 AND scope_kind = $2 AND scope_id = $3 AND period_key = $4 AND issue_id IS NULL`, [companyId, scope.kind, scope.id, plan.periodKey]).catch(() => undefined);
    return { action: "failed", reason: message(error) };
  }
}

const projectScope = (f: ProjectFacts): Scope => ({ kind: "project", id: f.projectId, name: f.name, label: `The ${f.name} project`, projectId: f.projectId, closed: f.done + f.cancelled });

/** Opens the review a project's facts call for (when any). */
export async function reviewProject(env: Env, companyId: string, f: ProjectFacts, options: { cursor?: Cursor | null; explicitlyCompleted?: boolean; quietDays?: number } = {}): Promise<OpenResult> {
  const cursor = options.cursor !== undefined ? options.cursor : (await readCursors(env.ctx, companyId)).get(f.projectId) ?? null;
  const plan = planProject(f, env.now(), cursor, { explicitlyCompleted: options.explicitlyCompleted, quietDays: options.quietDays });
  if (!plan) return { action: "skipped", reason: "Nothing to review yet." };
  // A milestone covers the time since the last review (or since counting began); a final review covers everything since the last real review.
  const since = plan.kind === "milestone" ? cursor?.at ?? null : cursor && !cursor.baseline ? cursor.at : null;
  return openReview(env, companyId, projectScope(f), plan, since);
}

export async function reviewTree(env: Env, companyId: string, t: TreeFacts): Promise<OpenResult> {
  const plan = planTree(t, env.now());
  if (!plan) return { action: "skipped", reason: "The epic is not finished." };
  return openReview(env, companyId, { kind: "tree", id: t.rootId, name: `${t.identifier ?? "Epic"}: ${t.title ?? ""}`.trim(), label: `The epic ${t.identifier ?? ""} "${t.title ?? ""}"`.replace(/\s+/g, " "), projectId: null, closed: t.total }, plan, null);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Only companies whose team is saved: the Cockpit acts for them (the same rule as the System health issue). */
async function actsFor(env: Env, companyId: string): Promise<boolean> {
  return !!(await getRoles(env.ctx, companyId).catch(() => null));
}

/** `project.updated`: a project set to completed gets its final review at once. */
export async function onProjectUpdated(env: Env, event: Pick<PluginEvent, "companyId" | "entityId" | "entityType" | "payload">): Promise<"opened" | "exists" | "ignored"> {
  const companyId = event.companyId;
  const projectId = event.entityType === "project" ? event.entityId ?? null : null;
  const changed = (event.payload as { changedKeys?: unknown } | null)?.changedKeys;
  if (!companyId || !projectId || !Array.isArray(changed) || !changed.includes("status")) return "ignored";
  if (!(await actsFor(env, companyId))) return "ignored";
  const facts = await readProjectFact(env.ctx, companyId, projectId);
  if (!facts || facts.status !== "completed") return "ignored";
  const result = await reviewProject(env, companyId, facts, { explicitlyCompleted: true });
  return result.action === "opened" ? "opened" : result.action === "exists" ? "exists" : "ignored";
}

/**
 * `issue.updated`, called from the Cockpit's one handler: an issue that just
 * closed may have finished its epic. Only a close (`status: done`) is read, so
 * every other update costs nothing.
 */
export async function onIssueClosed(env: Env, event: Pick<PluginEvent, "companyId" | "entityId" | "entityType" | "payload">): Promise<"opened" | "exists" | "ignored"> {
  const companyId = event.companyId;
  const issueId = event.entityType === "issue" ? event.entityId ?? null : null;
  if (!companyId || !issueId || (event.payload as { status?: unknown } | null)?.status !== "done") return "ignored";
  if (!(await actsFor(env, companyId))) return "ignored";
  const tree = await readTreeFacts(env.ctx, companyId, issueId);
  if (!tree) return "ignored";
  const result = await reviewTree(env, companyId, tree);
  return result.action === "opened" ? "opened" : result.action === "exists" ? "exists" : "ignored";
}

// ---------------------------------------------------------------------------
// The daily sweep
// ---------------------------------------------------------------------------

export interface SweepResult {
  opened: number;
  baselined: number;
  skipped: number;
  failed: number;
}

/**
 * One company: finished projects after a quiet spell, evergreen milestones and
 * closed epics the events missed. At most `CLOSEOUT.maxPerSweep` reviews are
 * opened per run, oldest work first.
 */
export async function sweepCompany(env: Env, companyId: string): Promise<SweepResult> {
  const result: SweepResult = { opened: 0, baselined: 0, skipped: 0, failed: 0 };
  const cursors = await readCursors(env.ctx, companyId);
  const projects = (await readProjectFacts(env.ctx, companyId)).sort((a, b) => Date.parse(a.lastCompleted ?? a.lastUpdated ?? "") - Date.parse(b.lastCompleted ?? b.lastUpdated ?? ""));
  for (const project of projects) {
    if (result.opened >= CLOSEOUT.maxPerSweep) break;
    const cursor = cursors.get(project.projectId) ?? null;
    if (!cursor) {
      // Counting starts the first day the Cockpit sees an evergreen project; a finite one is judged on its facts at once.
      const probe = planProject(project, env.now(), null);
      if (!probe) {
        // Only evergreen work is counted from a baseline; a finite project that is not finished yet is simply looked at again tomorrow.
        if (isEvergreen(project)) {
          await baseline(env, companyId, project).catch(() => undefined);
          result.baselined += 1;
        }
        continue;
      }
    }
    const opened = await reviewProject(env, companyId, project, { cursor });
    if (opened.action === "opened") result.opened += 1;
    else if (opened.action === "failed") result.failed += 1;
    else result.skipped += 1;
  }
  const since = new Date(env.now().getTime() - CLOSEOUT.maxAgeDays * 86_400_000).toISOString();
  for (const rootId of await readTreeCandidates(env.ctx, companyId, since)) {
    if (result.opened >= CLOSEOUT.maxPerSweep) break;
    const tree = await readTreeFacts(env.ctx, companyId, rootId);
    if (!tree) continue;
    const opened = await reviewTree(env, companyId, tree);
    if (opened.action === "opened") result.opened += 1;
    else if (opened.action === "failed") result.failed += 1;
  }
  return result;
}

/** Daily job: every company with saved Cockpit settings. */
export async function closeoutSweep(env: Env): Promise<Record<string, number>> {
  const total: Record<string, number> = { companies: 0, opened: 0, baselined: 0, skipped: 0, failed: 0 };
  let failedCompanies = 0;
  for (const row of await listRoles(env.ctx)) {
    if (!(await configSaved(env.ctx, row.companyId))) continue;
    total.companies = (total.companies ?? 0) + 1;
    try {
      const r = await sweepCompany(env, row.companyId);
      for (const [key, value] of Object.entries(r)) total[key] = (total[key] ?? 0) + value;
    } catch (error) {
      failedCompanies += 1;
      total.failed = (total.failed ?? 0) + 1;
      env.ctx.logger.info("Close-out sweep failed for a company", { companyId: row.companyId, error: message(error) });
    }
  }
  throwIfEveryCompanyFailed("The close-out sweep", total.companies ?? 0, failedCompanies);
  return total;
}

// ---------------------------------------------------------------------------
// By hand (the Operator's tool)
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A project by id or by its exact name (case does not matter). `ambiguous` when two projects share the name. */
export async function resolveProject(ctx: PluginContext, companyId: string, ref: string): Promise<{ id: string } | "ambiguous" | null> {
  if (UUID.test(ref)) return { id: ref };
  const rows = await ctx.db.query<Raw>(`SELECT id::text AS id FROM public.projects WHERE company_id = $1::uuid AND archived_at IS NULL AND lower(name) = lower($2) LIMIT 2`, [companyId, ref]);
  if (rows.length > 1) return "ambiguous";
  return rows[0] ? { id: String(rows[0].id) } : null;
}

/** An issue by id or by its identifier (`PAR-12`). */
export async function resolveIssue(ctx: PluginContext, companyId: string, ref: string): Promise<string | null> {
  if (UUID.test(ref)) return ref;
  const rows = await ctx.db.query<Raw>(`SELECT id::text AS id FROM public.issues WHERE company_id = $1::uuid AND upper(identifier) = upper($2) LIMIT 1`, [companyId, ref]);
  return rows[0] ? String(rows[0].id) : null;
}

/**
 * Opens the review for one project (`projectId`: its id or exact name) or the
 * epic an issue belongs to (`issueId`: its id or identifier such as `PAR-12`)
 * now, whatever its state: for a project the Operator judges is done, or a
 * milestone it wants to look at. Deduplicated for the day.
 */
export async function openCloseoutNow(env: Env, companyId: string, input: { projectId?: string; issueId?: string }): Promise<OpenResult & { kind?: CloseoutKind }> {
  const now = env.now();
  if (input.projectId) {
    const found = await resolveProject(env.ctx, companyId, input.projectId);
    if (found === "ambiguous") return { action: "skipped", reason: `Two projects are named "${input.projectId}". Pass the project id (a uuid from the measure report).` };
    const f = found ? await readProjectFact(env.ctx, companyId, found.id) : null;
    if (!f || f.total === 0) return { action: "skipped", reason: "That project was not found in this company (pass its id or its exact name), or it has no issues of real work (routine runs and plugin housekeeping are not counted)." };
    const plan: CloseoutPlan = { kind: "milestone", periodKey: `manual:${now.toISOString().slice(0, 10)}`, reason: "The Operator asked for a review." };
    const cursor = (await readCursors(env.ctx, companyId)).get(f.projectId) ?? null;
    return { ...(await openReview(env, companyId, projectScope(f), plan, cursor?.at ?? null)), kind: "milestone" };
  }
  if (input.issueId) {
    const issueId = await resolveIssue(env.ctx, companyId, input.issueId);
    const t = issueId ? await readTreeFacts(env.ctx, companyId, issueId) : null;
    if (!t) return { action: "skipped", reason: "That issue was not found in this company, or it is automated housekeeping (pass its id or its identifier, such as PAR-12)." };
    const plan: CloseoutPlan = { kind: "tree", periodKey: `manual:${now.toISOString().slice(0, 10)}`, reason: `The Operator asked for a review of ${t.identifier ?? "the epic"} and the ${Math.max(0, t.total - 1)} issues under it.` };
    return { ...(await openReview(env, companyId, { kind: "tree", id: t.rootId, name: `${t.identifier ?? "Epic"}: ${t.title ?? ""}`.trim(), label: `The epic ${t.identifier ?? ""} "${t.title ?? ""}"`.replace(/\s+/g, " "), projectId: null, closed: t.total }, plan, null)), kind: "tree" };
  }
  return { action: "skipped", reason: "Pass projectId or issueId." };
}
