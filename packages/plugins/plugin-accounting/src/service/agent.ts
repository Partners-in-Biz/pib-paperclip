/**
 * The Bookkeeper: hired through a normal Paperclip task (kit agent-hire),
 * linked when it appears or by hand, then wired (plugin tool access). The
 * plugin never creates the agent itself.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  ASK_OWNER_TOOL,
  COMPANY_OS_HIRE_SKILL,
  hireStatus,
  hireTaskDraft,
  linkedAgentId,
  listCompanyAgents,
  mergePluginToolsGrant,
  roleAgentUsable,
  routeWork,
  tryLinkPendingHire,
  type HireAgentSummary,
  type HireRole,
  type OnAgentLinked,
  type WorkRoute,
} from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { monthYearLabel } from "../domain/dates.js";
import { addMonths, lastDayOfMonth, monthOf, todayIso } from "../domain/util.js";
import { PLUGIN_ID } from "../namespace.js";
import { AGENT_KEY, SKILL_CANONICAL_KEY, SKILL_SLUG } from "../skills.js";
import { booksStartFor } from "./books.js";
import { errorMessage, openIssue, ORIGIN, WORK_ORIGINS } from "./common.js";

export const TOOLS_GRANT = { permissionKey: "tools:use" as const, scope: { providerType: "paperclip_plugin" } };

export const BOOKKEEPER_INSTRUCTIONS = `# Bookkeeper, Partners in Biz

You keep Partners in Biz's own books in the Accounting plugin (\`partnersinbiz.accounting\` tools).

- Follow the **${SKILL_SLUG}** skill. It holds the monthly cycle (bank statement in, match, reconcile, VAT201, month-end close) and the tool reference. Read it before your first task.
- Your work arrives as Accounting issues assigned to you: "Bank statement received", "Reconcile N new bank lines", "Month-end close" and "Accounting: postings were rejected".
- Never post, lock or approve anything that needs a person: manual journals go in as drafts, and reconciliations and VAT201 returns go to a person through their approval issues. Never invent numbers or guess an account.
- When only a person can help (a PDF-only statement, an unclear line, a setting), ask once per issue with \`${ASK_OWNER_TOOL}\`, never in a plain comment.
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
    "Imports bank statements from the Mailbox, matches and categorises statement lines, prepares the bank reconciliations and the VAT201, and runs the month-end close in the Accounting plugin. A person approves anything that posts or locks. Monthly budget $20; the Cockpit alerts at 80% of it.",
  adapterPreference: ["hermes_local", "claude_local"],
  skills: [
    {
      key: SKILL_CANONICAL_KEY,
      slug: SKILL_SLUG,
      purpose: "the monthly bookkeeping cycle (statement in, match, reconcile, VAT201, month-end close) and the Accounting tool reference",
    },
    COMPANY_OS_HIRE_SKILL,
  ],
  budgetMonthlyCents: 2000,
  suggestedManager: "the finance lead (or the CEO)",
  instructions: BOOKKEEPER_INSTRUCTIONS,
  pluginSetup: [
    "Grants the agent `tools:use` for plugin tools, so it can call the Accounting tools (and the Mailbox's `get-attachment` for statements).",
    "Assigns it a \"Bank statement received\" issue for each statement email, a \"Reconcile N new bank lines\" issue after each import, and a \"Month-end close\" issue at the start of each month.",
    `Keeps the \`${SKILL_SLUG}\` skill up to date.`,
  ],
  toolPlugins: ["partnersinbiz.mailbox"],
};

/**
 * Existing grants with plugin tool access merged in (kit
 * `mergePluginToolsGrant`: the host keeps one `tools:use` grant per agent, so
 * it is widened, never duplicated). `conflict` is set when the existing grant
 * is limited in a way the plugin must not widen.
 */
