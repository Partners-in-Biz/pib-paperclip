/**
 * Approval routing that cannot end unassigned (Q5-6).
 *
 * What went wrong live. The four CRM sequence approvals (PAR-456..459, cold
 * email) and 13 accounting approvals were opened with no assignee at all, so
 * nobody was told and the Reviewer never saw outward mail. The cause was not
 * the agent tool-call context the audit suspected. Every plugin keeps a copy
 * of the Cockpit's roles (`registerRoleWatch`), and from 2026-09-27 06:32 to
 * 2026-10-02 ~12:00 every copy was stuck on the very first broadcast (owner
 * null, `reviewOutward` false): the watch compared `updatedAt` as text, the
 * first stamp was ISO ("...T06:32:49Z") and every later one Postgres text
 * ("... 18:46:11+00"), and "T" sorts after " ", so each later broadcast
 * looked older and was dropped (DB dumps of 09-30 10:36, 09-30 11:36 and
 * 10-01 15:39 all show it). With no owner and no Reviewer in the copy, the
 * lookup returned nothing in EVERY context. Approvals a person clicked in the
 * UI still got an owner only because Accounting falls back to the clicking
 * user; an agent actor has none.
 *
 * What this module does. `resolveApprover` never depends on that copy being
 * fresh: Reviewer (outward work, when the company reviews it), then the owner
 * from the roles copy, the host's own default responsible user, the person
 * who triggered the work, the last owner ever seen; then the Operator, who
 * asks the owner; and only then nobody, which is loud: the issue says so, the
 * worker logs it, and `unroutedApprovalsCheck` turns the Cockpit red.
 * `openApprovalIssue` is the one call a plugin makes to open an approval.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  assignableUserId,
  ownerUserFor,
  readCompanyRoles,
  reviewerBrief,
  roleAgentUsable,
  stampMs,
  type HealthCheck,
  type OwnerSource,
} from "./cockpit.js";
import { createWorkIssue } from "./issues.js";

export type ApprovalVia = "reviewer" | "owner" | "operator" | "unrouted";

export interface ApproverRoute {
  /** The Reviewer to check outward work first; null for work a person alone decides, or when there is no usable Reviewer. */
  reviewerAgentId: string | null;
  /** The person who decides. Null only when the company has no known person at all. */
  approverUserId: string | null;
  /** The running Operator, if any: where the approval goes when no person was found (or the host refuses the person), so it asks the owner (`ask-owner`) instead of sitting unseen. */
  escalationAgentId: string | null;
  via: ApprovalVia;
  ownerSource: OwnerSource | null;
  /** Things found on the way ("the roles copy is 9 h old"), for the issue note and the logs. */
  notes: string[];
}

/** A roles copy older than this means the Cockpit's hourly broadcast is not arriving. */
export const ROLES_COPY_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/**
 * Who decides an approval for this company. Reads the roles copy once, then
 * walks the fallback chain described in the module header. Never throws.
 * `outward` is work that leaves the company (email, posts, invoices): the
 * Reviewer checks it first when the company reviews outward work.
 */
export async function resolveApprover(
  ctx: PluginContext,
  companyId: string,
  options: { outward?: boolean; actorUserId?: string | null; now?: number } = {},
): Promise<ApproverRoute> {
  const notes: string[] = [];
  const read = await readCompanyRoles(ctx, companyId, options.now);
  const roles = read.roles;
  if (read.error) notes.push(`the roles copy could not be read (${read.error})`);
  else if (!roles) notes.push("this plugin has no copy of the company's team roles yet");
  else {
    if (!assignableUserId(roles.ownerUserId)) notes.push("the roles copy has no owner");
    if (read.ageMs !== null && read.ageMs > ROLES_COPY_MAX_AGE_MS) notes.push(`the roles copy is ${Math.round(read.ageMs / 3_600_000)} h old`);
  }
  const reviewer = options.outward === true && roles?.reviewOutward && roles.reviewerAgentId && roleAgentUsable(roles.reviewerStatus) ? roles.reviewerAgentId : null;
  const owner = await ownerUserFor(ctx, companyId, { roles, actorUserId: options.actorUserId, lastKnown: true });
  if (owner.source && owner.source !== "roles") notes.push(`the approver comes from ${ownerSourceLabel(owner.source)}`);
  const operator = roles?.operatorAgentId && roleAgentUsable(roles.operatorStatus) ? roles.operatorAgentId : null;
  const via: ApprovalVia = reviewer ? "reviewer" : owner.userId ? "owner" : operator ? "operator" : "unrouted";
  return {
    reviewerAgentId: reviewer,
    approverUserId: owner.userId,
    escalationAgentId: operator,
    via,
    ownerSource: owner.source,
    notes,
  };
}

