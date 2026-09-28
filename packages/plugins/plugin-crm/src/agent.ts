/**
 * The Account Manager: the CRM's team role (kit `TEAM_ROLES` key
 * `account-manager`). It is hired through a normal Paperclip task (kit
 * agent-hire), linked when it appears or when a person picks it in
 * Setup → Team, then wired: skills synced, plugin tool access granted, and
 * waiting CRM work handed to it. The plugin never creates the agent itself.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  COMPANY_OS_HIRE_SKILL,
  coversPluginTools,
  hireStatus,
  hireTaskDraft,
  linkedAgentId,
  listCompanyAgents,
  mergePluginToolsGrant,
  operatorAgentId,
  PIB_PLUGINS,
  PLUGIN_TOOLS_GRANT,
  roleAgentUsable,
  teamSkillKey,
  tryLinkPendingHire,
  wakeIssue,
  type GrantLike,
  type HireAgentSummary,
  type HireRole,
  type HireStatus,
  type MergedGrants,
  type OnAgentLinked,
  type TeamMemberReport,
} from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_ID } from "./namespace.js";
import { WORK_ORIGIN_RE } from "./origins.js";

export const AM_ROLE_KEY = "account-manager" as const;
export const AM_NAME = "Account Manager";
const ORIGIN = `plugin:${PLUGIN_ID}` as const;

/** The CRM's own skills, as the host keys them. */
export const CRM_SKILL_KEYS = {
  records: teamSkillKey(PLUGIN_ID, "crm-records"),
  outbound: teamSkillKey(PLUGIN_ID, "crm-outbound"),
} as const;

export const AM_INSTRUCTIONS = `# Account Manager, Partners in Biz

You look after Partners in Biz's leads and clients: the CRM (\`partnersinbiz.crm\` tools) plus drafts in Billing, the Mailbox and Campaigns.

- Follow the **pib-crm-records** skill (finding clients, records, the client lifecycle from lead to offboarding) and the **pib-crm-outbound** skill (lead follow-up, sequences, replies and the rules for marketing email). Read both before your first task.
- Your work arrives as CRM issues assigned to you: lead follow-ups, contact replies, sequence steps, won deals and hand-offs.
- Find the client first (\`find-records\`) and name it as \`company:<id>\` or \`contact:<id>\`. One client per task; never mix clients.
- Quotes, invoices, emails and campaigns go out only through their module's approval step. Never send, publish or pay outside it.
`;

export const ACCOUNT_MANAGER_ROLE: HireRole = {
  pluginKey: PLUGIN_ID,
  pluginName: "CRM",
  roleKey: AM_ROLE_KEY,
  displayName: AM_NAME,
  title: AM_NAME,
  role: "general",
  icon: "heart",
  capabilities:
    "Follows up leads, works sequence steps and contact replies, keeps the CRM current, fills in client profiles, runs client onboarding, monthly reports and offboarding, and drafts quotes, invoices, client emails and campaigns for approval. A person approves anything that is sent or charged.",
  adapterPreference: ["hermes_local", "claude_local"],
  skills: [
    { key: CRM_SKILL_KEYS.records, slug: "pib-crm-records", purpose: "finding clients, keeping records and the client lifecycle from lead to offboarding" },
    { key: CRM_SKILL_KEYS.outbound, slug: "pib-crm-outbound", purpose: "lead follow-up, sequences, replies and the rules for marketing email" },
    COMPANY_OS_HIRE_SKILL,
  ],
  // $40 a month. The Company Cockpit alerts at 80% ($32).
  budgetMonthlyCents: 4000,
  suggestedManager: "the sales or client lead (or the CEO)",
  instructions: AM_INSTRUCTIONS,
  pluginSetup: [
    "Grants the agent `tools:use` for plugin tools (CRM, Billing, Campaigns, Mailbox and Partners). It merges into the agent's one tools grant.",
    "Makes it the default owner of CRM work: lead follow-ups, contact replies, sequence steps and hand-offs.",
    "Hands it the CRM issues that were waiting without an agent.",
    "Keeps the `pib-crm-records` and `pib-crm-outbound` skills up to date. The CRM page also attaches the Billing, Campaigns, Mailbox and Partners skills it uses when those modules are installed.",
    "Budget: $40 a month to start. The Cockpit alerts at 80% ($32), so raise it there if the agent needs more.",
  ],
  toolPlugins: [PIB_PLUGINS.crm, PIB_PLUGINS.billing, PIB_PLUGINS.campaigns, PIB_PLUGINS.mailbox, PIB_PLUGINS.partners],
};

// ---------------------------------------------------------------------------
// The tools grant (the host keeps one `tools:use` grant per agent)
// ---------------------------------------------------------------------------

export const TOOLS_GRANT = PLUGIN_TOOLS_GRANT;
export type { GrantLike, MergedGrants };
export { coversPluginTools };

