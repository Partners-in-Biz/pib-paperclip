import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUN_PROFILES } from "@partnersinbiz/pib-plugin-kit";
import { COMPANY_MEMORY_INSTRUCTION } from "@partnersinbiz/pib-plugin-kit";
import { renderGenerated } from "../scripts/embed-templates.mjs";
import { PACK_AGENT_FILES, PACK_MANIFEST_JSON, PACK_SHARED_BLOCKS } from "../src/pack/data.generated.js";
import {
  AGENT_ADAPTER_TYPES,
  AGENT_ICONS,
  AGENT_ROLES,
  COMPANY_OS_KEY,
  expandBlocks,
  hireOrder,
  loadPack,
  matchTemplate,
  parsePack,
  slugify,
  templateByKey,
  templateStaffing,
  templateVars,
  type AgentLike,
} from "../src/templates.js";
import { renderHash } from "../src/render-hash.js";
import { pickAdapter, renderHire, renderInstructions, templateConfig } from "../src/templates-render.js";
import { parseSubagents, subagentExtraArgs, subagentsText } from "../src/subagents.js";

const KEYS = ["ceo", "delivery-lead", "planner", "plan-critic", "senior-developer", "developer", "code-reviewer", "mac-builder", "growth-marketing-lead", "revenue-lead", "summarizer", "wiki-maintainer"];
const DEV_CHAIN = ["delivery-lead", "planner", "plan-critic", "senior-developer", "developer", "code-reviewer", "mac-builder"];
/** The ones that write, review, merge or plan code: the Plan Critic only reads a plan and the Mac Builder has its own rules. */
const CODE_AGENTS = ["delivery-lead", "planner", "senior-developer", "developer", "code-reviewer"];

const vars = templateVars({ company: "Acme Ltd", prefix: "ACM", owner: "Jo Owner", ceo: { name: "Boss", urlKey: "boss" } });
const agent = (id: string, name: string, extra: Partial<AgentLike> = {}): AgentLike => ({ id, name, title: null, role: "general", status: "idle", ...extra });

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_ISSUE = "11111111-1111-4111-8111-111111111111";

/**
 * What the host's `createAgentHireSchema` (shared/validators/agent.js, host 2026.916.1) checks on a hire request,
 * written out field by field. Placeholders the CEO replaces (`<agent id of X>`, `<the id of this task>`, the AGENTS.md
 * marker) are swapped for valid values first, exactly as the hire task tells the CEO to do.
 */
function hostHireProblems(payload: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const reportsTo = typeof payload.reportsTo === "string" && payload.reportsTo.startsWith("<") ? "22222222-2222-4222-8222-222222222222" : payload.reportsTo;
  const sourceIssueId = typeof payload.sourceIssueId === "string" && payload.sourceIssueId.startsWith("<") ? SOURCE_ISSUE : payload.sourceIssueId;
  if (typeof payload.name !== "string" || payload.name.length < 1) problems.push("name is empty");
  if (!AGENT_ROLES.includes(String(payload.role))) problems.push(`role ${JSON.stringify(payload.role)} is not one of ${AGENT_ROLES.join(", ")}`);
  if (payload.icon != null && !AGENT_ICONS.includes(String(payload.icon))) problems.push(`icon ${JSON.stringify(payload.icon)} is not an icon name`);
  if (reportsTo != null && !GUID.test(String(reportsTo))) problems.push("reportsTo is not a uuid");
  if (sourceIssueId != null && !GUID.test(String(sourceIssueId))) problems.push("sourceIssueId is not a uuid");
  if (payload.desiredSkills !== undefined && (!Array.isArray(payload.desiredSkills) || payload.desiredSkills.some((skill) => typeof skill !== "string" || skill.length < 1))) problems.push("desiredSkills must be non-empty strings");
  if (typeof payload.adapterType !== "string" || !payload.adapterType.trim()) problems.push("adapterType is empty");
  else if (!AGENT_ADAPTER_TYPES.includes(payload.adapterType)) problems.push(`adapterType ${payload.adapterType} is not a built-in adapter`);
  if (!payload.adapterConfig || typeof payload.adapterConfig !== "object" || Array.isArray(payload.adapterConfig)) problems.push("adapterConfig is not an object");
  else if ("env" in (payload.adapterConfig as object)) problems.push("adapterConfig.env must be valid env bindings (a hire request carries none)");
  const files = (payload.instructionsBundle as { files?: Record<string, unknown> } | undefined)?.files;
  if (!files || Object.keys(files).length === 0 || Object.values(files).some((text) => typeof text !== "string")) problems.push("instructionsBundle.files must hold at least one text file");
  const runtime = payload.runtimeConfig;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) problems.push("runtimeConfig is not an object");
  else if ("modelProfiles" in (runtime as object)) problems.push("runtimeConfig.modelProfiles is no longer supported");
  return problems;
}

