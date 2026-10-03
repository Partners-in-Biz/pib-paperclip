/**
 * Do the staffed agents hold what their role says they need? (Q9-8, Q7-3)
 *
 * The gap. A skill or a tool grant reached an agent only through a person's
 * click (Setup -> Team) or a hand-run CLI step, and nothing compared the two.
 * Live: `wp-sites` attached to nobody, 5 of 20 PAR agents and all 8 PARA agents
 * without the company manual, 7-8 active agents without the plugin-tools grant
 * (so they could never recall memory).
 *
 * What a plugin can do. A plugin worker CANNOT attach a skill or change an
 * agent's grants beyond what the Cockpit already does at link time: the SDK has
 * no such call (`ctx.agents` reads, pauses, resumes and invokes; the browser
 * helper `agent-client.ts` attaches skills as the signed-in board user). So
 * this module detects and reports, with the board action as the fix.
 *
 * Needs `agents.read` and (for grants) `authorization.grants.read`; the Cockpit
 * has both. A missing capability makes that half unreadable, not an error.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { agentDesiredSkills } from "./agent-hire.js";
import { readCompanyRoles, type HealthCheck, type RolesPayload } from "./cockpit.js";
import { coversPluginTools, toolsMissing, type GrantLike } from "./grants.js";
import { MEMORY_AGENT_TOOLS } from "./memory.js";
import type { ModuleKey } from "./setup.js";
import { activeTeamRoles, teamSetupPath, type TeamRole, type TeamRoleKey } from "./team.js";

export type RoleDriftKind = "missing_skill" | "missing_optional_skill" | "no_tools_grant" | "limited_tools_grant";

export interface RoleDriftProblem {
  role: TeamRoleKey;
  roleTitle: string;
  agentId: string;
  agentName: string;
  kind: RoleDriftKind;
  /** The canonical skill key, for skill problems. */
  skill?: string;
  /** Required problems count in the health check; optional ones (extra skills of other modules) do not. */
  required: boolean;
  message: string;
  fix: string;
  href: string;
}

export interface RoleDriftReport {
  /** Staffed roles whose agent was read. */
  checked: number;
  problems: RoleDriftProblem[];
  /** False when the grants could not be read (capability missing or the call failed). */
  grantsChecked: boolean;
  /** The health check to publish; null when there are no required problems. */
  check: HealthCheck | null;
}

function lastSegment(key: string): string {
  return key.split("/").pop() ?? key;
}

/**
 * True when the agent's attached skills include the expected one: the canonical
 * key, the same skill under a different plugin path, or its `pib-` slug.
 */
export function skillAttached(desired: string[], expected: string): boolean {
  const wanted = expected.toLowerCase();
  const last = lastSegment(wanted);
  return desired.some((have) => {
    const key = have.toLowerCase();
    return key === wanted || key === last || key === `pib-${last}` || key.endsWith(`/${last}`) || key.endsWith(`/pib-${last}`);
  });
}

/** The agent each staffed role has, from the roles copy (Operator and Reviewer come with their own fields). */
export function staffedAgents(roles: RolesPayload | null, active: TeamRole[]): Array<{ role: TeamRole; agentId: string }> {
  if (!roles) return [];
  const out: Array<{ role: TeamRole; agentId: string }> = [];
  for (const role of active) {
    const agentId = role.key === "operator" ? roles.operatorAgentId ?? roles.team?.operator?.agentId : role.key === "reviewer" ? roles.reviewerAgentId ?? roles.team?.reviewer?.agentId : roles.team?.[role.key]?.agentId;
    if (agentId) out.push({ role, agentId });
  }
  return out;
}

const GONE = new Set(["terminated", "archived", "deleted"]);

/**
 * Compares every staffed kit role's expected skills (the role's own skills; the
 * extra skills of other modules as optional) and plugin-tools grant with what
 * the agent actually has. Returns the problems and one health check for the
 * Cockpit: "<agent> (<role>) lacks skill <key> (attach in Setup -> Team)".
 */
