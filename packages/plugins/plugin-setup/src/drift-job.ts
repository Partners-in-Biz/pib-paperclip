// Hourly template-drift job: one open "Template drift: N agents behind pack v2" issue per company,
// kept up to date, closed at zero. The issue body is the work list for the root sync script, which
// reads each agent's rendered text itself through the `template-get` tool (proven in PAR-4556).
import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { COCKPIT_EVENTS, configSaved, createWorkIssue, emptySnapshot, readCompanyRoles, type HealthCheck } from "@partnersinbiz/pib-plugin-kit";
import { computeDrift, type AgentDrift, type DriftReason } from "./drift.js";
import { listChoices } from "./db.js";
import { PLUGIN_ID } from "./namespace.js";
import { varsFor } from "./new-company.js";
import { renderHash } from "./render-hash.js";
import { message } from "./service.js";
import { loadPack, type AgentLike, type AgentTemplate } from "./templates.js";
import { renderInstructions } from "./templates-render.js";

export const DRIFT_HEALTH_KEY = "templates:drift";
const CLOSED = new Set(["done", "cancelled"]);
const AGENT_PAGE = 200;
// Closed drift issues pile up one per episode; look at enough of them that an open one is never hidden.
const OPEN_LOOKUP_LIMIT = 200;

export type DriftCompanyResult = "created" | "updated" | "unchanged" | "closed" | "none" | "skipped" | "failed";

function reasonText(reason: DriftReason): string {
  switch (reason.code) {
    case "behind_no_metadata": return "no pack metadata";
    case "behind_malformed_metadata": return "malformed pack metadata";
    case "hash_mismatch": return `hash ${reason.actual} (expected ${reason.expected})`;
    case "run_profile": return `run profile: ${reason.problems.join("; ")}`;
    case "skill_missing": return `skill missing: ${reason.skill}`;
    case "over_budget": return `rendered ${reason.chars} chars, budget ${reason.budget}`;
    case "mid_run": return "running now";
  }
}

export function driftTitle(count: number): string {
  return `Template drift: ${count} agents behind pack v2`;
}

/** The work list: a readable table plus one JSON block the sync script parses. */
export function driftBody(input: { companyId: string; rows: Array<{ drift: AgentDrift; name: string; expectedHash: string }> }): string {
  const work = input.rows.map(({ drift, name, expectedHash }) => ({
    agentId: drift.agentId,
    name,
    templateKey: drift.templateKey,
    expectedHash,
    midRun: drift.midRun,
    reasons: drift.reasons.filter((r) => r.code !== "mid_run").map((r) => r.code),
  }));
  const lines = input.rows.map(({ drift, name, expectedHash }) => {
    const reasons = drift.reasons.filter((r) => r.code !== "mid_run").map(reasonText).join(", ");
    return `- ${name} (\`${drift.agentId}\`), template \`${drift.templateKey}\`, expected hash \`${expectedHash}\`: ${reasons}${drift.midRun ? " **[running now: sync after the run]**" : ""}`;
  });
  return [
    "Agents whose instructions no longer match the team template pack. Kept up to date by the Setup plugin's hourly `template-drift` job; it closes this issue when nothing is behind.",
    "",
    "For the sync script: call `partnersinbiz.setup:template-get` with `key` and this company's `companyId` for each row, apply the rendered text and stamp `metadata.pibPack` with the returned `renderHash`. Do not use the hash from `template-list` (it renders with default variables). Skip rows marked running now and pick them up next hour.",
    "",
    ...lines,
    "",
    "```json",
    JSON.stringify({ companyId: input.companyId, work }, null, 2),
    "```",
  ].join("\n");
}

function healthCheck(actionable: number, midRun: number, issueId: string | null): HealthCheck {
  const title = "Agent templates match pack v2";
  if (actionable === 0 && midRun === 0) return { key: DRIFT_HEALTH_KEY, title, status: "ok" };
  if (actionable === 0) return { key: DRIFT_HEALTH_KEY, title, status: "ok", detail: `${midRun} agent(s) behind but running now; they are synced after the run.` };
  return {
    key: DRIFT_HEALTH_KEY,
    title,
    status: "warn",
    detail: `${actionable} agent(s) behind pack v2${midRun ? `, ${midRun} more running now` : ""}.`,
    fix: issueId ? `Run the template sync from the drift issue (${issueId}).` : "Run the template sync.",
  };
}

async function publishHealth(ctx: PluginContext, companyId: string, check: HealthCheck): Promise<void> {
  try {
    const snapshot = { ...emptySnapshot(PLUGIN_ID, "Setup"), health: [check] };
    await ctx.events.emit(COCKPIT_EVENTS.snapshot, companyId, snapshot as unknown as Record<string, unknown>);
  } catch (error) {
    ctx.logger.info("Template drift health emit failed", { companyId, error: message(error) });
  }
}