function ownerSourceLabel(source: OwnerSource): string {
  if (source === "company-default") return "the company's default responsible user";
  if (source === "actor") return "the person who triggered it";
  if (source === "last-known") return "the last owner this plugin saw";
  return "the Cockpit's roles";
}

export interface ApprovalIssueInput {
  companyId: string;
  title: string;
  description: string;
  /** `plugin:<pluginKey>`; the plugin's own origin kind. */
  originKind: string;
  originId: string;
  projectId?: string;
  priority?: "low" | "medium" | "high" | "critical";
  /** Work that leaves the company (email, posts, invoices, quotes): the Reviewer checks it first when the company reviews outward work. */
  outward?: boolean;
  /** The person who triggered it from a page, when there is one (a last-resort approver). */
  actorUserId?: string | null;
  /** Text appended for the Reviewer when it gets the issue first (kit `reviewerBrief`). Receives the resolved route. */
  reviewerBrief?: (route: ApproverRoute) => string;
  wakeReason?: string;
}

export type ApprovalAssignedTo = "reviewer" | "person" | "operator" | "nobody";

export interface ApprovalIssueResult {
  id: string;
  assignedTo: ApprovalAssignedTo;
  route: ApproverRoute;
  woke: boolean;
}

type CreateInput = Parameters<typeof createWorkIssue>[1];

/** Appended to an approval that has no person to go to, so the issue itself says what is wrong. */
export function unroutedNote(route: ApproverRoute, to: "operator" | "nobody"): string {
  const why = route.notes.length ? ` (${route.notes.join("; ")})` : "";
  return to === "operator"
    ? `\n\n> **No approver found${why}.** This approval went to the Operator instead of a person. Operator: ask the owner with \`partnersinbiz.cockpit:ask-owner\` (kind \`decision\`, link this issue), and tell them to set the owner in Setup → Team. Only a person can approve.`
    : `\n\n> **Unrouted${why}.** Nobody could be found to decide this approval, so it opened unassigned. A board member: assign it to the approver, and set the owner in Setup → Team so approvals stop opening unassigned.`;
}

/**
 * Opens an approval issue with a guaranteed route: the Reviewer first for
 * outward work, else the person who decides, else the Operator, else (loudly)
 * nobody. If the host refuses an assignee (a user who left) the next one in the
 * chain is tried, so the approval is never lost and never silent. Plugins call
 * this instead of reading the roles themselves.
 */
