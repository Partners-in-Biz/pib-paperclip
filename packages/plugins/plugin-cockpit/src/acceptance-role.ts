/**
 * The Acceptance agent (Q5-1): the role that uses the product as a customer
 * would. Defined the way the Operator and the Reviewer are (hire.ts): a hire
 * task with the spec, linked and wired when the agent appears. The link lives in
 * the kit's hire state (company-scoped plugin state), so it needs no column.
 *
 * Staffing. Roles are staffed only in Setup → Team. The kit's team registry
 * lists the roles that page shows; this role is not in it yet (see needs_elsewhere
 * in the release notes), so until it is, the Cockpit's own actions
 * (`cockpit.hire-options`, `cockpit.start-hire`, `cockpit.link-agent`) carry
 * `role: "acceptance"` exactly as they do for the Operator and the Reviewer, and
 * the agent is reported in the Cockpit's snapshot `team` so Setup sees it.
 */
import { CLAUDE_SONNET_MODEL, type RunProfile } from "@partnersinbiz/pib-plugin-kit/run-profile";
import { COMPANY_OS_HIRE_SKILL, linkedAgentId, tryLinkPendingHire, type HireRole, type OnAgentLinked } from "@partnersinbiz/pib-plugin-kit";
import { canonicalSkillKey, PLUGIN_KEY, SKILL_KEYS, SKILL_SLUGS } from "./constants.js";
import { listRoles } from "./db.js";
import { message, type Env } from "./env.js";
import { PAPERCLIP_HIRE_SKILL } from "./hire.js";
import { grantPluginTools } from "./roles.js";

export const ACCEPTANCE_ROLE_KEY = "acceptance";
export const ACCEPTANCE_SKILL_KEY = canonicalSkillKey(PLUGIN_KEY, SKILL_KEYS.acceptance);
export const ACCEPTANCE_BUDGET_CENTS = 2000;

/** Sonnet (it works real tools against a real company), one run at a time: journeys share one canary client. */
export const ACCEPTANCE_RUN_PROFILE: RunProfile = { model: CLAUDE_SONNET_MODEL, effort: "medium", timeoutSec: 3600, maxTurnsPerRun: 250, maxConcurrentRuns: 1 };

export const ACCEPTANCE_CAPABILITIES =
  "Uses the product the way a customer would, on the canary client only: works the scripted journeys (lead captured and qualified, quote to invoice, email sequence, social draft, SEO sprint, client report, document sent for signature, site visit counter) with the real plugin tools in draft and dry-run modes, attaches evidence and files a pass or fail report. A failure opens an issue for the role that owns it.";

export const ACCEPTANCE_INSTRUCTIONS = `# Acceptance (Acceptance tester), Partners in Biz

You use the product the way a customer would, so a release that passes its unit tests but does not work is found before a client finds it.

- Follow the **${SKILL_SLUGS.acceptance}** skill. It holds the journeys, the rules (the canary client only, drafts and dry runs only), how to report each step and how to file the result.
- Your work arrives as an "Acceptance request" issue: every night, when a plugin is released, or when a person or the Operator asks.
- Never touch a real client. Every run starts with the canary client from \`partnersinbiz.crm:create-canary-client\`; the Cockpit refuses anything else and stops a run that used a real address.
- Never approve, send, publish or pay anything. A step that opens an approval is checked for where it went; you leave it alone.
- Report what happened, not what you expected. A step that failed is a finding, not something to work around.
`;