export async function roleDriftCheck(
  ctx: PluginContext,
  companyId: string,
  options: { roles?: RolesPayload | null; modules?: Partial<Record<ModuleKey, boolean>> | null; includeOptional?: boolean } = {},
): Promise<RoleDriftReport> {
  const roles = options.roles !== undefined ? options.roles : (await readCompanyRoles(ctx, companyId)).roles;
  const problems: RoleDriftProblem[] = [];
  let checked = 0;
  let grantsChecked = true;
  for (const { role, agentId } of staffedAgents(roles, activeTeamRoles(options.modules))) {
    let agent: Record<string, unknown> | null = null;
    try {
      agent = (await ctx.agents.get(agentId, companyId)) as unknown as Record<string, unknown> | null;
    } catch {
      agent = null;
    }
    if (!agent || GONE.has(String(agent.status ?? ""))) continue;
    checked += 1;
    const agentName = String(agent.name ?? "The agent");
    const href = teamSetupPath(role.key);
    const desired = agentDesiredSkills(agent);
    const base = { role: role.key, roleTitle: role.title, agentId, agentName, href };
    for (const skill of role.skills) {
      if (!skillAttached(desired, skill)) {
        problems.push({ ...base, kind: "missing_skill", skill, required: true, message: `${agentName} (${role.title}) lacks skill ${skill}`, fix: `Attach it in Setup → Team on the ${role.title} row (Fix skills), or Agents → ${agentName} → Skills.` });
      }
    }
    for (const skill of role.extraSkills ?? []) {
      if (!skillAttached(desired, skill)) {
        problems.push({ ...base, kind: "missing_optional_skill", skill, required: false, message: `${agentName} (${role.title}) does not have the optional skill ${skill}`, fix: `Attach it in Setup → Team if the ${lastSegment(skill)} module is in use.` });
      }
    }
    if (grantsChecked) {
      try {
        const grants = (await ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId })).map((grant): GrantLike => ({ permissionKey: String(grant.permissionKey), scope: (grant.scope as Record<string, unknown> | null) ?? null }));
        const tools = grants.filter((grant) => grant.permissionKey === "tools:use");
        if (tools.length === 0) {
          problems.push({ ...base, kind: "no_tools_grant", required: true, message: `${agentName} (${role.title}) has no plugin tool access (tools:use), so it cannot call PiB tools or recall memory`, fix: `Re-save the ${role.title} on Setup → Team (it grants plugin tools), or grant tools:use for plugin tools in Agents → ${agentName} → Permissions.` });
        } else if (!tools.some((grant) => coversPluginTools(grant.scope))) {
          // A grant limited to named tools is a person's choice (least privilege): it is a problem only when it leaves out the memory tools every agent needs.
          const missing = toolsMissing(tools, MEMORY_AGENT_TOOLS);
          if (missing.length > 0) {
            problems.push({ ...base, kind: "limited_tools_grant", required: true, message: `${agentName} (${role.title}) has a tools grant that does not cover the company-memory tools (${missing.map((name) => name.split(":").pop()).join(", ")})`, fix: `Add the memory tools (or all plugin tools) to its tools:use grant in Agents → ${agentName} → Permissions.` });
          } else {
            problems.push({ ...base, kind: "limited_tools_grant", required: false, message: `${agentName} (${role.title}) has a narrowed tools grant (named tools, memory included)`, fix: `Confirm it also lists the tools the ${role.title} needs for its module work; a narrowed grant is fine for an agent that only needs memory.` });
          }
        }
      } catch {
        grantsChecked = false;
      }
    }
  }
  const required = problems.filter((p) => p.required);
  const visible = options.includeOptional ? problems : required;
  const check: HealthCheck | null = required.length === 0 ? null : {
    key: "roles:drift",
    title: "Agents missing skills or tool access",
    status: "warn",
    detail: `${required.length} thing${required.length === 1 ? " is" : "s are"} missing on staffed agents: ${visible.slice(0, 6).map((p) => `${p.message} (attach in Setup → Team)`).join("; ")}${visible.length > 6 ? "; ..." : ""}.`,
    fix: "Open Setup → Team and use Fix skills on the row, or attach the skill under Agents → the agent → Skills. A plugin cannot attach skills itself.",
    href: teamSetupPath(),
  };
  return { checked, problems: options.includeOptional ? problems : required, grantsChecked, check };
}
