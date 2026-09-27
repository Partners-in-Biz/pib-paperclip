/**
 * Cross-plugin contract: what the skills promise agents must exist.
 *
 * Renders every PiB plugin's manifest (tools, jobs, managed skills) plus the
 * company operating manual and checks:
 * - every tool a skill names (`partnersinbiz.<plugin>:<tool>` or a backticked
 *   tool-like name) is a real tool (or a job, for the few skills that name jobs);
 * - every team role's skills are declared by the plugin that owns them;
 * - every PiB skill carries the company memory and asking sections;
 * - every agent tool parameter is described, so agents know what to pass;
 * - skills stay within a size budget.
 *
 * Run with `npx vitest run --config vitest.contract.config.ts` (also part of
 * `pnpm test`). It reads plugin sources, so run it after changing any skill,
 * tool or team role.
 */
import { describe, expect, it } from "vitest";
import { ASKING_HEADING, COMPANY_MEMORY_HEADING, COMPANY_OS_SKILL_KEY, TEAM_ROLES, teamSkillKey } from "../src/index.js";

type Tool = { name: string; description?: string; parametersSchema?: Record<string, unknown> };
type Skill = { skillKey: string; markdown?: string };
type Manifest = { id: string; tools?: Tool[]; skills?: Skill[]; jobs?: Array<{ jobKey: string }> };

const PLUGINS = ["cockpit", "crm", "mailbox", "social", "seo", "campaigns", "billing", "accounting", "payroll", "partners", "setup"] as const;

async function loadManifests(): Promise<Manifest[]> {
  const out: Manifest[] = [];
  for (const p of PLUGINS) out.push((await import(`../../plugin-${p}/src/manifest.ts`)).default as Manifest);
  return out;
}

/** The upstream LLM Wiki tools the manual may name (its manifest reads files at import time). */
const WIKI_TOOLS = ["wiki_search", "wiki_read_page", "wiki_write_page", "wiki_propose_patch", "wiki_list_sources", "wiki_read_source", "wiki_append_log", "wiki_update_index", "wiki_list_backlinks", "wiki_list_pages"];

/** Backticked words that look like tools but are not (statuses, events, keys). */
const NOT_TOOLS = new Set<string>([]);

const TOOLISH = /^(create|get|list|update|set|find|add|record|import|prepare|request|send|mark|link|unlink|move|convert|schedule|publish|validate|propose|decide|approve|lock|calculate|adjust|export|search|ask|memory|complete|launch|pause|resume|enroll|draft|delete|archive|check|start|stop|refresh|sync|pull|query|submit|inspect|gsc|read|write|reply|triage|attach|upload|download|render|void|apply|reconcile|match|reject|accept|close|assign|preview|share|revoke|grant|audit)-/;

describe("skills ↔ tools contract", async () => {
  const manifests = await loadManifests();
  const { companySkillBody, COMPANY_SKILL_KEY } = await import("../../plugin-cockpit/src/company-skill.ts");
  const toolsByPlugin = new Map(manifests.map((m) => [m.id, new Set((m.tools ?? []).map((t) => t.name))]));
  toolsByPlugin.set("paperclipai.plugin-llm-wiki", new Set(WIKI_TOOLS));
  const anyName = new Set<string>([...manifests.flatMap((m) => [...(m.tools ?? []).map((t) => t.name), ...(m.jobs ?? []).map((j) => j.jobKey)]), ...WIKI_TOOLS]);
  const skills = manifests.flatMap((m) => (m.skills ?? []).map((s) => ({ plugin: m.id, key: s.skillKey, md: s.markdown ?? "" })));

  it("the operating manual is a Cockpit skill", () => {
    const os = skills.find((s) => s.plugin === "partnersinbiz.cockpit" && s.key === COMPANY_SKILL_KEY);
    expect(os, "Cockpit declares the company-os skill").toBeTruthy();
    expect(teamSkillKey("partnersinbiz.cockpit", COMPANY_SKILL_KEY)).toBe(COMPANY_OS_SKILL_KEY);
  });

  it("every tool a skill names exists", () => {
    const problems: string[] = [];
    const docs = [...skills, { plugin: "partnersinbiz.cockpit", key: "company-os (body)", md: companySkillBody() }];
    for (const s of docs) {
      for (const m of s.md.matchAll(/((?:partnersinbiz\.[a-z]+)|paperclipai\.plugin-llm-wiki):([a-z0-9_-]+)/g)) {
        const [, plugin, tool] = m;
        if (!toolsByPlugin.get(plugin!)?.has(tool!)) problems.push(`${s.plugin}/${s.key}: ${plugin}:${tool}`);
      }
      for (const m of s.md.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)) {
        const name = m[1]!;
        if (TOOLISH.test(name) && !anyName.has(name) && !NOT_TOOLS.has(name)) problems.push(`${s.plugin}/${s.key}: ${name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("every team role's skills are declared by their plugins", () => {
    const declared = new Set(manifests.flatMap((m) => (m.skills ?? []).map((s) => teamSkillKey(m.id, s.skillKey))));
    // Paperclip's own core skills (paperclipai/…) come with the host, not a plugin.
    const missing = TEAM_ROLES.flatMap((r) => [...r.skills, ...(r.extraSkills ?? [])].filter((k) => !k.startsWith("paperclipai/") && !declared.has(k)).map((k) => `${r.key}: ${k}`));
    expect(missing).toEqual([]);
  });

  it("every PiB skill carries the memory and asking sections", () => {
    const without = skills.filter((s) => !s.md.includes(COMPANY_MEMORY_HEADING) || !s.md.includes(ASKING_HEADING)).map((s) => `${s.plugin}/${s.key}`);
    expect(without).toEqual([]);
  });

  it("every agent tool parameter has a description", () => {
    const undescribed: string[] = [];
    for (const m of manifests) {
      for (const t of m.tools ?? []) {
        if (!t.description?.trim()) undescribed.push(`${m.id}:${t.name} (tool)`);
        const props = ((t.parametersSchema ?? {}) as { properties?: Record<string, { description?: string }> }).properties ?? {};
        for (const [name, schema] of Object.entries(props)) if (!schema?.description?.trim()) undescribed.push(`${m.id}:${t.name}.${name}`);
      }
    }
    expect(undescribed).toEqual([]);
  });

  it("skills stay within budget", () => {
    const tooBig = skills.filter((s) => s.md.length > 18_000).map((s) => `${s.plugin}/${s.key}: ${s.md.length} chars`);
    expect(tooBig).toEqual([]);
  });
});
