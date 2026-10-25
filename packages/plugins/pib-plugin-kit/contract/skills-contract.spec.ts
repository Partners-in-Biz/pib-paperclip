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
import { ASKING_HEADING, COMPANY_LIBRARY_SKILLS, COMPANY_MEMORY_HEADING, COMPANY_OS_SKILL_KEY, TEAM_ROLES, MERGE_FIELDS, SKILL_KEPT_TOKENS, WRITING_HEADING, findBrandLeaks, teamSkillKey, tokenSubstitutionCount } from "../src/index.js";

type Tool = { name: string; description?: string; parametersSchema?: Record<string, unknown> };
type Skill = { skillKey: string; markdown?: string; files?: Array<{ path: string; content: string }> };
type Manifest = { id: string; tools?: Tool[]; skills?: Skill[]; jobs?: Array<{ jobKey: string }> };

const PLUGINS = ["cockpit", "crm", "mailbox", "social", "seo", "campaigns", "billing", "accounting", "payroll", "partners", "setup", "ads"] as const;

async function loadManifests(): Promise<Manifest[]> {
  const out: Manifest[] = [];
  for (const p of PLUGINS) out.push((await import(`../../plugin-${p}/src/manifest.ts`)).default as Manifest);
  return out;
}

/**
 * Plugins whose skill text is scrubbed of the owner company's names (Peet, Elon,
 * "Partners in Biz", "PiB"): the lint below asserts `findBrandLeaks` finds
 * nothing in them. Starts empty. Each text child of the hosted-clients scrub
 * adds its plugin here in the same PR, so the lint grows with the scope.
 */
const SCRUBBED_PLUGINS: Array<(typeof PLUGINS)[number]> = ["crm"];

/** Product and protocol names a scrubbed plugin may keep: what a client really sees (the WordPress plugin, the signed-request headers, the canary company's stored name). */
const BRAND_KEEP = ["PiB Connector", "X-PiB-", "PiB Canary Co"];

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
    const missing = TEAM_ROLES.flatMap((r) => [...r.skills, ...(r.extraSkills ?? [])].filter((k) => !k.startsWith("paperclipai/") && !(COMPANY_LIBRARY_SKILLS as readonly string[]).includes(k) && !declared.has(k)).map((k) => `${r.key}: ${k}`));
    expect(missing).toEqual([]);
  });

  it("every PiB skill carries the memory, asking and writing sections", () => {
    const without = skills.filter((s) => !s.md.includes(COMPANY_MEMORY_HEADING) || !s.md.includes(ASKING_HEADING) || !s.md.includes(WRITING_HEADING)).map((s) => `${s.plugin}/${s.key}`);
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
    const tooBig = skills.filter((s) => s.md.length > 19_500).map((s) => `${s.plugin}/${s.key}: ${s.md.length} chars`);
    expect(tooBig).toEqual([]);
  });

  it("no company token or unknown {{token}} reaches a rendered skill", () => {
    const stray = (md: string) => [...md.matchAll(/\{\{\s*([A-Za-z_][\w.:-]*)\s*\}\}/g)].map((m) => m[1]!).filter((n) => !MERGE_FIELDS.includes(n) && !(SKILL_KEPT_TOKENS as readonly string[]).includes(n));
    const withToken = [...skills, { plugin: "partnersinbiz.cockpit", key: "company-os (body)", md: companySkillBody() }].filter((s) => stray(s.md).length > 0).map((s) => `${s.plugin}/${s.key}: ${stray(s.md).join(", ")}`);
    expect(withToken).toEqual([]);
  });

  it("the renderer changes no skill text yet: rendered equals raw until a child scrubs it", () => {
    // Every manifest above is loaded, so every skill went through withFrontmatter. A count above 0 means some skill
    // text now uses {{owner}} or {{ownerTitle}}: that changes what agents read, so the PR must say so and a child must own it.
    expect(tokenSubstitutionCount()).toBe(0);
    const crm = skills.find((s) => s.plugin === "partnersinbiz.crm" && s.md.includes("Merge tokens"));
    expect(crm?.md).toContain("`{{company}}`");
  });

  it("scrubbed plugins' skills name neither the owner nor the agency", () => {
    const leaks: string[] = [];
    for (const name of SCRUBBED_PLUGINS) {
      const id = manifests.find((m) => m.id === `partnersinbiz.${name}`)?.id;
      expect(id, `${name} is a loaded plugin`).toBeTruthy();
      const docs = skills.filter((s) => s.plugin === id);
      if (name === "cockpit") docs.push({ plugin: id!, key: "company-os (body)", md: companySkillBody() });
      for (const s of docs) for (const l of findBrandLeaks(s.md, { allow: BRAND_KEEP })) leaks.push(`${s.plugin}/${s.key}:${l.line} ${l.term}: ${l.excerpt}`);
    }
    expect(leaks).toEqual([]);
  });
});

