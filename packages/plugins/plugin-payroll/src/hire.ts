/**
 * The optional Payroll Clerk as a hire request (kit agent-hire, the same
 * path as the SEO and Social agents). The clerk prepares pay runs, checks
 * variances and records leave; it never approves, locks or reveals
 * personal details, and its tools only return masked data.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ASK_OWNER_TOOL, COMPANY_OS_HIRE_SKILL, mergePluginToolsGrant, type HireRole, type OnAgentLinked } from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_ID } from "./namespace.js";
import { SKILL_KEY, SKILL_SLUG } from "./skills.js";

export const CLERK_ROLE_KEY = "payroll-clerk";
export const CLERK_NAME = "Payroll Clerk";

/** Canonical key the host gives a plugin-managed skill: `plugin/<slug(pluginKey)>/<skillKey>`. */
export function canonicalSkillKey(pluginId: string, skillKey: string): string {
  const slug = pluginId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
  return `plugin/${slug}/${skillKey}`;
}

export const CLERK_INSTRUCTIONS = `# Payroll Clerk, Partners in Biz

You prepare South African payroll with the \`partnersinbiz.payroll\` tools.

- Follow the **${SKILL_SLUG}** skill. It holds the monthly cycle (prepare, calculate, approval, lock, payslips, EMP201, EMP501) and the tool reference. Read it before your first run.
- Your work arrives as Payroll issues: "Prepare pay run for <month>" a few days before pay day, and "EMP201 for <month> due by <date>" early each month when there is no Bookkeeper.
- You prepare and check. A board member approves, locks and pays. Never approve a pay run, never ask for or repeat ID numbers, tax numbers or bank details, and never invent figures.
- When only a person can help (missing employee details, a figure that looks wrong, filing with SARS), ask once per issue with \`${ASK_OWNER_TOOL}\`, never in a plain comment.
`;

export const CLERK_ROLE: HireRole = {
  pluginKey: PLUGIN_ID,
  pluginName: "Payroll",
  roleKey: CLERK_ROLE_KEY,
  displayName: CLERK_NAME,
  title: CLERK_NAME,
  role: "general",
  icon: "wallet",
  capabilities:
    "Prepares monthly and weekly pay runs when Payroll asks (a few days before pay day), enters hours, overtime, bonuses and leave, checks variances against last month, sends runs to a board member for approval and readies the EMP201, using masked payroll data only. Monthly budget $10; the Cockpit alerts at 80% of it.",
  adapterPreference: ["hermes_local", "claude_local"],
  skills: [
    { key: canonicalSkillKey(PLUGIN_ID, SKILL_KEY), slug: SKILL_SLUG, purpose: "the monthly payroll cycle (prepare, calculate, approval, lock, payslips, EMP201, EMP501), leave and the payroll tool reference" },
    COMPANY_OS_HIRE_SKILL,
  ],
  budgetMonthlyCents: 1000,
  suggestedManager: "the finance lead (or the CEO)",
  instructions: CLERK_INSTRUCTIONS,
  pluginSetup: [
    "Grants the agent `tools:use` for plugin tools, so it can call the Payroll tools.",
    "Assigns it a \"Prepare pay run for <month>\" issue a few days before each monthly pay day (5 by default), and the \"EMP201 due\" issue when there is no Bookkeeper.",
    `Keeps the \`${SKILL_SLUG}\` skill up to date.`,
    "Does not give it any way to approve, lock, reveal personal details or make bank files; those stay with board members.",
  ],
  toolPlugins: [],
};

export const PLUGIN_TOOLS_GRANT = { permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } } as const;

type GrantInput = { permissionKey: string; scope?: Record<string, unknown> | null };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function mergeGrants(existing: GrantInput[], add: GrantInput): { grants: GrantInput[]; added: boolean } {
  const key = (g: GrantInput) => `${g.permissionKey}|${stable(g.scope ?? null)}`;
  const seen = new Set<string>();
  const grants: GrantInput[] = [];
  for (const g of existing) {
    const k = key(g);
    if (seen.has(k)) continue;
    seen.add(k);
    grants.push({ permissionKey: g.permissionKey, scope: g.scope ?? null });
  }
  if (seen.has(key(add))) return { grants, added: false };
  grants.push({ permissionKey: add.permissionKey, scope: add.scope ?? null });
  return { grants, added: true };
}

/** Wires a linked clerk: fresh skill and plugin-tool access. */
export function clerkOnLinked(ctx: PluginContext, syncSkills: (companyId: string) => Promise<Array<{ action: string; error?: string }>>): OnAgentLinked {
  return async (companyId, agentId, by) => {
    const steps: string[] = [];
    const skills = await syncSkills(companyId).catch((error: unknown) => [{ action: "failed", error: error instanceof Error ? error.message : String(error) }]);
    steps.push(skills.every((s) => s.action !== "failed") ? `Synced the \`${SKILL_SLUG}\` skill.` : `The \`${SKILL_SLUG}\` skill did not sync; re-sync the Payroll Clerk in Setup → Team.`);
    try {
      const existing = await ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId });
      // One tools:use grant per agent: widen it, never add a second one (kit mergePluginToolsGrant).
      const merged = mergePluginToolsGrant(existing.map((g) => ({ permissionKey: String(g.permissionKey), scope: (g.scope as Record<string, unknown> | null) ?? null })));
      if (merged.conflict) {
        steps.push(merged.conflict);
      } else if (merged.changed) {
        await ctx.authorization.grants.set({
          companyId,
          principalType: "agent",
          principalId: agentId,
          grants: merged.grants as Parameters<PluginContext["authorization"]["grants"]["set"]>[0]["grants"],
          grantedByUserId: by.userId && by.userId !== "local-board" ? by.userId : null,
        });
        steps.push("Granted plugin tool access (`tools:use` for plugin tools).");
      } else {
        steps.push("Plugin tool access was already granted.");
      }
    } catch (error) {
      steps.push(`Tool access could not be granted automatically (${error instanceof Error ? error.message : String(error)}). Grant the agent tools:use for plugin tools.`);
    }
    return steps;
  };
}