/** The agent's grants with plugin tool access merged in: see kit `mergePluginToolsGrant` (one `tools:use` grant per agent, widened, never duplicated). */
export function mergeToolsGrant(existing: GrantLike[]): MergedGrants {
  return mergePluginToolsGrant(existing);
}

// ---------------------------------------------------------------------------
// Skills on the agent
// ---------------------------------------------------------------------------

function desiredSkills(agent: unknown): string[] {
  const config = (agent as { adapterConfig?: unknown } | null)?.adapterConfig;
  if (!config || typeof config !== "object") return [];
  const sync = (config as Record<string, unknown>).paperclipSkillSync;
  if (!sync || typeof sync !== "object") return [];
  const list = (sync as Record<string, unknown>).desiredSkills;
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
}

/**
 * The CRM's own role skills the agent does not list (the page attaches them;
 * the worker cannot). The company operating manual is the Cockpit's skill:
 * the page attaches it once it exists in the company, so it is not checked here.
 */
export function missingRoleSkills(agent: unknown): string[] {
  const have = desiredSkills(agent).map((s) => s.toLowerCase());
  const own = Object.values(CRM_SKILL_KEYS) as string[];
  return ACCOUNT_MANAGER_ROLE.skills
    .filter((skill) => own.includes(skill.key))
    .filter((skill) => !have.some((k) => k === skill.key.toLowerCase() || k === skill.slug || k.endsWith(`/${skill.slug}`) || k.endsWith(`/${skill.key.split("/").pop()!}`)))
    .map((skill) => skill.slug);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface WireResult {
  agent: { id: string; name: string; status: string };
  grant: "added" | "already_present" | "failed";
  missingSkills: string[];
  adoptedIssues: number;
  steps: string[];
  instructions: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Hands the Account Manager CRM work that was waiting without an agent: open
 * `todo`/`backlog` CRM issues with no assignee or held by the Operator (the
 * fallback before the Account Manager existed).
 */
export async function adoptWaitingWork(ctx: PluginContext, companyId: string, agent: { id: string; status: string }): Promise<number> {
  const operator = await operatorAgentId(ctx, companyId);
  let adopted = 0;
  for (const status of ["todo", "backlog"] as const) {
    let issues: Awaited<ReturnType<PluginContext["issues"]["list"]>> = [];
    try {
      issues = await ctx.issues.list({ companyId, originKind: ORIGIN, status, limit: 200 });
    } catch {
      issues = [];
    }
    for (const issue of issues) {
      // Work issues the CRM opens for its agent (not approvals or hires), old and new origin ids.
      if (!WORK_ORIGIN_RE.test(String(issue.originId ?? "")) && !isStepIssue(issue.originId)) continue;
      const free = !issue.assigneeAgentId && !issue.assigneeUserId;
      const operatorHeld = Boolean(operator && issue.assigneeAgentId === operator);
      if (!free && !operatorHeld) continue;
      try {
        await ctx.issues.update(issue.id, { assigneeAgentId: agent.id, assigneeUserId: null, status: "todo" }, companyId);
        if (roleAgentUsable(agent.status)) await wakeIssue(ctx, issue.id, companyId, "CRM work handed to the Account Manager");
        adopted += 1;
      } catch (error) {
        ctx.logger.info("CRM work hand-over skipped", { issueId: issue.id, error: errorMessage(error) });
      }
    }
  }
  return adopted;
}

/** Step issues opened before 0.5.0 used the bare enrollment id (a uuid) as their origin id. */
function isStepIssue(originId: string | null | undefined): boolean {
  return typeof originId === "string" && /^[0-9a-f-]{36}$/i.test(originId);
}

/**
 * Sets up a linked agent: skills synced, tool access merged, waiting work
 * handed over. Safe to run again (Re-sync). `userId` is null for automatic links.
 */
export async function wireAgent(
  ctx: PluginContext,
  companyId: string,
  agentId: string,
  userId: string | null,
  syncSkills: (companyId: string) => Promise<unknown>,
): Promise<WireResult> {
  const agent = await ctx.agents.get(agentId, companyId);
  if (!agent) throw new Error("That agent was not found in this company.");
  const name = String(agent.name ?? "the agent");
  const status = String(agent.status ?? "");
  const steps: string[] = [];
  const instructions: string[] = [];

  try {
    await syncSkills(companyId);
    steps.push("Synced the `pib-crm-records` and `pib-crm-outbound` skills to their latest version.");
  } catch (error) {
    steps.push(`The CRM skills did not sync (${errorMessage(error)}). Re-sync the Account Manager in Setup → Team to try again.`);
  }
  const missingSkills = missingRoleSkills(agent);
  if (missingSkills.length > 0) {
    const ask = `Attach ${missingSkills.map((slug) => `\`${slug}\``).join(", ")} to ${name} (Agents → ${name} → Skills, or open the CRM page, which attaches them for you).`;
    steps.push(ask);
    instructions.push(ask);
  }

  let grant: WireResult["grant"] = "failed";
  try {
    const existing = await ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId });
    const merged = mergeToolsGrant((existing as unknown as GrantLike[]).map((g) => ({ permissionKey: String(g.permissionKey), scope: (g.scope as Record<string, unknown> | null) ?? null })));
    if (merged.conflict) {
      steps.push(merged.conflict);
      instructions.push(merged.conflict);
    } else if (merged.changed) {
      await ctx.authorization.grants.set({
        companyId,
        principalType: "agent",
        principalId: agentId,
        grants: merged.grants as Parameters<PluginContext["authorization"]["grants"]["set"]>[0]["grants"],
        grantedByUserId: userId && userId !== "local-board" ? userId : null,
      });
      grant = "added";
      steps.push("Granted plugin tool access (`tools:use` for plugin tools, merged into its one tools grant).");
    } else {
      grant = "already_present";
      steps.push("Plugin tool access was already granted.");
    }
  } catch (error) {
    const ask = `Tool access could not be granted automatically (${errorMessage(error)}). Grant the agent tools:use for plugin tools in its permissions.`;
    steps.push(ask);
    instructions.push(ask);
  }

  const adoptedIssues = await adoptWaitingWork(ctx, companyId, { id: agentId, status }).catch(() => 0);
  steps.push(adoptedIssues > 0
    ? `Handed ${name} ${adoptedIssues} waiting CRM issue${adoptedIssues === 1 ? "" : "s"}.`
    : `${name} now gets new CRM work (no CRM issues were waiting).`);

  if (status === "pending_approval") instructions.unshift(`Approve the ${name} hire in Approvals.`);
  if (status === "paused" || status === "pending_approval") instructions.push(`Open Agents → ${name}, check its adapter has a working model key, then click Resume.`);
  return { agent: { id: agentId, name, status }, grant, missingSkills, adoptedIssues, steps, instructions };
}

export function onAccountManagerLinked(ctx: PluginContext, syncSkills: (companyId: string) => Promise<unknown>): OnAgentLinked {
  return async (companyId, agentId, by) => (await wireAgent(ctx, companyId, agentId, by.userId, syncSkills)).steps;
}

/** Links the pending hire when exactly one new agent matches. Never throws. */
export async function tryLinkAccountManager(ctx: PluginContext, companyId: string, syncSkills: (companyId: string) => Promise<unknown>): Promise<HireAgentSummary | null> {
  try {
    return await tryLinkPendingHire(ctx, companyId, ACCOUNT_MANAGER_ROLE, onAccountManagerLinked(ctx, syncSkills));
  } catch (error) {
    ctx.logger.info("Account Manager hire link check failed", { companyId, error: errorMessage(error) });
    return null;
  }
}

/** The linked Account Manager, or null. Cheap enough for jobs. */
export async function accountManager(ctx: PluginContext, companyId: string): Promise<{ id: string; name: string; status: string; agent: unknown } | null> {
  try {
    const id = await linkedAgentId(ctx, companyId, ACCOUNT_MANAGER_ROLE);
    if (!id) return null;
    const agent = await ctx.agents.get(id, companyId);
    return agent ? { id, name: String(agent.name ?? AM_NAME), status: String(agent.status ?? ""), agent } : null;
  } catch {
    return null;
  }
}

/** For the Cockpit snapshot: the role and its agent, so the Cockpit can share it in `roles.updated`. */
export async function teamReport(ctx: PluginContext, companyId: string): Promise<TeamMemberReport[]> {
  const agent = await accountManager(ctx, companyId);
  return [{ role: AM_ROLE_KEY, agentId: agent?.id ?? null, status: agent?.status ?? null }];
}

export interface HireView {
  agent: HireAgentSummary | null;
  linkedBy: HireStatus["linkedBy"];
  hire: (NonNullable<HireStatus["hire"]> & { issueStatus: string | null; assigneeName: string | null }) | null;
  candidates: HireAgentSummary[];
  /** Role skill slugs the worker saw missing on the agent. */
  missingSkills: string[];
}

/** Hire status for the CRM page's agent box. */
export async function hireView(ctx: PluginContext, companyId: string, userId: string | null): Promise<HireView> {
  const status = await hireStatus(ctx, companyId, ACCOUNT_MANAGER_ROLE);
  let missingSkills: string[] = [];
  if (status.agent) {
    try {
      missingSkills = missingRoleSkills(await ctx.agents.get(status.agent.id, companyId));
    } catch {
      missingSkills = [];
    }
  }
  if (!status.hire) return { ...status, hire: null, missingSkills };
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
  return { ...status, hire: { ...status.hire, identifier, issueStatus, assigneeName }, missingSkills };
}

export async function hireOptions(ctx: PluginContext, companyId: string) {
  const [agents, status] = await Promise.all([listCompanyAgents(ctx, companyId), hireStatus(ctx, companyId, ACCOUNT_MANAGER_ROLE)]);
  return { draft: hireTaskDraft(ACCOUNT_MANAGER_ROLE), agents, defaultAssigneeAgentId: agents.find((a) => a.role === "ceo")?.id ?? null, status };
}