async function openDriftIssue(ctx: PluginContext, companyId: string): Promise<{ id: string; title?: string; description?: string | null } | null> {
  const found = (await ctx.issues.list({ companyId, originKind: `plugin:${PLUGIN_ID}` as never, originId: `template-drift:${companyId}`, limit: OPEN_LOOKUP_LIMIT })) as Array<{ id: string; status?: string; title?: string; description?: string | null }>;
  return found.find((issue) => !CLOSED.has(String(issue.status))) ?? null;
}

async function operatorAgentId(ctx: PluginContext, companyId: string): Promise<string | null> {
  try {
    const roles = (await readCompanyRoles(ctx, companyId)) as unknown as { roles?: { operatorAgentId?: string | null } | null };
    return roles.roles?.operatorAgentId ?? null;
  } catch {
    return null;
  }
}

/** One company: compute drift, then open, update or close its single drift issue. */
export async function refreshDriftIssue(ctx: PluginContext, companyId: string, templates: AgentTemplate[]): Promise<{ result: DriftCompanyResult; drifted: number }> {
  const agents = (await ctx.agents.list({ companyId, limit: AGENT_PAGE })) as unknown as Array<AgentLike & { metadata?: { pibPack?: unknown } | null }>;
  const live = agents.filter((agent) => agent.status !== "terminated");
  const { found, vars } = await varsFor(ctx, { companyId, key: null });
  if (!found) return { result: "skipped", drifted: 0 };

  const results = computeDrift({ templates, agents: live, vars, attachedSkills: {} });
  const byKey = new Map(templates.map((template) => [template.key, template]));
  const rows = results
    .filter((drift) => drift.drifted)
    .map((drift) => ({
      drift,
      name: live.find((agent) => agent.id === drift.agentId)?.name ?? drift.agentId,
      expectedHash: renderHash(renderInstructions(byKey.get(drift.templateKey)!, vars)),
    }));
  const actionable = rows.filter((row) => !row.drift.midRun).length;
  const midRun = rows.length - actionable;

  const open = await openDriftIssue(ctx, companyId);
  let result: DriftCompanyResult;
  let issueId: string | null = open?.id ?? null;

  if (rows.length === 0) {
    // Also reached when no agent matches any template any more (results empty): an open issue still closes.
    if (open) {
      // issues.list cuts descriptions at 1200 chars: read the full text before appending to it.
      const full = await ctx.issues.get(open.id, companyId).catch(() => null);
      const note = "No agent is behind pack v2. Closed by the Setup plugin.";
      await ctx.issues.update(open.id, { status: "done", ...(full ? { description: `${full.description ?? ""}\n\n${note}`.trim() } : {}) }, companyId);
      result = "closed";
      issueId = null;
    } else {
      result = "none";
    }
  } else {
    const title = driftTitle(rows.length);
    const body = driftBody({ companyId, rows });
    // issues.list returns only the first 1200 chars of a description, so the change check reads a marker at the top.
    const marker = `<!-- template-drift:${createHash("sha256").update(body).digest("hex").slice(0, 16)} -->`;
    const description = `${marker}\n${body}`;
    if (open) {
      if (open.title === title && (open.description ?? "").startsWith(marker)) {
        result = "unchanged";
      } else {
        await ctx.issues.update(open.id, { title, description }, companyId);
        result = "updated";
      }
    } else {
      const assigneeAgentId = await operatorAgentId(ctx, companyId);
      const created = await createWorkIssue(ctx, {
        companyId,
        title,
        description,
        originKind: `plugin:${PLUGIN_ID}`,
        originId: `template-drift:${companyId}`,
        ...(assigneeAgentId ? { assigneeAgentId } : {}),
      });
      issueId = created.id;
      result = "created";
    }
  }
  await publishHealth(ctx, companyId, healthCheck(actionable, midRun, issueId));
  return { result, drifted: rows.length };
}

/** Hourly job: every company with saved Setup settings (host rule). One failing company does not stop the rest. */
export async function templateDrift(ctx: PluginContext): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  let templates: AgentTemplate[];
  try {
    templates = loadPack().templates;
  } catch (error) {
    ctx.logger.info("Template drift skipped: the template pack is not sound", { error: message(error) });
    return { noPack: 1 };
  }
  for (const choice of await listChoices(ctx)) {
    let key: string;
    if (!(await configSaved(ctx, choice.companyId))) {
      key = "skipped";
    } else {
      try {
        key = (await refreshDriftIssue(ctx, choice.companyId, templates)).result;
      } catch (error) {
        key = "failed";
        ctx.logger.info("Template drift failed", { companyId: choice.companyId, error: message(error) });
      }
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