export function mergeToolsGrant(existing: Array<{ permissionKey: string; scope: Record<string, unknown> | null }>) {
  const merged = mergePluginToolsGrant(existing);
  return { grants: merged.grants, added: merged.changed, conflict: merged.conflict };
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
    if (merged.conflict) {
      steps.push(merged.conflict);
      instructions.push(merged.conflict);
    } else if (merged.added) {
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

/**
 * Who gets Accounting's work (a statement to import, lines to reconcile, the
 * month-end close, rejected postings): the linked Bookkeeper while it is
 * running, else the kit `routeWork` (the Bookkeeper the Cockpit knows, the
 * Operator, then the owner).
 */
export async function routeBookkeeping(ctx: PluginContext, companyId: string): Promise<WorkRoute> {
  const own = await bookkeeper(ctx, companyId);
  if (own && roleAgentUsable(own.status)) return { assigneeAgentId: own.id, assigneeUserId: null, via: "bookkeeper" };
  return routeWork(ctx, companyId, ["bookkeeper"]);
}

/** The month-end close steps, with the exact tools (the issue body). */
export function monthEndCloseText(month: string): string {
  const end = lastDayOfMonth(month);
  return [
    `Close the books for ${month}. Follow the month-end section of the \`${SKILL_SLUG}\` skill.`,
    "",
    `1. \`period-close-checklist\` with \`month: "${month}"\`. Work down every item that is not ok.`,
    `2. **Bank lines:** \`list-bank-lines\` with \`status: "unreconciled"\` and \`to: "${end}"\`; match or categorise them (the reconcile issues say how).`,
    `3. **Reconciliations:** for each bank account from \`list-bank-accounts\`, \`prepare-reconciliation\` with \`month: "${month}"\`. It opens the approval issue for a person once the difference is zero and no line is open. If it needs the statement's opening or closing balance and you cannot read it from the statement, ask with \`${ASK_OWNER_TOOL}\`.`,
    `4. **VAT:** if the checklist has a VAT201 item (a VAT period ended on ${end}), check \`vat-summary\` for that period, then \`prepare-vat201\` for it. It opens the approval issue for a person.`,
    `   A reconciliation or VAT201 that is truly not needed for ${month} (say, an account with no statement for the month): record it with \`mark-not-needed\` (\`month: "${month}"\`, the \`step\` and the \`reason\`).`,
    `5. **Rejected postings, depreciation, FX:** these post or unlock the books, so a person does them. List what is missing and ask once with \`${ASK_OWNER_TOOL}\`, with the Accounting links.`,
    "6. **Trial balance or audit chain not ok:** stop and ask at once; post nothing.",
    `7. Comment the checklist result here with the approval issues you opened, then mark this issue done. Closing it checks that every bank account has a reconciliation for ${month} and the VAT201 is prepared (or recorded as not needed); if not, it opens again with what is missing. The approvals wait for a person in the Cockpit; a person closes ${month} under Accounting → Journals once they are approved.`,
  ].join("\n");
}

/** Start of each month: one "Month-end close" issue (the Bookkeeper, else the Operator or the owner). */
export async function monthEndCloseIssue(ctx: PluginContext, companyId: string, now = new Date()): Promise<string | null> {
  const day = now.getUTCDate();
  if (day > 7) return null;
  const month = addMonths(monthOf(todayIso(now)), -1);
  // Nothing to close for a month that ended before these books start.
  const start = await booksStartFor(ctx, companyId).catch(() => null);
  if (start && lastDayOfMonth(month) < start.date) return null;
  if (!(await db.setMark(ctx.db, companyId, `close-issue:${month}`))) return null;
  try {
    const route = await routeBookkeeping(ctx, companyId);
    const issue = await openIssue(ctx, {
      companyId,
      title: `Month-end close: ${monthYearLabel(month) || month}`,
      description: monthEndCloseText(month),
      originKind: ORIGIN,
      originId: `${WORK_ORIGINS.close}${month}`,
      wakeReason: "Month-end close",
    }, route);
    return issue.id;
  } catch (error) {
    await db.clearMark(ctx.db, companyId, `close-issue:${month}`).catch(() => undefined);
    ctx.logger.info("Month-end close issue skipped", { companyId, error: errorMessage(error) });
    return null;
  }
}