export const ACCEPTANCE_ROLE: HireRole = {
  pluginKey: PLUGIN_KEY,
  pluginName: "Cockpit",
  roleKey: ACCEPTANCE_ROLE_KEY,
  displayName: "Acceptance",
  title: "Acceptance tester",
  role: "qa",
  icon: "test-tube",
  capabilities: ACCEPTANCE_CAPABILITIES,
  adapterPreference: ["claude_local"],
  skills: [
    {
      key: ACCEPTANCE_SKILL_KEY,
      slug: SKILL_SLUGS.acceptance,
      purpose: "the customer journeys on the canary client, how to run and report each step, the evidence to attach (including screenshots) and how a failure is filed",
    },
    PAPERCLIP_HIRE_SKILL,
    COMPANY_OS_HIRE_SKILL,
  ],
  budgetMonthlyCents: ACCEPTANCE_BUDGET_CENTS,
  suggestedManager: "the Operator",
  instructions: ACCEPTANCE_INSTRUCTIONS,
  pluginSetup: [
    "Grants the agent `tools:use` for plugin tools, so it can call the CRM, Billing, Social, SEO and Cockpit tools the journeys use.",
    `Keeps the \`${SKILL_SLUGS.acceptance}\` and \`${SKILL_SLUGS.companyOs}\` skills up to date.`,
    "Opens an \"Acceptance request\" for it every night (the lead capture journey), when a plugin is released (the journeys that exercise it) and when asked.",
    "Watches the results: a journey that fails opens an issue for the role that owns the step, and the System health issue says so until it passes.",
  ],
  toolPlugins: [PLUGIN_KEY, "partnersinbiz.crm", "partnersinbiz.billing", "partnersinbiz.social", "partnersinbiz.seo"],
  runProfile: ACCEPTANCE_RUN_PROFILE,
};

/** For finding and linking the agent: matched on the role's own skill only (every hire carries the manual and the paperclip skill). */
export const ACCEPTANCE_MATCH_ROLE: HireRole = { ...ACCEPTANCE_ROLE, skills: ACCEPTANCE_ROLE.skills.filter((skill) => skill.key === ACCEPTANCE_SKILL_KEY) };

export async function acceptanceAgentId(env: Env, companyId: string): Promise<string | null> {
  return linkedAgentId(env.ctx, companyId, ACCEPTANCE_MATCH_ROLE).catch(() => null);
}

/** What happens when the agent is linked (by hand, or when its hire task's agent appears): skills and tool access. */
export function onAcceptanceLinked(env: Env): OnAgentLinked {
  return async (companyId, agentId, by) => {
    const steps: string[] = [];
    const agent = await env.ctx.agents.get(agentId, companyId).catch(() => null);
    const name = agent ? String(agent.name) : "the agent";
    const skills = await env.skills.force(companyId).catch((error) => [{ skillKey: SKILL_SLUGS.acceptance, action: "failed" as const, error: message(error) }]);
    const failed = skills.filter((s) => s.action === "failed");
    steps.push(failed.length === 0 ? `Synced the \`${SKILL_SLUGS.acceptance}\` skill.` : `The skills did not sync (${failed.map((s) => s.error ?? "failed").join("; ")}). Link the agent again to retry.`);
    const grant = await grantPluginTools(env, companyId, agentId, by.userId);
    if (grant.state === "added") steps.push("Granted plugin tool access (`tools:use` for plugin tools).");
    else if (grant.state === "already_present") steps.push("Plugin tool access was already granted.");
    else if (grant.state === "conflict") steps.push(`Plugin tool access was not changed: ${grant.detail}`);
    else steps.push(`Tool access could not be granted automatically (${grant.detail}). Grant ${name} tools:use for plugin tools in its permissions.`);
    const status = agent ? String(agent.status) : "";
    if (status === "pending_approval") steps.push(`Approve the ${name} hire in Approvals.`);
    if (status === "paused" || status === "pending_approval") steps.push(`Open Agents → ${name}, check its adapter has a working model key, then click Resume.`);
    return steps;
  };
}

/** Hourly: a hire whose agent appeared while an agent event was missed. Only for companies that have saved a team (the Cockpit acts for them). */
export async function linkPendingAcceptance(env: Env): Promise<number> {
  let linked = 0;
  for (const row of await listRoles(env.ctx)) {
    try {
      if (await tryLinkPendingHire(env.ctx, row.companyId, ACCEPTANCE_MATCH_ROLE, onAcceptanceLinked(env))) linked += 1;
    } catch (error) {
      env.ctx.logger.info("Cockpit acceptance hire link check failed", { companyId: row.companyId, error: message(error) });
    }
  }
  return linked;
}
