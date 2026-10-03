/**
 * The managed skills: the company operating manual (company-os), the
 * Operator and the Reviewer.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASK_OWNER_TOOL, ASKING_HEADING, COMPANY_MEMORY_HEADING, MODULES, TEAM_ROLES } from "@partnersinbiz/pib-plugin-kit";
import { COMPANY_OS_SKILL_KEY } from "@partnersinbiz/pib-plugin-kit/team";
import { COMPANY_FLOWS, COMPANY_SKILL_KEY, COMPANY_SKILL_SLUG, companySkillBody, toolNaming } from "../src/company-skill.js";
import { canonicalSkillKey, PLUGIN_KEY } from "../src/constants.js";
import { COMPANY_OS_SKILL_KEY as LOCAL_OS_KEY } from "../src/hire.js";
import manifest from "../src/manifest.js";
import { OPERATOR_SKILL_BODY, REVIEWER_SKILL_BODY, routingMap, SKILLS } from "../src/skills.js";
import { COCKPIT_TOOLS } from "../src/tools.js";
import { onboardingContent } from "../src/onboarding.js";
import { routineFailedCheck } from "@partnersinbiz/pib-plugin-kit";
import { blockedCheck, retryStormChecks, runRateChecks, runStreakChecks, stalledCheck } from "../src/watch-model.js";

const skill = (slug: string) => SKILLS.find((s) => s.slug === slug)!;

describe("the company operating manual (company-os)", () => {
  const os = skill(COMPANY_SKILL_SLUG);

  it("is a Cockpit managed skill whose canonical key is the kit's COMPANY_OS_SKILL_KEY", () => {
    expect(os).toMatchObject({ skillKey: "company-os", slug: "pib-company-os", displayName: "PiB company operating manual" });
    expect(COMPANY_SKILL_KEY).toBe("company-os");
    expect(canonicalSkillKey(PLUGIN_KEY, os.skillKey)).toBe(COMPANY_OS_SKILL_KEY);
    expect(LOCAL_OS_KEY).toBe(COMPANY_OS_SKILL_KEY);
    expect(manifest.skills?.map((s) => s.skillKey)).toContain("company-os");
  });

  it("names every team role and every module, and how their tools are named", () => {
    const body = companySkillBody();
    for (const role of TEAM_ROLES) expect(body, role.title).toContain(`**${role.title}**`);
    for (const module of Object.values(MODULES)) expect(body, module.title).toContain(module.title);
    expect(body).toContain(toolNaming());
    for (const key of ["cockpit", "crm", "mailbox", "social", "seo", "campaigns", "billing", "accounting", "payroll", "partners"]) expect(body, key).toContain(`(\`${key}\`) |`);
    expect(body).toContain(ASK_OWNER_TOOL);
    expect(body).toContain(COMPANY_FLOWS);
  });

  it("has valid frontmatter, the memory and asking sections, and stays under 19,000 characters", () => {
    const markdown = os.markdown!;
    const match = /^---\nname: (pib-company-os)\nslug: (pib-company-os)\ndescription: "([^"\n]+)"\n---\n\n# PiB company operating manual\n/.exec(markdown);
    expect(match, markdown.slice(0, 300)).not.toBeNull();
    expect(match![3]!.length).toBeGreaterThan(80);
    expect(markdown).toContain(COMPANY_MEMORY_HEADING);
    expect(markdown).toContain(ASKING_HEADING);
    expect(markdown.length).toBeLessThan(19_000);
    expect(companySkillBody().length).toBeLessThan(16_000);
  });

  it("says what is true of the code", () => {
    const body = companySkillBody();
    // The client workspace starts on the CRM page; agents cannot use Setup; a person connects social accounts.
    expect(body).toContain("`?client=company:<id>` on the CRM, Social, SEO, Campaigns and Billing pages");
    expect(body).toContain("the Operator gets the owner to fix it in Setup → Team");
    expect(body).toContain("once a person has connected their accounts");
    expect(body).not.toContain("connect their accounts and plan");
    // Cases: the manual names the API, the stable key rule and the types; the flow uses one.
    expect(body).toContain("`POST /api/companies/:companyId/cases`");
    expect(body).toContain("**stable `key`**");
    expect(body).toContain("writes the client's report as a `client_report` case");
    // A block without a way out is flagged after a day (the Cockpit's blocked check).
    expect(body).toContain("`blocked` with an `unblockDescriptor` (who must do what; a block with none is flagged after a day)");
  });
});

describe("the Operator skill", () => {
  it("speaks of the owner, never a name, in the skill, the hire and the routines", () => {
    for (const s of SKILLS) expect(s.markdown, s.slug).not.toMatch(/\bPeet\b/);
    expect(JSON.stringify(manifest.routines)).not.toMatch(/\bPeet\b/);
  });

  it("has who owns what from TEAM_ROLES, and the daily team check", () => {
    const map = routingMap();
    for (const role of TEAM_ROLES) expect(map, role.title).toContain(`**${role.title}**`);
    // The Account Manager also works in the modules of its extra skills.
    expect(map).toMatch(/\*\*Account Manager\*\* \| .+ \| CRM, Billing, Email campaigns, Mailbox \(Gmail\), Partners \|/);
    expect(OPERATOR_SKILL_BODY).toContain(map);
    for (const text of [
      "routines on, roles staffed (Setup → Team), asks answered",
      "Route unassigned work",
      "`company-brief` → `team`",
      "Onboard new client",
      `\`${PLUGIN_KEY}:ask-owner\``,
      `\`${PLUGIN_KEY}:update-company-profile\``,
      "Never assign issues to people yourself",
    ]) expect(OPERATOR_SKILL_BODY, text).toContain(text);
    expect(OPERATOR_SKILL_BODY).not.toContain("leads → CRM owner");
    expect(OPERATOR_SKILL_BODY).not.toContain("invoices → Bookkeeper");
  });
});

describe("the Operator knows how to act on each watch problem", () => {
  const demo = new Date("2026-10-03T12:00:00.000Z");
  const agents = new Map([["seo", { id: "seo", name: "SEO Specialist" }]]);
  const titles = () => [
    routineFailedCheck({ routineKey: "k", title: "Run today's SEO", pluginTitle: "SEO", routineId: "r", at: demo.toISOString() }).title,
    runRateChecks([{ agentId: "seo", status: "succeeded", errorCode: null, count: 10 }, { agentId: "seo", status: "failed", errorCode: "x", count: 10 }], agents)[0]!.title,
    runStreakChecks(Array.from({ length: 3 }, (_, i) => ({ agentId: "seo", status: "failed", errorCode: "adapter_failed", startedAt: new Date(demo.getTime() - i * 60_000).toISOString(), issueId: null, identifier: null })), agents)[0]!.title,
    retryStormChecks([{ issueId: "i", identifier: "PAR-1", title: null, failed: 5, errorCode: null, codes: 0, agentId: null, firstFailedAt: null, lastError: null }], agents)[0]!.title,
    blockedCheck([{ id: "b", identifier: "PAR-2", title: "t", since: "2026-09-28T00:00:00.000Z" }], 1, demo)!.title,
    stalledCheck([{ id: "s", identifier: "PAR-3", title: "t", assigneeAgentId: "seo", updatedAt: "2026-10-02T00:00:00.000Z", lastRunAt: null }], 1, agents, demo)!.title,
  ];

  it("quotes the words each problem is titled with, so a renamed check cannot orphan its instructions", () => {
    const [routine, rate, streak, storm, blocked, stalled] = titles();
    expect(routine).toContain("failed its last run");
    expect(rate).toMatch(/failed \d+% of its runs$/);
    expect(streak).toContain("times in a row with");
    expect(storm).toContain("keeps failing");
    expect(blocked).toContain("blocked with no way out");
    expect(stalled).toContain("in progress with nobody working on");
    for (const text of ["failed its last run", "% of its runs", "times in a row with", "keeps failing", "blocked with no way out", "in progress with nobody working on"]) expect(OPERATOR_SKILL_BODY, text).toContain(text);
  });

  it("says what to do: never just retry, give a blocked issue a way out, wake a stalled assignee", () => {
    for (const text of [
      "never just retry",
      "spawn E2BIG",
      "continuation issue",
      "workspace_validation_failed",
      "`blockedByIssueIds`",
      "`unblockDescriptor`",
      "PATCH /api/issues/{id}",
      "set it `todo` and wake the assignee, or cancel it with a reason",
      "assignee idle for 12 hours",
    ]) expect(OPERATOR_SKILL_BODY, text).toContain(text);
  });

  it("tells the Operator only what the host lets it do about a failed routine: read the runs, hand the run to the assignee", () => {
    const line = OPERATOR_SKILL_BODY.split("\n").find((l) => l.includes("failed its last run"))!;
    // Reading a routine's runs is open to every agent; running one is not (the host answers 403 unless the agent is its assignee).
    expect(line).toContain("`GET /api/routines/{id}/runs` (any agent");
    expect(line).toContain("only its assignee may `POST /api/routines/{id}/run`");
    expect(line).toContain("(you, for the Cockpit's own routines)");
    expect(line).toContain('open an issue for the assignee: "Run <routine> once now and report"');
    expect(line).toContain("or at the next schedule");
    // No role this plugin cannot name for every company, and no button the Operator may not press.
    expect(line).toContain("the role that owns code, or the owner if none");
    for (const text of ["Developer", "Run now"]) expect(OPERATOR_SKILL_BODY, text).not.toContain(text);
    // The same promise in the check's own fix text, so the skill and the check cannot drift apart.
    const fix = routineFailedCheck({ routineKey: "k", title: "Run today's SEO", pluginTitle: "SEO", routineId: "r-1", at: demo.toISOString() }).fix!;
    expect(fix).toContain("only the routine's assignee (or the owner) may POST /api/routines/r-1/run");
    expect(fix).toContain("open an issue for the assignee");
  });

  it("stays inside the skill budget with room to spare, and the manual inside its own", () => {
    const operator = skill("pib-operator");
    expect(operator.markdown!.length).toBeLessThan(17_950);
    expect(skill(COMPANY_SKILL_SLUG).markdown!.length).toBeLessThan(18_000);
    expect(companySkillBody().length).toBeLessThan(16_000);
  });
});

describe("the Reviewer skill", () => {
  it("drops checks nobody can do and matches the modules' opt-out standard", () => {
    for (const gone of ["preview text", "Renders on mobile", "physical address", "company settings", "brand profile"]) expect(REVIEWER_SKILL_BODY, gone).not.toContain(gone);
    expect(REVIEWER_SKILL_BODY).toContain("reply STOP");
    expect(REVIEWER_SKILL_BODY).toContain("List-Unsubscribe");
    expect(REVIEWER_SKILL_BODY).toContain(`\`${PLUGIN_KEY}:company-profile\``);
    expect(REVIEWER_SKILL_BODY).toContain("`partnersinbiz.crm:get-client-profile`");
    expect(REVIEWER_SKILL_BODY).toContain("Timing, when it has a time");
  });

  it("names only tools that exist (other modules' tools read from their declarations)", () => {
    const declared = (plugin: string) => {
      const source = readFileSync(new URL(`../../plugin-${plugin}/src/tools.ts`, import.meta.url), "utf8");
      return new Set([...source.matchAll(/name: "([a-z0-9-]+)"/g)].map((m) => m[1]!));
    };
    const own = new Set(COCKPIT_TOOLS.map((t) => t.name));
    // The Reviewer's and the Operator's tool names, and the onboarding checklist's.
    const texts = [REVIEWER_SKILL_BODY, OPERATOR_SKILL_BODY, onboardingContent({ clientRef: "company:x", clientName: "X", dealTitle: "d", dealValue: null, wonAt: "2026-09-26", prefix: null, modules: { crm: true, billing: true, social: true, seo: true }, staff: {} }).description];
    const mentioned = [...new Set(texts.flatMap((text) => [...text.matchAll(/partnersinbiz\.([a-z]+):([a-z0-9-]+)/g)].map((m) => `${m[1]}:${m[2]}`)))];
    expect(mentioned.length).toBeGreaterThan(10);
    for (const ref of mentioned) {
      const [plugin, name] = ref.split(":") as [string, string];
      const tools = plugin === "cockpit" ? own : declared(plugin);
      expect(tools.has(name), `partnersinbiz.${ref}`).toBe(true);
    }
    // The SEO checks named without the prefix exist too.
    for (const name of ["check-meta", "check-canonical", "validate-schema", "crawler-sim"]) expect(declared("seo").has(name), name).toBe(true);
  });
});