export async function openApprovalIssue(ctx: PluginContext, input: ApprovalIssueInput): Promise<ApprovalIssueResult> {
  const route = await resolveApprover(ctx, input.companyId, { outward: input.outward, actorUserId: input.actorUserId });
  const base = { companyId: input.companyId, title: input.title, originKind: input.originKind, originId: input.originId } as unknown as CreateInput;
  const extras: Partial<CreateInput> = { ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.priority ? { priority: input.priority } : {}) };
  const attempts: Array<{ to: ApprovalAssignedTo; description: string; assignee: Partial<CreateInput>; wake: boolean }> = [];
  if (route.reviewerAgentId) {
    attempts.push({ to: "reviewer", description: input.reviewerBrief ? `${input.description}\n${input.reviewerBrief(route)}` : input.description, assignee: { assigneeAgentId: route.reviewerAgentId }, wake: true });
  }
  if (route.approverUserId) attempts.push({ to: "person", description: input.description, assignee: { assigneeUserId: route.approverUserId }, wake: false });
  if (route.escalationAgentId) attempts.push({ to: "operator", description: `${input.description}${unroutedNote(route, "operator")}`, assignee: { assigneeAgentId: route.escalationAgentId }, wake: true });
  attempts.push({ to: "nobody", description: `${input.description}${unroutedNote(route, "nobody")}`, assignee: {}, wake: false });

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const created = await createWorkIssue(ctx, { ...base, ...extras, description: attempt.description, ...attempt.assignee, wake: attempt.wake, ...(input.wakeReason ? { wakeReason: input.wakeReason } : {}) } as CreateInput & { wake?: boolean; wakeReason?: string });
      if (attempt.to === "operator" || attempt.to === "nobody") {
        ctx.logger.warn("Approval opened without a person to decide it", { companyId: input.companyId, issueId: created.id, title: input.title, assignedTo: attempt.to, notes: route.notes });
      }
      return { id: created.id, assignedTo: attempt.to, route, woke: created.woke };
    } catch (error) {
      lastError = error;
      ctx.logger.info("Approval assignee refused; trying the next route", { title: input.title, tried: attempt.to, error: error instanceof Error ? error.message : String(error) });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------------------
// Finding approvals nobody is looking at
// ---------------------------------------------------------------------------

const APPROVAL_TITLE = /^\s*(approve|review|sign[- ]?off)\b/i;

/** An issue a plugin opened for a person to decide (by title or origin), as opposed to work for an agent. */
export function isApprovalIssue(issue: { title?: string | null; originKind?: string | null; originId?: string | null }): boolean {
  if (APPROVAL_TITLE.test(issue.title ?? "")) return true;
  if (/:approvals?$/.test(issue.originKind ?? "")) return true;
  return /(^|[:_-])approv/i.test(issue.originId ?? "");
}

export interface UnroutedApproval {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  createdAt: string | null;
  ageMs: number;
}

/** Statuses an unassigned approval can sit in unseen. */
const WATCHED_STATUSES = ["todo", "backlog", "blocked", "in_review"] as const;

/** Approval issues with neither an agent nor a person assigned, older than `minAgeMs` (default 1 h). */
export async function findUnroutedApprovals(
  ctx: PluginContext,
  companyId: string,
  options: { now?: number; minAgeMs?: number; limit?: number } = {},
): Promise<UnroutedApproval[]> {
  const now = options.now ?? Date.now();
  const minAge = options.minAgeMs ?? 3_600_000;
  const found: UnroutedApproval[] = [];
  for (const status of WATCHED_STATUSES) {
    const issues = (await ctx.issues.list({ companyId, originKindPrefix: "plugin:", status, limit: options.limit ?? 200 })) as unknown as Array<Record<string, unknown>>;
    for (const issue of issues) {
      if (issue.assigneeAgentId || issue.assigneeUserId) continue;
      if (!isApprovalIssue({ title: String(issue.title ?? ""), originKind: (issue.originKind as string | null) ?? null, originId: (issue.originId as string | null) ?? null })) continue;
      const created = stampMs(issue.createdAt);
      const ageMs = Number.isFinite(created) ? now - created : minAge;
      if (ageMs < minAge) continue;
      found.push({ id: String(issue.id), identifier: typeof issue.identifier === "string" ? issue.identifier : null, title: String(issue.title ?? ""), status, createdAt: Number.isFinite(created) ? new Date(created).toISOString() : null, ageMs });
    }
  }
  return found.sort((a, b) => b.ageMs - a.ageMs);
}

/**
 * Cockpit health check: approvals that have sat unassigned for over an hour.
 * Red while any exist, with the issue ids, so a person (or `repairUnroutedApprovals`)
 * can hand them to the approver. Never throws; an unreadable list is a warning (a watchdog that cannot see says so).
 */
export async function unroutedApprovalsCheck(ctx: PluginContext, companyId: string, options: { now?: number; minAgeMs?: number } = {}): Promise<HealthCheck> {
  const key = "approvals:unrouted";
  const title = "Approvals with nobody to decide them";
  let unrouted: UnroutedApproval[];
  try {
    unrouted = await findUnroutedApprovals(ctx, companyId, options);
  } catch (error) {
    // A watchdog that cannot see must say so: "ok" here would read as "no unassigned approvals".
    return { key, title, status: "warn", detail: `Could not look for unassigned approvals (${error instanceof Error ? error.message : String(error)}), so it cannot tell whether any are waiting.`, fix: "Check the plugin can read issues for this company (its settings are saved and issues.read is granted)." };
  }
  if (unrouted.length === 0) return { key, title, status: "ok" };
  const names = unrouted.slice(0, 5).map((a) => `${a.identifier ?? a.id}: ${a.title.slice(0, 60)}`);
  return {
    key,
    title,
    status: "bad",
    detail: `${unrouted.length} approval${unrouted.length === 1 ? " has" : "s have"} had nobody assigned for over an hour (${names.join("; ")}${unrouted.length > 5 ? "; ..." : ""}). Nothing waits on the owner for them, so they are not being decided.`,
    fix: "Assign each to the approver (the owner), then open Setup → Team and check the owner is set. The Operator can run the approval repair.",
    href: "/setup?section=team",
    since: unrouted[0]?.createdAt ?? null,
  };
}

/**
 * Hands unassigned approvals to the person who decides, with a comment. Run it
 * from a job that already acts for the company. Returns what it did.
 */
export async function repairUnroutedApprovals(
  ctx: PluginContext,
  companyId: string,
  options: { now?: number; minAgeMs?: number } = {},
): Promise<{ repaired: string[]; stillUnrouted: string[] }> {
  const unrouted = await findUnroutedApprovals(ctx, companyId, options);
  const route = await resolveApprover(ctx, companyId, { outward: false });
  const repaired: string[] = [];
  const stillUnrouted: string[] = [];
  for (const approval of unrouted) {
    if (!route.approverUserId) {
      stillUnrouted.push(approval.id);
      continue;
    }
    try {
      // A backlog issue assigned to someone may not reach their inbox; todo does.
      await ctx.issues.update(approval.id, { assigneeUserId: route.approverUserId, ...(approval.status === "backlog" ? { status: "todo" } : {}) }, companyId);
      await ctx.issues.createComment(approval.id, "This approval had nobody assigned, so it is now with the approver. Only a person can decide it: mark it **done** to approve or **cancelled** to refuse.", companyId).catch(() => undefined);
      repaired.push(approval.id);
    } catch (error) {
      ctx.logger.info("Could not assign an unrouted approval", { issueId: approval.id, error: error instanceof Error ? error.message : String(error) });
      stillUnrouted.push(approval.id);
    }
  }
  return { repaired, stillUnrouted };
}

/**
 * Cockpit health check for the roles copy a plugin holds: unreadable, missing,
 * ownerless or stale. Informational (`warn`): approvals still find the company's
 * default owner, but they are not reviewed first and the copy should be fixed.
 * Returns null when the copy is fresh and has an owner.
 */
export async function rolesCopyHealth(ctx: PluginContext, companyId: string, options: { now?: number; maxAgeMs?: number } = {}): Promise<HealthCheck | null> {
  const key = "roles:copy";
  const title = "Team roles copy";
  const read = await readCompanyRoles(ctx, companyId, options.now);
  if (read.error) return { key, title, status: "bad", detail: `This plugin cannot read its copy of the team roles (${read.error}). Approvals go to the company's default owner and skip the Reviewer.`, fix: "Check the plugin is ready and its settings are saved for this company; the Cockpit re-sends the roles hourly." };
  if (!read.roles) return { key, title, status: "warn", detail: "No team roles have reached this plugin. Approvals go to the company's default owner and are not reviewed first.", fix: "Open Setup → Team and save the team; the Cockpit then broadcasts it.", href: "/setup?section=team" };
  const problems: string[] = [];
  if (!assignableUserId(read.roles.ownerUserId)) problems.push("no owner is set");
  const max = options.maxAgeMs ?? ROLES_COPY_MAX_AGE_MS;
  if (read.ageMs !== null && read.ageMs > max) problems.push(`the copy is ${Math.round(read.ageMs / 3_600_000)} h old (the Cockpit re-sends hourly)`);
  if (problems.length === 0) return null;
  return { key, title, status: "warn", detail: `The team roles this plugin holds: ${problems.join("; ")}.`, fix: "Open Setup → Team and save the team (it sets the owner and re-sends the roles).", href: "/setup?section=team" };
}

/** The Reviewer brief for an approval, handing to the resolved approver (convenience over kit `reviewerBrief`). */
export function approvalReviewerBrief(route: ApproverRoute, what: string, checks: string[]): string {
  const handTo = route.approverUserId
    ? { userId: route.approverUserId, label: `the approver (user \`${route.approverUserId}\`)` }
    : { label: "a board member (unassign the agent so the board sees it)" };
  return reviewerBrief({ what, checks, handTo });
}
