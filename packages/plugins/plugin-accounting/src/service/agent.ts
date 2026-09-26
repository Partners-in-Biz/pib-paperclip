/**
 * The Bookkeeper: hired through a normal Paperclip task (kit agent-hire),
 * linked when it appears or by hand, then wired (plugin tool access). The
 * plugin never creates the agent itself.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  createWorkIssue,
  hireStatus,
  hireTaskDraft,
  linkedAgentId,
  listCompanyAgents,
  tryLinkPendingHire,
  type HireAgentSummary,
  type HireRole,
  type OnAgentLinked,
} from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { addMonths, monthOf, todayIso } from "../domain/util.js";
import { PLUGIN_ID } from "../namespace.js";
import { AGENT_KEY, SKILL_CANONICAL_KEY, SKILL_SLUG } from "../skills.js";
import { errorMessage, ORIGIN } from "./common.js";

export const TOOLS_GRANT = { permissionKey: "tools:use" as const, scope: { providerType: "paperclip_plugin" } };

export const BOOKKEEPER_INSTRUCTIONS = `# Bookkeeper, Partners in Biz

You keep Partners in Biz's own books in the Accounting plugin (\`partnersinbiz.accounting\` tools).

- Follow the **${SKILL_SLUG}** skill. It holds the procedure for reconciling the bank, categorising lines, month-end close and the tool reference. Read it before your first task.
- Your work arrives as Accounting issues assigned to you ("Reconcile N new bank lines", "Month-end close").
- Never post, lock or approve anything that needs a person: manual journals go in as drafts for approval; reconciliations and VAT returns are approved by a board user. Never invent numbers or guess an account when unsure; leave a comment instead.
`;

export const BOOKKEEPER_ROLE: HireRole = {
  pluginKey: PLUGIN_ID,
  pluginName: "Accounting",
  roleKey: AGENT_KEY,
  displayName: "Bookkeeper",
  title: "Bookkeeper",
  role: "general",
  icon: "calculator",
  capabilities:
    "Reconciles the bank, categorises statement lines, prepares manual journals as drafts, runs the month-end close checklist and prepares VAT returns in the Accounting plugin. A person approves anything that posts or locks.",
  adapterPreference: ["hermes_local", "claude_local"],
  skills: [
    {
      key: SKILL_CANONICAL_KEY,
      slug: SKILL_SLUG,
      purpose: "reconciling, categorising, month-end close checklist and the Accounting tool reference",
    },
  ],
  budgetMonthlyCents: 0,
  suggestedManager: "the finance lead (or the CEO)",
  instructions: BOOKKEEPER_INSTRUCTIONS,
  pluginSetup: [
    "Grants the agent `tools:use` for plugin tools, so it can call the Accounting tools.",
    "Assigns it a \"Reconcile N new bank lines\" issue after each statement import, and a \"Month-end close\" issue at the start of each month.",
    `Keeps the \`${SKILL_SLUG}\` skill up to date.`,
  ],
  toolPlugins: [],
};

function sameScope(a: Record<string, unknown> | null | undefined, b: Record<string, unknown>): boolean {
  const norm = (v: Record<string, unknown> | null | undefined) => JSON.stringify(Object.keys(v ?? {}).sort().map((k) => [k, (v ?? {})[k]]));
  return norm(a) === norm(b);
}

/** Existing grants plus the plugin-tools grant (grants.set replaces the whole set). */
export function mergeToolsGrant(existing: Array<{ permissionKey: string; scope: Record<string, unknown> | null }>) {
  const grants = existing.map((g) => ({ permissionKey: g.permissionKey, scope: g.scope ?? null }));
  const covered = grants.some((g) => g.permissionKey === "tools:use" && (!g.scope || Object.keys(g.scope).length === 0 || sameScope(g.scope, TOOLS_GRANT.scope)));
  return { grants: covered ? grants : [...grants, { ...TOOLS_GRANT }], added: !covered };
}

function desiredSkills(agent: unknown): string[] {
  const config = (agent as { adapterConfig?: unknown } | null)?.adapterConfig;
  if (!config || typeof config !== "object") return [];
  const sync = (config as Record<string, unknown>).paperclipSkillSync;
  if (!sync || typeof sync !== "object") return [];
  const list = (sync as Record<string, unknown>).desiredSkills;
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
}

export function hasBookkeepingSkill(agent: unknown): boolean {
  return desiredSkills(agent)
    .map((s) => s.toLowerCase())
    .some((k) => k === SKILL_CANONICAL_KEY || k === SKILL_SLUG || k.endsWith(`/${SKILL_SLUG}`) || k.endsWith("/bookkeeping"));
}

export interface WireResult {
  agent: { id: string; name: string; status: string };
  grant: "added" | "already_present" | "failed";
  skillAttached: boolean;
  steps: string[];
  instructions: string[];
}

