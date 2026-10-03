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
