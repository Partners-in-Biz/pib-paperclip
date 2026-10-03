/**
 * The company skill policy the Cockpit builds for the board to apply (Q2-10): the
 * body must pass the host's own validator, and the rules must do what they say when
 * the host evaluates them (lowest priority first, the first rule that matches wins).
 * The evaluator below mirrors `server/src/services/company-skill-policy.ts`
 * (`evaluate`: sort by priority then id, subject and resource match, first match).
 */
import { describe, expect, it } from "vitest";
import { replaceSkillPolicySchema, type SkillPolicyRule } from "../../../shared/src/validators/skill-policy.js";
import { buildSkillPolicy, isReflectionCoach, SKILL_MUTATION_ACTIONS } from "../src/skill-policy.js";

const OP = "dcb6c10e-0bba-42a6-aeb2-c4dd8b6bf3db";
const COACH = "c0ac4000-0000-4000-8000-000000000001";
const OTHER = "aaaaaaaa-0000-4000-8000-0000000000a5";
const KEYS = ["plugin/partnersinbiz.cockpit/pib-operator", "plugin/partnersinbiz.cockpit/pib-reviewer", "plugin/partnersinbiz.crm/pib-crm"];

type Rule = ReturnType<typeof buildSkillPolicy>["body"]["rules"][number];

function allowed(rules: Rule[], defaultEffect: "allow" | "deny", agentId: string, action: string, skillKey?: string): { allowed: boolean; rule: string | null } {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const match = sorted.find((rule) => {
    if (!rule.actions.includes(action)) return false;
    const subject = rule.subject.type === "all_agents" ? true : rule.subject.agentIds.includes(agentId);
    if (!subject) return false;
    if (rule.resources?.skillKeys && (!skillKey || !rule.resources.skillKeys.includes(skillKey))) return false;
    return true;
  });
  return match ? { allowed: match.effect === "allow", rule: match.id } : { allowed: defaultEffect === "allow", rule: null };
}