function jsonBlock(description: string): Record<string, unknown> {
  const match = /```json\n([\s\S]*?)\n```/.exec(description);
  expect(match, "the hire task has a json block").toBeTruthy();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

describe("the embedded pack", () => {
  it("is in sync with templates/ (run `node scripts/embed-templates.mjs` after editing a template)", () => {
    const committed = readFileSync(new URL("../src/pack/data.generated.ts", import.meta.url), "utf8");
    expect(committed).toBe(renderGenerated(fileURLToPath(new URL("..", import.meta.url))));
  });

  it("is sound, and holds the dev chain and the other non-kit agents", () => {
    const { pack, problems } = parsePack(PACK_MANIFEST_JSON, PACK_AGENT_FILES, PACK_SHARED_BLOCKS);
    expect(problems).toEqual([]);
    expect(pack!.templates.map((template) => template.key)).toEqual(KEYS);
    expect([1, 2]).toContain(pack!.version);
  });

  it("has one head (the CEO) and every other agent reports up to it without a loop", () => {
    const pack = loadPack();
    const heads = pack.templates.filter((template) => template.reportsTo === null);
    expect(heads.map((template) => template.key)).toEqual(["ceo"]);
    for (const key of DEV_CHAIN.filter((entry) => entry !== "delivery-lead")) expect(templateByKey(key)!.reportsTo).toBe("delivery-lead");
    expect(templateByKey("delivery-lead")!.reportsTo).toBe("ceo");
    expect(hireOrder(pack.templates)[0]!.key).toBe("ceo");
  });

  it("gives every agent a real run profile: a pinned model, a timeout (never 0), a turn cap (never 1000), a concurrency", () => {
    for (const template of loadPack().templates) {
      const profile = template.runProfile;
      expect(profile.model, template.key).toMatch(/^claude-/);
      expect(profile.timeoutSec, template.key).toBeGreaterThan(0);
      expect(profile.timeoutSec, template.key).toBeLessThanOrEqual(7200);
      expect(profile.maxTurnsPerRun, template.key).toBeLessThan(1000);
      expect(profile.maxConcurrentRuns, template.key).toBeGreaterThanOrEqual(1);
      expect(AGENT_ICONS, template.key).toContain(template.icon);
      const config = templateConfig(template);
      expect(config.adapterConfig.timeoutSec, template.key).toBe(profile.timeoutSec);
      expect(config.runtimeConfig).toEqual({ heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: profile.maxConcurrentRuns } });
    }
  });

  it("takes a kit role's run profile from the kit, so the two cannot drift", () => {
    const gml = templateByKey("growth-marketing-lead")!;
    expect(gml.kitRole).toBe("social");
    expect(gml.runProfile).toEqual(RUN_PROFILES.social);
  });

  it("matches the live runtime profile of the roles that exist today (2026-10-03)", () => {
    const live: Record<string, { model: string; timeoutSec: number; maxConcurrentRuns: number }> = {
      "delivery-lead": { model: "claude-sonnet-5-5", timeoutSec: 3600, maxConcurrentRuns: 3 },
      planner: { model: "claude-fable-5-1", timeoutSec: 3600, maxConcurrentRuns: 3 },
      "senior-developer": { model: "claude-sonnet-5-5", timeoutSec: 3600, maxConcurrentRuns: 3 },
      developer: { model: "claude-sonnet-5-5", timeoutSec: 3600, maxConcurrentRuns: 4 },
      "code-reviewer": { model: "claude-sonnet-5-5", timeoutSec: 3600, maxConcurrentRuns: 4 },
      "mac-builder": { model: "claude-sonnet-5-5", timeoutSec: 5400, maxConcurrentRuns: 1 },
      summarizer: { model: "claude-haiku-4-5", timeoutSec: 1800, maxConcurrentRuns: 2 },
    };
    for (const [key, expected] of Object.entries(live)) expect(templateByKey(key)!.runProfile, key).toMatchObject(expected);
  });

  it("puts Plan Critic and the Wiki Maintainer on Hermes, and everything else on claude_local", () => {
    expect(pickAdapter(templateByKey("plan-critic")!)).toBe("hermes_local");
    expect(pickAdapter(templateByKey("wiki-maintainer")!)).toBe("hermes_local");
    for (const key of ["ceo", "developer", "planner", "summarizer"]) expect(pickAdapter(templateByKey(key)!), key).toBe("claude_local");
    // A role with no Hermes profile never lands on Hermes even if it lists it first.
    expect(pickAdapter({ adapterPreference: ["hermes_local", "claude_local"], runProfile: RUN_PROFILES.operator })).toBe("claude_local");
  });
});