export async function wireAgent(ctx: PluginContext, companyId: string, agentId: string, userId: string | null, syncSkills: (companyId: string) => Promise<unknown>): Promise<WireResult> {
  const agent = await ctx.agents.get(agentId, companyId);
  if (!agent) throw new Error("That agent was not found in this company.");
  const name = String(agent.name ?? "the agent");
  const status = String(agent.status ?? "");
  const steps: string[] = [];
  const instructions: string[] = [];
  await syncSkills(companyId).catch(() => undefined);
  steps.push(`Synced the \`${SKILL_SLUG}\` skill to its latest version.`);
  const skillAttached = hasBookkeepingSkill(agent);
  if (!skillAttached) {
    const ask = `Attach the \`${SKILL_SLUG}\` skill to ${name} (Agents → ${name} → Skills). The plugin keeps it up to date but cannot attach it.`;
    steps.push(ask);
    instructions.push(ask);
  }
  let grant: WireResult["grant"] = "failed";
  try {
    const existing = await ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId });
    const merged = mergeToolsGrant(existing as unknown as Array<{ permissionKey: string; scope: Record<string, unknown> | null }>);
    if (merged.added) {
      await ctx.authorization.grants.set({
        companyId,
        principalType: "agent",
        principalId: agentId,
        grants: merged.grants as Parameters<PluginContext["authorization"]["grants"]["set"]>[0]["grants"],
        grantedByUserId: userId,
      });
      grant = "added";
      steps.push("Granted plugin tool access (`tools:use` for plugin tools).");
    } else {
      grant = "already_present";
      steps.push("Plugin tool access was already granted.");
    }
  } catch (error) {
    const ask = `Tool access could not be granted automatically (${errorMessage(error)}). Grant the agent tools:use for plugin tools in its permissions.`;
    steps.push(ask);
    instructions.push(ask);
  }
  if (status === "pending_approval") instructions.unshift(`Approve the ${name} hire in Approvals.`);
  if (status === "paused" || status === "pending_approval") instructions.push(`Open Agents → ${name}, check its adapter has a working model key, then click Resume.`);
  return { agent: { id: agentId, name, status }, grant, skillAttached, steps, instructions };
}

export function onBookkeeperLinked(ctx: PluginContext, syncSkills: (companyId: string) => Promise<unknown>): OnAgentLinked {
  return async (companyId, agentId, by) => (await wireAgent(ctx, companyId, agentId, by.userId, syncSkills)).steps;
}

export async function tryLinkBookkeeper(ctx: PluginContext, companyId: string, syncSkills: (companyId: string) => Promise<unknown>): Promise<HireAgentSummary | null> {
  try {
    return await tryLinkPendingHire(ctx, companyId, BOOKKEEPER_ROLE, onBookkeeperLinked(ctx, syncSkills));
  } catch (error) {
    ctx.logger.info("Bookkeeper hire link check failed", { companyId, error: errorMessage(error) });
    return null;
  }
}

/** The linked Bookkeeper, or null. Cheap enough for jobs. */
export async function bookkeeper(ctx: PluginContext, companyId: string): Promise<{ id: string; status: string; name: string } | null> {
  try {
    const id = await linkedAgentId(ctx, companyId, BOOKKEEPER_ROLE);
    if (!id) return null;
    const agent = await ctx.agents.get(id, companyId);
    return agent ? { id, status: String(agent.status ?? ""), name: String(agent.name ?? "Bookkeeper") } : null;
  } catch {
    return null;
  }
}

export async function hireView(ctx: PluginContext, companyId: string, userId: string | null) {
  const status = await hireStatus(ctx, companyId, BOOKKEEPER_ROLE);
  if (!status.hire) return { ...status, hire: null };
  let issueStatus: string | null = null;
  let assigneeName: string | null = null;
  let identifier = status.hire.identifier;
  try {
    const issue = await ctx.issues.get(status.hire.issueId, companyId);
    if (issue) {
      issueStatus = String(issue.status);
      identifier = identifier ?? issue.identifier ?? null;
      if (issue.assigneeAgentId) {
        const a = await ctx.agents.get(issue.assigneeAgentId, companyId).catch(() => null);
        assigneeName = a ? String(a.name) : null;
      } else if (issue.assigneeUserId) assigneeName = userId && issue.assigneeUserId === userId ? "you" : "a board member";
    }
  } catch {
    issueStatus = null;
  }
  return { ...status, hire: { ...status.hire, identifier, issueStatus, assigneeName } };
}

export async function hireOptions(ctx: PluginContext, companyId: string) {
  const [agents, status] = await Promise.all([listCompanyAgents(ctx, companyId), hireStatus(ctx, companyId, BOOKKEEPER_ROLE)]);
  return { draft: hireTaskDraft(BOOKKEEPER_ROLE), agents, defaultAssigneeAgentId: agents.find((a) => a.role === "ceo")?.id ?? null, status };
}

/** Start of each month: a "Month-end close" issue for the Bookkeeper (once per month). */
export async function monthEndCloseIssue(ctx: PluginContext, companyId: string, now = new Date()): Promise<string | null> {
  const day = now.getUTCDate();
  if (day > 7) return null;
  const month = addMonths(monthOf(todayIso(now)), -1);
  const agent = await bookkeeper(ctx, companyId);
  if (!agent) return null;
  if (!(await db.setMark(ctx.db, companyId, `close-issue:${month}`))) return null;
  try {
    const issue = await createWorkIssue(ctx, {
      companyId,
      title: `Month-end close: ${month}`,
      description: [
        `Close the books for ${month}. Follow the month-end section of the \`${SKILL_SLUG}\` skill:`,
        "",
        `1. \`period-close-checklist\` with month ${month}.`,
        "2. Reconcile every bank line in the month; prepare the bank reconciliations and ask for approval.",
        "3. Check depreciation, FX revaluation and rejected postings.",
        "4. If a VAT period ended, prepare the VAT201 and ask for approval.",
        "5. Comment the checklist result here. A board user closes the period.",
      ].join("\n"),
      assigneeAgentId: agent.id,
      originKind: ORIGIN,
      originId: `close:${month}`,
      wake: !["paused", "pending_approval", "terminated"].includes(agent.status),
      wakeReason: "Month-end close",
    });
    return issue.id;
  } catch (error) {
    await db.clearMark(ctx.db, companyId, `close-issue:${month}`).catch(() => undefined);
    ctx.logger.info("Month-end close issue skipped", { companyId, error: errorMessage(error) });
    return null;
  }
}