describe("buildSkillPolicy", () => {
  const full = buildSkillPolicy({ operatorAgentId: OP, coachAgentId: COACH, managedSkillKeys: KEYS });

  it("is a body the host accepts: its own validator parses it", () => {
    const parsed = replaceSkillPolicySchema.safeParse(full.body);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(full.body).toMatchObject({ expectedRevision: 0, schemaVersion: 1, defaultEffect: "allow" });
    // The same body with no coach, no Operator and no keys is valid too.
    expect(replaceSkillPolicySchema.safeParse(buildSkillPolicy({ operatorAgentId: null, coachAgentId: null }).body).success).toBe(true);
  });

  it("uses only actions the host knows, with unique rule ids and priorities that decide the order", () => {
    const ids = full.body.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["no-edits-to-plugin-skills", "operator-test-copies", "coach-may-change-its-own-skills", "agents-may-test-skills", "agents-may-not-change-skills"]);
    const priorities = full.body.rules.map((r) => r.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });

  it("an agent that is neither the Operator nor the coach cannot create, edit, import, install, reset or remove any skill, but can run a test", () => {
    for (const action of SKILL_MUTATION_ACTIONS) {
      expect(allowed(full.body.rules, "allow", OTHER, action, "workspace/anything"), action).toEqual({ allowed: false, rule: "agents-may-not-change-skills" });
      expect(allowed(full.body.rules, "allow", OTHER, action, KEYS[0]), action).toMatchObject({ allowed: false });
    }
    expect(allowed(full.body.rules, "allow", OTHER, "skills.test", KEYS[0])).toEqual({ allowed: true, rule: "agents-may-test-skills" });
  });

  it("the coach cannot change a skill a plugin manages (the plugin would overwrite it), but may change the others and test any", () => {
    for (const action of SKILL_MUTATION_ACTIONS) expect(allowed(full.body.rules, "allow", COACH, action, KEYS[1]), action).toEqual({ allowed: false, rule: "no-edits-to-plugin-skills" });
    expect(allowed(full.body.rules, "allow", COACH, "skills.edit", "workspace/coach-notes")).toEqual({ allowed: true, rule: "coach-may-change-its-own-skills" });
    expect(allowed(full.body.rules, "allow", COACH, "skills.test", KEYS[0])).toMatchObject({ allowed: true });
  });

  it("the Operator may make and remove test copies and run tests, but never edits a plugin-managed skill", () => {
    for (const action of ["skills.create", "skills.edit", "skills.update", "skills.remove", "skills.test"]) expect(allowed(full.body.rules, "allow", OP, action, "workspace/pib-operator-candidate-abc123"), action).toEqual({ allowed: true, rule: "operator-test-copies" });
    for (const action of ["skills.edit", "skills.update", "skills.remove"]) expect(allowed(full.body.rules, "allow", OP, action, KEYS[0]), action).toEqual({ allowed: false, rule: "no-edits-to-plugin-skills" });
    // It still tests the live skill: that is how the evals run.
    expect(allowed(full.body.rules, "allow", OP, "skills.test", KEYS[0])).toEqual({ allowed: true, rule: "operator-test-copies" });
    // Import, install and reset stay with the board.
    for (const action of ["skills.import", "skills.install", "skills.reset"]) expect(allowed(full.body.rules, "allow", OP, action, "workspace/x"), action).toEqual({ allowed: false, rule: "agents-may-not-change-skills" });
  });

  it("with no coach and no keys it says what is missing instead of pretending to be complete", () => {
    const bare = buildSkillPolicy({ operatorAgentId: OP, coachAgentId: null });
    expect(bare.body.rules.map((r) => r.id)).toEqual(["operator-test-copies", "agents-may-test-skills", "agents-may-not-change-skills"]);
    expect(bare.notes.join("\n")).toContain("No Reflection Coach is provisioned yet");
    expect(bare.notes.join("\n")).toContain("may still change a plugin's skills");
    const noOperator = buildSkillPolicy({ operatorAgentId: null, coachAgentId: COACH, managedSkillKeys: KEYS });
    expect(noOperator.notes.join("\n")).toContain("No Operator is linked");
    expect(noOperator.body.rules.find((r) => r.id === "no-edits-to-plugin-skills")!.subject).toEqual({ type: "agents", agentIds: [COACH] });
  });

  it("ignores an agent id that is not a UUID (the host would refuse the whole body), and de-duplicates keys", () => {
    const odd = buildSkillPolicy({ operatorAgentId: "not-a-uuid", coachAgentId: COACH, managedSkillKeys: [KEYS[0]!, KEYS[0]!, " ", ""] });
    expect(odd.body.rules.some((r) => r.id === "operator-test-copies")).toBe(false);
    expect(odd.body.rules[0]!.resources).toEqual({ skillKeys: [KEYS[0]] });
    expect(replaceSkillPolicySchema.safeParse(odd.body).success).toBe(true);
  });

  it("carries the revision the board read, and defaults to a first policy", () => {
    expect(buildSkillPolicy({ operatorAgentId: OP, coachAgentId: null, expectedRevision: 3 }).body.expectedRevision).toBe(3);
  });
});

describe("isReflectionCoach", () => {
  it("knows the built-in agent by its marker or its name", () => {
    expect(isReflectionCoach({ name: "Anything", metadata: { paperclipBuiltInAgent: { key: "reflection-coach" } } })).toBe(true);
    expect(isReflectionCoach({ name: " Reflection Coach " })).toBe(true);
    expect(isReflectionCoach({ name: "Olive", metadata: { paperclipBuiltInAgent: { key: "other" } } })).toBe(false);
    expect(isReflectionCoach({ name: "Olive" })).toBe(false);
  });
});

// Keeps the type import honest: the rule shape the plugin builds is the host's.
export type _RuleShape = SkillPolicyRule;