/**
 * Wording the shared skill text must not carry: the owner company's people and names. The text reaches every company's
 * agents, so a client's agent must never read "Peet" or "Partners in Biz". Facts that belong to the owner company go in a
 * PiB-only skill (see `src/pib-only-skills.ts`); a plugin lists those keys in `PIB_ONLY_SKILLS` (exported from its
 * `src/manifest.ts`, as skill declarations or plain keys) and the scan skips them.
 */
const PIB_WORDING = /Peet|Partners in Biz|\bPiB\b/;

/**
 * Plugins whose skill text is not cleaned yet, one per line so a text PR deletes its own line and a conflict is one
 * line. There is no permanent exemption: the list must be empty when the last text PR has merged.
 */
const PENDING: Array<(typeof PLUGINS)[number]> = [
  "seo",
  "cockpit",
  "crm",
  "billing",
  "mailbox",
  "accounting",
  "payroll",
  "ads",
];

interface WordingHit {
  plugin: string;
  file: string;
  line: number;
  text: string;
}

/** Every line of a plugin's skill markdown and skill files that names the owner company, outside PiB-only skills. */
function wordingHits(plugin: string, skills: Skill[], pibOnly: string[], extra: Array<{ file: string; text: string }> = []): WordingHit[] {
  const docs = [
    ...skills.filter((s) => !pibOnly.includes(s.skillKey)).flatMap((s) => [{ file: `${s.skillKey} (markdown)`, text: s.markdown ?? "" }, ...(s.files ?? []).map((f) => ({ file: `${s.skillKey}/${f.path}`, text: f.content }))]),
    ...extra,
  ];
  return docs.flatMap((d) => d.text.split(/\r?\n/).flatMap((text, i) => (PIB_WORDING.test(text) ? [{ plugin, file: d.file, line: i + 1, text: text.trim().slice(0, 120) }] : [])));
}

describe("shared skill text names no owner company", async () => {
  const { companySkillBody } = await import("../../plugin-cockpit/src/company-skill.ts");
  const scanned = new Map<string, WordingHit[]>();
  for (const name of PLUGINS) {
    const mod = (await import(`../../plugin-${name}/src/manifest.ts`)) as { default: Manifest; PIB_ONLY_SKILLS?: Array<string | Skill> };
    const pibOnly = (mod.PIB_ONLY_SKILLS ?? []).map((s) => (typeof s === "string" ? s : s.skillKey));
    const extra = name === "cockpit" ? [{ file: "company-os (body)", text: companySkillBody() }] : [];
    scanned.set(name, wordingHits(name, mod.default.skills ?? [], pibOnly, extra));
  }
  const describeHits = (hits: WordingHit[]) => hits.map((h) => `${h.plugin} ${h.file}:${h.line} ${h.text}`);

  it("every plugin that is not pending is clean", () => {
    const hits = PLUGINS.filter((name) => !PENDING.includes(name)).flatMap((name) => scanned.get(name) ?? []);
    expect(describeHits(hits)).toEqual([]);
  });

  it("a pending plugin that is already clean leaves PENDING", () => {
    const clean = PENDING.filter((name) => (scanned.get(name) ?? []).length === 0);
    expect(clean, "delete these from PENDING in the same PR").toEqual([]);
  });

  it("skills listed in PIB_ONLY_SKILLS are skipped, others are reported with plugin, file and line", () => {
    const skills: Skill[] = [
      { skillKey: "pib-x-own", markdown: "Ask Peet." },
      { skillKey: "pib-x", markdown: "fine\nSend as Partners in Biz.", files: [{ path: "references/a.md", content: "ok\nok\nthe PiB team" }] },
    ];
    expect(wordingHits("x", skills, ["pib-x-own"])).toEqual([
      { plugin: "x", file: "pib-x (markdown)", line: 2, text: "Send as Partners in Biz." },
      { plugin: "x", file: "pib-x/references/a.md", line: 3, text: "the PiB team" },
    ]);
    expect(wordingHits("x", skills, ["pib-x-own", "pib-x"])).toEqual([]);
  });

  it("keeps skill keys, tool ids and namespaces out of the match", () => {
    const skills: Skill[] = [{ skillKey: "pib-company-os", markdown: "Call partnersinbiz.crm:get-contact via the pib-plugin-kit." }];
    expect(wordingHits("x", skills, [])).toEqual([]);
  });
});

