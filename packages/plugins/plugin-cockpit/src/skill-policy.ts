/**
 * The company skill policy (audit Q2-10): who may change skills. Both live
 * companies had no policy, so any agent in a company could create, edit, import or
 * remove its skills through the API; `canCreateSkills` is never consulted. The
 * host's policy is the only thing that restricts it: ordered rules (lowest
 * priority number first, first match wins) over an action, a subject (agents,
 * roles) and optionally which skills.
 *
 * A plugin cannot write a company's policy (it is a board route), so this builds the
 * exact PUT body for the board or the deploy to apply. Plugin sync is not an agent
 * action and is never blocked by it.
 *
 * The shape of the rules:
 * 1. Neither the Reflection Coach nor the Operator may change a plugin-managed skill
 *    (the plugin would overwrite it, and nothing would measure it): changes to those
 *    go through propose-skill-change, a pull request and the eval gate. The
 *    Operator's candidate test copies are separate skills with their own keys.
 * 2. The Operator may create, edit and remove other skills and run tests: it makes
 *    the test copies the evals use. The coach may change skills no plugin manages.
 * 3. Every agent may run a skill test.
 * 4. Every other agent action that changes a skill is denied.
 */
export const SKILL_MUTATION_ACTIONS = ["skills.create", "skills.import", "skills.install", "skills.edit", "skills.update", "skills.reset", "skills.remove"] as const;
export const SKILL_OPERATOR_ACTIONS = ["skills.create", "skills.edit", "skills.update", "skills.remove", "skills.test"] as const;

export interface PolicyRule {
  id: string;
  priority: number;
  effect: "allow" | "deny";
  subject: { type: "all_agents" } | { type: "agents"; agentIds: string[] };
  actions: string[];
  resources?: { skillKeys: string[] };
}

export interface SkillPolicyBody {
  expectedRevision: number;
  schemaVersion: 1;
  defaultEffect: "allow";
  rules: PolicyRule[];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildSkillPolicy(input: { expectedRevision?: number; operatorAgentId: string | null; coachAgentId: string | null; managedSkillKeys?: string[] }): { body: SkillPolicyBody; notes: string[] } {
  const notes: string[] = [];
  const rules: PolicyRule[] = [];
  const operator = input.operatorAgentId && GUID.test(input.operatorAgentId) ? input.operatorAgentId : null;
  const coach = input.coachAgentId && GUID.test(input.coachAgentId) ? input.coachAgentId : null;
  const keys = [...new Set((input.managedSkillKeys ?? []).map((k) => k.trim()).filter(Boolean))].slice(0, 500);
  const guarded = [coach, operator].filter((id): id is string => !!id);
  if (guarded.length && keys.length) rules.push({ id: "no-edits-to-plugin-skills", priority: 5, effect: "deny", subject: { type: "agents", agentIds: guarded }, actions: [...SKILL_MUTATION_ACTIONS], resources: { skillKeys: keys } });
  else if (guarded.length) notes.push("No plugin-managed skill keys were given, so the coach and the Operator may still change a plugin's skills (the plugin overwrites them at the next sync). List them with GET /api/companies/{companyId}/skills (keys starting plugin/) and build the policy again with managedSkillKeys.");
  if (coach) rules.push({ id: "coach-may-change-its-own-skills", priority: 12, effect: "allow", subject: { type: "agents", agentIds: [coach] }, actions: [...SKILL_MUTATION_ACTIONS, "skills.test"] });
  else notes.push("No Reflection Coach is provisioned yet: build this again after it is (POST /api/companies/{companyId}/built-in-agents/reflection-coach/provision), so the coach rules are included.");
  if (operator) rules.push({ id: "operator-test-copies", priority: 10, effect: "allow", subject: { type: "agents", agentIds: [operator] }, actions: [...SKILL_OPERATOR_ACTIONS] });
  else notes.push("No Operator is linked: nobody can make the test copies the evals use until one is (Setup → Team).");
  rules.push({ id: "agents-may-test-skills", priority: 20, effect: "allow", subject: { type: "all_agents" }, actions: ["skills.test"] });
  rules.push({ id: "agents-may-not-change-skills", priority: 30, effect: "deny", subject: { type: "all_agents" }, actions: [...SKILL_MUTATION_ACTIONS] });
  notes.push("Humans on the board are not affected by rules about agents. The plugins' own skill sync is not an agent action and keeps working.");
  rules.sort((a, b) => a.priority - b.priority);
  return { body: { expectedRevision: input.expectedRevision ?? 0, schemaVersion: 1, defaultEffect: "allow", rules }, notes };
}

/** Where an agent is the built-in Reflection Coach: the host marks it in its metadata, and names it. */
export function isReflectionCoach(agent: Record<string, unknown>): boolean {
  const marker = (agent.metadata as Record<string, unknown> | null | undefined)?.paperclipBuiltInAgent as { key?: unknown } | undefined;
  if (marker?.key === "reflection-coach") return true;
  return String(agent.name ?? "").trim().toLowerCase() === "reflection coach";
}
