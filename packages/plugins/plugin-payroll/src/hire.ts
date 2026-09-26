/**
 * The optional Payroll Clerk as a hire request (kit agent-hire, the same
 * path as the SEO and Social agents). The clerk prepares pay runs, checks
 * variances and records leave; it never approves, locks or reveals
 * personal details, and its tools only return masked data.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { HireRole, OnAgentLinked } from "@partnersinbiz/pib-plugin-kit";
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

- Follow the **${SKILL_SLUG}** skill. It holds the monthly procedure and the tool reference. Read it before your first run.
- You prepare and check. A board member approves, locks and pays. Never approve a pay run, never ask for or repeat ID numbers, tax numbers or bank details, and never invent figures.
- When something looks wrong, say so on the issue and leave the run for a person.
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
    "Prepares monthly and weekly pay runs, enters hours, overtime, bonuses and leave, checks variances against last month and sends runs to a board member for approval, using masked payroll data only.",
  adapterPreference: ["hermes_local", "claude_local"],
  skills: [{ key: canonicalSkillKey(PLUGIN_ID, SKILL_KEY), slug: SKILL_SLUG, purpose: "the pay run procedure, variance checks, leave and the payroll tool reference" }],
  budgetMonthlyCents: 0,
  suggestedManager: "the finance lead (or the CEO)",
  instructions: CLERK_INSTRUCTIONS,
  pluginSetup: [
    "Grants the agent `tools:use` for plugin tools, so it can call the Payroll tools.",
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
    steps.push(skills.every((s) => s.action !== "failed") ? `Synced the \`${SKILL_SLUG}\` skill.` : `The \`${SKILL_SLUG}\` skill did not sync; use Sync skill on the Payroll page.`);
    try {
      const existing = await ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId });
      const merged = mergeGrants(existing.map((g) => ({ permissionKey: String(g.permissionKey), scope: (g.scope as Record<string, unknown> | null) ?? null })), PLUGIN_TOOLS_GRANT);
      if (merged.added) {
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