describe("what the dev chain is told", () => {
  const text = (key: string) => renderInstructions(templateByKey(key)!, vars);

  it("states the rules of the house in every dev-chain agent: development branch, no worktrees of your own, detached slow work, evidence, review hand-offs", () => {
    const pack = loadPack();
    for (const key of CODE_AGENTS) {
      const template = pack.templates.find((t) => t.key === key);
      // Skeleton templates are distilled and omit some detail rules
      if (template?.skeleton) continue;
      const body = text(key);
      expect(body, key).toMatch(/`development` is where work happens/);
      expect(body, key).toMatch(/`main` is production and changes only when Jo Owner approves a release/);
      expect(body, key).toMatch(/Do not create worktrees, extra clones or workspace modes of your own, and never pick "New isolated workspace"/);
      expect(body, key).toMatch(/shared_workspace/);
      expect(body, key).toMatch(/git pull --rebase origin development && git push origin development/);
      expect(body, key).toMatch(/setsid nohup/);
      expect(body, key).toMatch(/"Should work" is not evidence/);
      expect(body, key).toMatch(/Never review or merge your own work/);
    }
    // The Mac Builder states its own versions of the same rules.
    const mac = text("mac-builder");
    expect(mac).toMatch(/Build from the project's `development` branch/);
    expect(mac).toMatch(/Do not create worktrees or extra clones of your own/);
    expect(mac).toMatch(/setsid nohup/);
    expect(mac).toMatch(/Evidence in your final comment: commit hash, build number/);
  });

  it("drops the old-system text the live files carried", () => {
    const pack = loadPack();
    for (const key of KEYS) {
      const body = text(key);
      const template = pack.templates.find((t) => t.key === key);
      // PiB-scoped templates may intentionally include PiB-specific references
      if (template?.scope !== "pib") {
        expect(body, key).not.toMatch(/Peet|Partners in Biz|\/PAR\//);
      }
      expect(body, key).not.toMatch(/One task = one isolated git worktree/i);
      expect(body, key).not.toMatch(/no deploy skill exists yet/i);
      expect(body, key).not.toMatch(/para-memory-files/);
      expect(body, key).not.toMatch(/\{\{/);
    }
  });

  it("names the company, links the agents by its prefix and uses the owner's name", () => {
    const lead = text("delivery-lead");
    expect(lead).toContain("[Planner](/ACM/agents/planner)");
    expect(lead).toContain("[Boss](/ACM/agents/boss)");
    expect(lead).toContain("Jo Owner");
    expect(text("ceo")).toContain("You are Boss, the CEO of Acme Ltd");
    // With nothing known the text stays honest instead of leaving a gap.
    const blank = renderInstructions(templateByKey("delivery-lead")!, templateVars());
    expect(blank).toContain("the CEO");
    expect(blank).toContain("the company owner");
    expect(blank).not.toMatch(/\{\{|undefined|null/);
  });

  it("never prints a broken link or 'the CEO, the CEO' when the company could not be read (no prefix, no CEO name)", () => {
    const blank = templateVars();
    for (const key of KEYS) {
      const body = renderInstructions(templateByKey(key)!, blank);
      expect(body, key).not.toMatch(/\]\(\/\/|\(\/agents|the CEO, the CEO/);
      expect(body, key).not.toMatch(/\{\{/);
    }
    const lead = renderInstructions(templateByKey("delivery-lead")!, blank);
    expect(lead).toMatch(/You report to the CEO\. The Planner, Plan Critic/);
    expect(lead).not.toContain("](/");
    expect(renderInstructions(templateByKey("ceo")!, blank)).toMatch(/^You are the CEO of the company\./);
    // The task says why, so the CEO knows to render it again.
    expect(renderHire(templateByKey("planner")!, { vars: blank }).warnings.join(" ")).toMatch(/issue prefix is not known/);
    expect(renderHire(templateByKey("planner")!, { vars }).warnings.join(" ")).not.toMatch(/issue prefix/);
    // With a prefix the links stay links.
    expect(renderInstructions(templateByKey("delivery-lead")!, vars)).toContain("[Planner](/ACM/agents/planner)");
  });

  it("makes the Planner assign subtasks directly (delegation_cycle) and the Developer escalate after 2 attempts", () => {
    expect(text("planner")).toMatch(/Assign them directly to the \[Developer\].*\[Senior Developer\]/s);
    expect(text("developer")).toMatch(/after 2 attempts, or a review comes back with changes requested once, escalate to the \[Senior Developer\]/);
    expect(text("plan-critic")).toMatch(/exactly three sections/);
  });

  it("carries the hire-task procedure in the CEO", () => {
    const ceo = text("ceo");
    for (const phrase of [
      "Hire tasks from Setup",
      "List the company's agents first",
      "POST /api/companies/{companyId}/agent-hires",
      "`skills:sync` with mode `add`; never `replace`",
      "do not resubmit after success",
      "Never create an agent whose adapter has no pinned model or no run timeout",
      "do not duplicate it",
    ]) expect(ceo, phrase).toContain(phrase);
  });

  it("adds the memory and manual lines once for hired agents, and not for built-in or plugin-made ones", () => {
    const planner = text("planner");
    expect(planner.split(COMPANY_MEMORY_INSTRUCTION).length - 1).toBe(1);
    expect(planner).toMatch(/Company operating manual: read the `pib-company-os` skill/);
    expect(text("summarizer")).not.toContain(COMPANY_MEMORY_INSTRUCTION);
    expect(text("wiki-maintainer")).not.toContain(COMPANY_MEMORY_INSTRUCTION);
  });

  it("keeps each file a sane size", () => {
    for (const key of KEYS) expect(text(key).length, key).toBeLessThan(14_000);
  });
});

describe("the hire task", () => {
  it("is titled `Hire: <name>` so the CEO's hire procedure applies, and lists the profile, the skills, the AGENTS.md and a payload", () => {
    const draft = renderHire(templateByKey("developer")!, { vars, agents: [agent("dl-1", "Delivery Lead", { title: "Delivery Lead" })] });
    expect(draft.title).toBe("Hire: Developer (team template)");
    expect(draft.description).toContain("| **Model** | `claude-sonnet-5-5` on `claude_local`");
    expect(draft.description).toContain("| **Run timeout** | 3600 s (never 0: 0 means unlimited) |");
    expect(draft.description).toContain("| **Concurrent runs** | 4 |");
    expect(draft.description).toContain("- `plugin/partnersinbiz-cockpit/company-os`");
    expect(draft.description).toContain("````markdown\nYou are the Developer of Acme Ltd's development team.");
    const payload = jsonBlock(draft.description);
    expect(payload).toMatchObject({
      name: "Developer",
      role: "engineer",
      title: "Software Engineer",
      icon: "hammer",
      reportsTo: "dl-1",
      adapterType: "claude_local",
      desiredSkills: [COMPANY_OS_KEY],
      adapterConfig: { model: "claude-sonnet-5-5", timeoutSec: 3600, maxTurnsPerRun: 250 },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 4 } },
    });
    expect(draft.payload).toEqual(payload);
  });

  it("names its manager by agent id when the manager exists, and says to hire the manager first when it does not", () => {
    const planner = templateByKey("planner")!;
    expect(renderHire(planner, { vars, agents: [] }).description).toContain("look its agent id up by name; it may not exist yet: hire it first");
    expect(renderHire(planner, { vars, agents: [] }).payload.reportsTo).toBe("<agent id of Delivery Lead>");
    expect(renderHire(templateByKey("ceo")!, { vars }).payload.reportsTo).toBeNull();
    expect(renderHire(templateByKey("ceo")!, { vars }).description).toContain("nobody: this is the head of the org chart");
  });

  it("puts Plan Critic on Hermes with the Hermes model, and warns about what a template needs", () => {
    const critic = renderHire(templateByKey("plan-critic")!, { vars });
    expect(critic.adapterType).toBe("hermes_local");
    expect(critic.payload.adapterConfig).toMatchObject({ model: "deepseek/deepseek-v4-flash-0731", provider: "nous" });
    const mac = renderHire(templateByKey("mac-builder")!, { vars });
    expect(mac.warnings.join(" ")).toMatch(/Mac build host/);
    expect(mac.description).toContain("## Check first");
    const wiki = renderHire(templateByKey("wiki-maintainer")!, { vars });
    expect(wiki.warnings.join(" ")).toMatch(/wiki folder is not known yet/);
    expect(wiki.description).toMatch(/LLM Wiki plugin normally creates this agent/);
    expect(renderHire(templateByKey("summarizer")!, { vars }).description).toMatch(/Paperclip itself provides this agent/);
  });

  it("is a request the host's agent-hires accepts, for every template (role, icon, adapter, skills, bundle, runtime)", () => {
    for (const template of loadPack().templates) {
      const draft = renderHire(template, { vars, agents: [] });
      expect(hostHireProblems(draft.payload), template.key).toEqual([]);
      // The role printed in the task is the role of the request.
      expect(draft.description, template.key).toContain(`| **Role** | \`${draft.payload.role}\` |`);
    }
  });

  it("hires the Wiki Maintainer with a role the host accepts, and still recognises the agent the LLM Wiki plugin makes by its own role", () => {
    const wiki = templateByKey("wiki-maintainer")!;
    expect(wiki.role).toBe("general");
    expect(AGENT_ROLES).not.toContain("knowledge-maintainer");
    expect(wiki.match.roles).toEqual(["knowledge-maintainer"]);
    expect(renderHire(wiki, { vars }).payload.role).toBe("general");
    expect(wiki.notes.join(" ")).toMatch(/knowledge-maintainer/);
  });

  it("the host check can fail: a role, icon, adapter or reporting id the host would refuse is caught", () => {
    const good = renderHire(templateByKey("developer")!, { vars, agents: [] }).payload;
    expect(hostHireProblems(good)).toEqual([]);
    expect(hostHireProblems({ ...good, role: "knowledge-maintainer" }).join(" ")).toMatch(/role "knowledge-maintainer"/);
    expect(hostHireProblems({ ...good, icon: "book-open" }).join(" ")).toMatch(/icon/);
    expect(hostHireProblems({ ...good, adapterType: "claude_remote" }).join(" ")).toMatch(/adapterType/);
    expect(hostHireProblems({ ...good, reportsTo: "not-a-uuid" }).join(" ")).toMatch(/reportsTo/);
    expect(hostHireProblems({ ...good, instructionsBundle: { files: {} } }).join(" ")).toMatch(/instructionsBundle/);
  });

  it("is deterministic", () => {
    const template = templateByKey("planner")!;
    expect(renderHire(template, { vars }).description).toBe(renderHire(template, { vars }).description);
  });
});

describe("recognising agents that already exist", () => {
  it("matches the CEO by title (the live PiB agent is named PiB), never a Developer for a Senior Developer", () => {
    const live = [agent("1", "PiB", { title: "CEO" }), agent("2", "Developer", { title: "Software Engineer", role: "engineer" }), agent("3", "Senior Developer", { title: "Senior Software Engineer" })];
    expect(matchTemplate(templateByKey("ceo")!, live)?.id).toBe("1");
    expect(matchTemplate(templateByKey("developer")!, live)?.id).toBe("2");
    expect(matchTemplate(templateByKey("senior-developer")!, live)?.id).toBe("3");
    expect(matchTemplate(templateByKey("developer")!, [live[2]!])).toBeNull();
  });

  it("ignores terminated agents and matches the Wiki Maintainer by its role", () => {
    expect(matchTemplate(templateByKey("planner")!, [agent("1", "Planner", { status: "terminated" })])).toBeNull();
    expect(matchTemplate(templateByKey("wiki-maintainer")!, [agent("9", "Archivist", { role: "knowledge-maintainer" })])?.id).toBe("9");
  });

  it("says staffed, hiring or missing", () => {
    const planner = templateByKey("planner")!;
    expect(templateStaffing(planner, { agents: [agent("1", "Planner")], hires: [] }).state).toBe("staffed");
    expect(templateStaffing(planner, { agents: [], hires: [{ templateKey: "planner", issueId: "i1", status: "open" }] }).state).toBe("hiring");
    expect(templateStaffing(planner, { agents: [], hires: [{ templateKey: "planner", issueId: "i1", status: "cancelled" }] }).state).toBe("missing");
    expect(templateStaffing(planner, { agents: null, hires: [] }).state).toBe("missing");
  });

  it("slugs a name the way the host does", () => {
    expect(slugify("Code Reviewer")).toBe("code-reviewer");
    expect(slugify("Outbound & Social Specialist")).toBe("outbound-social-specialist");
  });
});

describe("the pack validator can fail", () => {
  const base = () => JSON.parse(JSON.stringify(PACK_MANIFEST_JSON)) as { templates: Array<Record<string, any>>; [key: string]: unknown };
  const check = (mutate: (manifest: ReturnType<typeof base>) => void, files: Record<string, string> = PACK_AGENT_FILES) => {
    const manifest = base();
    mutate(manifest);
    return parsePack(manifest, files, PACK_SHARED_BLOCKS).problems.join(" | ");
  };
  const find = (manifest: ReturnType<typeof base>, key: string) => manifest.templates.find((template) => template.key === key)!;

  it("refuses a role the host's agent-hires would reject (the wiki plugin's own knowledge-maintainer) and an adapter type the host does not know", () => {
    expect(check((m) => { find(m, "wiki-maintainer").role = "knowledge-maintainer"; })).toMatch(/wiki-maintainer: role "knowledge-maintainer" is not a role the host's agent-hires accepts/);
    expect(check((m) => { find(m, "developer").adapterPreference = ["claude_remote"]; })).toMatch(/developer: adapterPreference needs at least one adapter type/);
  });
  it("refuses an icon the host would reject", () => expect(check((m) => { find(m, "developer").icon = "book-open"; })).toMatch(/developer: icon "book-open"/));
  it("refuses a run timeout of 0 and a turn cap of 1000", () => {
    expect(check((m) => { find(m, "developer").runProfile.timeoutSec = 0; })).toMatch(/developer: timeoutSec must be between 1 and 7200/);
    expect(check((m) => { find(m, "developer").runProfile.maxTurnsPerRun = 1000; })).toMatch(/developer: maxTurnsPerRun must be between 1 and 999/);
    expect(check((m) => { find(m, "developer").runProfile.model = ""; })).toMatch(/developer: the run profile has no model/);
  });
  it("refuses a reporting loop and a missing manager", () => {
    expect(check((m) => { find(m, "ceo").reportsTo = "developer"; })).toMatch(/loops/);
    expect(check((m) => { find(m, "developer").reportsTo = "nobody"; })).toMatch(/developer: reportsTo nobody is not a template/);
  });
  it("refuses a hired agent without the company operating manual", () => expect(check((m) => { find(m, "planner").desiredSkills = ["plugin/partnersinbiz-seo/seo-sprint"]; })).toMatch(/planner: every hired agent carries the company operating manual/));
  it("refuses a non-canonical skill key and a duplicated key", () => {
    expect(check((m) => { find(m, "planner").desiredSkills.push("pib-seo-sprint"); })).toMatch(/not a canonical skill key/);
    expect(check((m) => { find(m, "planner").desiredSkills.push(COMPANY_OS_KEY); })).toMatch(/a skill is listed twice/);
  });
  it("refuses an unknown variable, an unknown include and a missing file", () => {
    expect(check(() => undefined, { ...PACK_AGENT_FILES, developer: `${PACK_AGENT_FILES.developer}\n{{surprise}}` })).toMatch(/developer: uses \{\{surprise\}\}/);
    expect(check(() => undefined, { ...PACK_AGENT_FILES, developer: `${PACK_AGENT_FILES.developer}\n{{include:nope}}` })).toMatch(/includes nope/);
    const { developer: _gone, ...rest } = PACK_AGENT_FILES;
    expect(check(() => undefined, rest)).toMatch(/developer: templates\/agents\/developer.md is missing/);
  });
  it("refuses a duplicate key, a kit role that does not exist, and a pack with no CEO", () => {
    expect(check((m) => { m.templates.push({ ...find(m, "developer") }); })).toMatch(/duplicate key/);
    expect(check((m) => { find(m, "growth-marketing-lead").kitRole = "wizard"; })).toMatch(/kitRole wizard is not a kit team role/);
    expect(check((m) => { m.templates = m.templates.filter((template) => template.key !== "ceo"); })).toMatch(/no ceo template/);
  });
  it("refuses a manifest that is not an object", () => expect(parsePack("x", {}, {}).problems).toEqual(["the manifest is not an object"]));
});

describe("shared blocks v2 (PAR-4023)", () => {
  const isMarkdownHeading = (line: string) => /^\s{0,3}#{1,6}\s/.test(line);
  const isTextUnderMaxSize = (text: string, max: number) => text.length <= max;
  const includedBlockNames = (text: string) => Array.from(text.matchAll(/\{\{include:([a-z0-9-]+)\}\}/g), (m) => m[1]!);
  const tokenLeaks = (text: string) => Array.from(text.matchAll(/Peet|Elon|R500|PAR-/g));

  const genericIncludesPibBlock = (templates: Array<{ key: string; body: string }>, pibKeys: Set<string>) =>
    templates.filter((t) => !pibKeys.has(t.key) && includedBlockNames(t.body).some((b) => b.startsWith("pib-"))).map((t) => t.key);

  const PIB_BLOCKS = ["pib-autonomy", "pib-company-standards", "pib-mistakes", "pib-design-seo-gate"];
  const OTHER_NEW_BLOCKS = ["scheduled-runs", "anti-loop", "stuck-rule", "evidence", "testing"];
  const ALL_NEW_BLOCKS = [...PIB_BLOCKS, ...OTHER_NEW_BLOCKS];

  it("holds 9 new blocks, each under 2400 chars, with total under 12000, no markdown headings", () => {
    const blocks = ALL_NEW_BLOCKS.map((name) => ({ name, text: PACK_SHARED_BLOCKS[name] || "" }));
    let total = 0;
    for (const { name, text } of blocks) {
      expect(text.length, `${name} size`).toBeGreaterThan(0);
      expect(isTextUnderMaxSize(text, 2400), `${name} <= 2400`).toBe(true);
      const lines = text.split("\n");
      for (const line of lines) {
        if (!line.includes("<!--")) expect(isMarkdownHeading(line), `${name} no heading: ${line}`).toBe(false);
      }
      total += text.length;
    }
    expect(total <= 12000, "total blocks size").toBe(true);
  });

  it("every {{include:X}} in every template resolves to an existing block", () => {
    const allBlocks = { ...PACK_SHARED_BLOCKS };
    for (const [key, body] of Object.entries(PACK_AGENT_FILES)) {
      const names = includedBlockNames(body);
      for (const name of names) {
        expect(name in allBlocks, `${key} includes ${name}`).toBe(true);
      }
    }
  });

  it("every non-pib- new block has no token leaks", () => {
    for (const name of OTHER_NEW_BLOCKS) {
      const text = PACK_SHARED_BLOCKS[name];
      const leaks = tokenLeaks(text || "");
      expect(leaks.length, `${name} token leaks`).toBe(0);
    }
  });

  it("templates in PiB scope do not include non-pib- new blocks; genericIncludesPibBlock reports them if they do", () => {
    const manifest = PACK_MANIFEST_JSON as any;
    const PIB_SCOPE_KEYS = new Set<string>();
    for (const t of manifest.templates || []) {
      if (t.scope === "pib") PIB_SCOPE_KEYS.add(t.key);
    }
    const notInScope = (manifest.templates || []).map((t: any) => ({ key: t.key, body: PACK_AGENT_FILES[t.key] || "" }));
    const violations = genericIncludesPibBlock(notInScope, PIB_SCOPE_KEYS);
    expect(violations).toEqual([]);
  });

  it("proves the helpers work: fabricated cases fail as expected", () => {
    expect(isTextUnderMaxSize("x".repeat(2401), 2400)).toBe(false);
    expect(isMarkdownHeading("## Title")).toBe(true);
    expect(isMarkdownHeading("  ## Title")).toBe(true);
    expect(isMarkdownHeading("    ## Title")).toBe(false);
    const leaks = tokenLeaks("ask Peet about R500 on PAR-12");
    expect(leaks.length).toBe(3);
    const fakeTemplate = [{ key: "test", body: "{{include:pib-autonomy}}" }];
    expect(genericIncludesPibBlock(fakeTemplate, new Set())).toEqual(["test"]);
    expect(genericIncludesPibBlock(fakeTemplate, new Set(["test"]))).toEqual([]);
  });
});

describe("pack v2 parsing", () => {
  const base = () => JSON.parse(JSON.stringify(PACK_MANIFEST_JSON)) as { templates: Array<Record<string, any>>; [key: string]: unknown };
  const check = (mutate: (manifest: ReturnType<typeof base>) => void, files: Record<string, string> = PACK_AGENT_FILES) => {
    const manifest = base();
    mutate(manifest);
    return parsePack(manifest, files, PACK_SHARED_BLOCKS).problems.join(" | ");
  };
  const find = (manifest: ReturnType<typeof base>, key: string) => manifest.templates.find((template) => template.key === key)!;

  it("accepts v1 manifest and gives v2 defaults", () => {
    const manifest = base();
    manifest.version = 1;
    for (const t of manifest.templates || []) {
      // Remove any v2 fields to test that they default
      delete t.escalatesTo;
      delete t.subagents;
      delete t.evalFile;
      delete t.skeleton;
      delete t.scope;
      delete t.distilled;
      delete t.hostOwned;
    }
    const { pack, problems } = parsePack(manifest, PACK_AGENT_FILES, PACK_SHARED_BLOCKS);
    expect(problems).toEqual([]);
    expect(pack).toBeTruthy();
    // Check that defaults applied
    for (const t of pack!.templates) {
      // escalatesTo defaults to reportsTo when not specified
      if (t.reportsTo) expect(t.escalatesTo).toBe(t.reportsTo);
      else expect(t.escalatesTo).toBeUndefined();
      expect(t.subagents).toBeUndefined();
      expect(t.evalFile).toBeUndefined();
      expect(t.skeleton).toBeUndefined();
      expect(t.scope).toBeUndefined();
      expect(t.distilled).toBeUndefined();
      expect(t.hostOwned).toBeUndefined();
    }
  });

  it("accepts v2 manifest", () => {
    const { pack, problems } = parsePack(PACK_MANIFEST_JSON, PACK_AGENT_FILES, PACK_SHARED_BLOCKS);
    expect(problems).toEqual([]);
    expect(pack!.version).toBe(2);
  });

  it("refuses version 0 or 3", () => {
    expect(check((m) => { m.version = 0; })).toMatch(/version must be 1 or 2/);
    expect(check((m) => { m.version = 3; })).toMatch(/version must be 1 or 2/);
  });

  it("refuses distilled without evalFile (unless hostOwned)", () => {
    expect(check((m) => { find(m, "developer").distilled = true; })).toMatch(/developer: distilled templates must have evalFile/);
  });

  it("allows hostOwned distilled without evalFile", () => {
    expect(
      check((m) => {
        find(m, "developer").distilled = true;
        find(m, "developer").hostOwned = true;
      })
    ).not.toMatch(/developer.*distilled/);
  });

  it("defaults escalatesTo to reportsTo when not specified", () => {
    const manifest = base();
    const { pack } = parsePack(manifest, PACK_AGENT_FILES, PACK_SHARED_BLOCKS);
    // Developers report to Delivery Lead; they should default escalatesTo to it
    const dev = pack!.templates.find((t) => t.key === "developer");
    expect(dev!.reportsTo).toBe("delivery-lead");
    expect(dev!.escalatesTo).toBe("delivery-lead"); // Defaults to reportsTo when not specified
  });

  it("allows template with reportsTo of 'ceo' and omitted escalatesTo (resolves to 'ceo')", () => {
    const manifest = base();
    // Find the delivery-lead template which has reportsTo "ceo"
    const dlTemplate = find(manifest, "delivery-lead");
    // Ensure escalatesTo is not set so it defaults
    delete dlTemplate.escalatesTo;
    const { pack, problems } = parsePack(manifest, PACK_AGENT_FILES, PACK_SHARED_BLOCKS);
    // Verify no problems with escalatesTo
    expect(problems.some((p) => /escalatesTo/.test(p))).toBe(false);
    // The delivery-lead should have reportsTo "ceo" and escalatesTo should default to "ceo"
    const dl = pack!.templates.find((t) => t.key === "delivery-lead");
    expect(dl!.reportsTo).toBe("ceo");
    expect(dl!.escalatesTo).toBe("ceo");
  });

  it("parses the shipped templates pack without errors", () => {
    const { pack, problems } = parsePack(PACK_MANIFEST_JSON, PACK_AGENT_FILES, PACK_SHARED_BLOCKS);
    expect(problems).toEqual([]);
    expect(pack).toBeTruthy();
    // Check that escalatesTo is resolved for all templates
    for (const t of pack!.templates) {
      if (t.reportsTo) expect(t.escalatesTo).toBe(t.reportsTo);
    }
  });

  it("validates escalatesTo references an existing template", () => {
    expect(check((m) => { find(m, "developer").escalatesTo = "nobody"; })).toMatch(/developer: escalatesTo nobody is not a template/);
  });

  it("refuses escalatesTo cycles", () => {
    expect(
      check((m) => {
        find(m, "developer").escalatesTo = "planner";
        find(m, "planner").escalatesTo = "developer";
      })
    ).toMatch(/the escalatesTo chain loops through/);
  });

  it("validates evalFile format", () => {
    expect(check((m) => { find(m, "developer").evalFile = ""; })).toMatch(/evalFile must be non-empty/);
    expect(check((m) => { find(m, "developer").evalFile = "x".repeat(81); })).toMatch(/evalFile must be.*<=80 chars/);
    expect(check((m) => { find(m, "developer").evalFile = "MyEval.json"; })).toMatch(/evalFile must match/);
    expect(check((m) => { find(m, "developer").evalFile = "eval file.json"; })).toMatch(/evalFile must match/);
  });

  it("accepts valid evalFile", () => {
    const errors = check((m) => {
      find(m, "developer").evalFile = "my-eval_v2.json";
    });
    expect(errors).not.toMatch(/developer.*evalFile/);
  });

  it("validates scope is pib or generic", () => {
    expect(check((m) => { find(m, "developer").scope = "unknown"; })).toMatch(/scope must be one of/);
  });

  it("allows skeleton and hostOwned flags", () => {
    const errors = check((m) => {
      find(m, "developer").skeleton = true;
      find(m, "developer").hostOwned = true;
    });
    expect(errors).not.toMatch(/developer.*skeleton|hostOwned/);
  });
});

describe("render-hash and subagent integration", () => {
  it("renderHash is deterministic for the same template render", () => {
    const template = templateByKey("developer")!;
    const vars = templateVars({ company: "Acme", prefix: "ACM" });
    const render1 = renderInstructions(template, vars);
    const render2 = renderInstructions(template, vars);
    expect(renderHash(render1)).toBe(renderHash(render2));
  });

  it("renderHash differs after a single character change", () => {
    const template = templateByKey("developer")!;
    const vars = templateVars({ company: "Acme", prefix: "ACM" });
    const render = renderInstructions(template, vars);
    const modified = render.replace(/the company/, "THE COMPANY");
    expect(renderHash(render)).not.toBe(renderHash(modified));
  });

  it("computes the expected hash for 'fixture'", () => {
    const expected = "f16d05ec6b29248d";
    expect(renderHash("fixture")).toBe(expected);
  });

  it("subagentExtraArgs for various policy groups", () => {
    // Undefined policy
    expect(subagentExtraArgs(undefined)).toEqual([]);

    // Empty allowed
    expect(subagentExtraArgs({ allowed: [], model: "", maxParallel: 0 })).toEqual(["--disallowedTools", "Task,Agent"]);

    // Planner (explorer subagent)
    const planner = subagentExtraArgs({ allowed: ["explorer"], model: "haiku", maxParallel: 3 });
    expect(planner[0]).toBe("--allowedTools");
    expect(planner[1]).toBe("Task(explorer),Agent(explorer)");

    // Reflection Coach (explorer)
    const coach = subagentExtraArgs({ allowed: ["explorer"], model: "haiku", maxParallel: 2 });
    expect(coach[0]).toBe("--allowedTools");
    expect(coach[1]).toBe("Task(explorer),Agent(explorer)");

    // Developer group (explorer + test-runner)
    const devGroup = subagentExtraArgs({ allowed: ["explorer", "test-runner"], model: "claude-sonnet-5-5", maxParallel: 2 });
    expect(devGroup[0]).toBe("--allowedTools");
    expect(devGroup[1]).toBe("Task(explorer),Task(test-runner),Agent(explorer),Agent(test-runner)");

    // Reviewer group (explorer)
    const reviewer = subagentExtraArgs({ allowed: ["explorer"], model: "claude-sonnet-5-5", maxParallel: 2 });
    expect(reviewer[0]).toBe("--allowedTools");
    expect(reviewer[1]).toBe("Task(explorer),Agent(explorer)");
  });

  it("subagentsText for empty and non-empty policies", () => {
    expect(subagentsText(undefined)).toBe("You do not spawn subagents. Do the work yourself.");
    expect(subagentsText({ allowed: [], model: "", maxParallel: 0 })).toBe("You do not spawn subagents. Do the work yourself.");

    const text = subagentsText({ allowed: ["explorer"], model: "haiku", maxParallel: 1 });
    expect(text).toContain("You may spawn these subagents");
    expect(text).toContain("model haiku");
    expect(text).toContain("explorer");
    expect(text).toContain("Run at most 1 at once");
  });
});

describe("block expansion", () => {
  it("replaces include markers with the shared block", () => {
    expect(expandBlocks("A\n{{include:x}}\nB", { x: "BLOCK\n" })).toBe("A\nBLOCK\nB\n");
  });
});
