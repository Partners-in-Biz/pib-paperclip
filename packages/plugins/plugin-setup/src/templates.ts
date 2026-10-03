/**
 * The team template pack (Q7-5, Q1b-3, Q9-5, Q9-14): versioned definitions of the
 * agents a PiB company has that are not kit team roles (the CEO, the dev team,
 * the Growth Marketing Lead, the Summarizer, the Wiki Maintainer).
 *
 * Source of truth: `templates/` (manifest.json, agents/*.md, memory/). A script
 * embeds it into `pack/data.generated.ts`; a test fails when that file is stale.
 * Pure and browser-safe (no node imports, no kit root import): the worker renders
 * hire tasks from it (`templates-render.ts`), the page lists it.
 *
 * The kit's TEAM_ROLES are not touched: the dev team is not a kit role set
 * (owner decision, memory "staffing-in-setup-team"). A template can name a kit
 * role (`kitRole`, the Growth Marketing Lead holds the Social role): then it is
 * hired through that plugin's own hire so the plugin links and wires it.
 */
import { RUN_PROFILES, type RunProfile } from "@partnersinbiz/pib-plugin-kit/run-profile";
import { TEAM_ROLES, teamSkillKey, type TeamRoleKey } from "@partnersinbiz/pib-plugin-kit/team";
import { PACK_AGENT_FILES, PACK_MANIFEST_JSON, PACK_SHARED_BLOCKS } from "./pack/data.generated.js";

/** The icon names the host accepts for an agent (`AGENT_ICON_NAMES` in the host's shared constants; update on an upstream merge). */
export const AGENT_ICONS: readonly string[] = [
  "bot", "cpu", "brain", "zap", "rocket", "code", "terminal", "shield", "eye", "search", "wrench", "hammer", "lightbulb", "sparkles", "star", "heart", "flame", "bug", "cog", "database",
  "globe", "lock", "mail", "message-square", "file-code", "git-branch", "package", "puzzle", "target", "wand", "atom", "circuit-board", "radar", "swords", "telescope", "microscope",
  "crown", "gem", "hexagon", "pentagon", "fingerprint",
];

/** The agent roles the host's `agent-hires` accepts (`AGENT_ROLES` in the host's shared constants; update on an upstream merge). A plugin-made agent can carry another role (the LLM Wiki Maintainer is `knowledge-maintainer`), which a hire request cannot. */
export const AGENT_ROLES: readonly string[] = ["ceo", "cto", "cmo", "cfo", "security", "engineer", "designer", "pm", "qa", "devops", "researcher", "general"];

/** The adapter types the host accepts (`AGENT_ADAPTER_TYPES`; update on an upstream merge). */
export const AGENT_ADAPTER_TYPES: readonly string[] = [
  "process", "http", "claude_local", "codex_local", "paperclip_runner", "cursor_cloud", "gemini_local", "grok_local", "hermes_gateway", "hermes_local", "kimi_local", "opencode_local", "pi_local", "cursor", "openclaw_gateway",
];

/** The company operating manual every hired agent carries (Cockpit managed skill). */
export const COMPANY_OS_KEY = teamSkillKey("partnersinbiz.cockpit", "company-os");

export type TemplateGroup = "core" | "dev-team" | "marketing" | "support";
export type Provisioning = "hire" | "host" | "plugin";

export interface AgentTemplate {
  key: string;
  name: string;
  title: string;
  /** The role a hire request carries: one of `AGENT_ROLES` (the host rejects any other). How an agent made some other way is recognised is `match.roles`. */
  role: string;
  icon: string;
  group: TemplateGroup;
  capabilities: string;
  /** Another template's key, or null for the head of the org chart. */
  reportsTo: string | null;
  adapterPreference: string[];
  runProfile: RunProfile;
  desiredSkills: string[];
  /** Name of the file in `templates/agents/` (without .md). */
  file: string;
  /** How an existing agent is recognised as this template. */
  match: { names: string[]; titles: string[]; roles: string[] };
  /** hire: a hire task; host / plugin: the host or a plugin creates it and the pack only carries its run profile. */
  provisioning: Provisioning;
  /** Selected by default in Setup -> New company. */
  defaultOn: boolean;
  requires: { modules: string[]; environment?: string };
  notes: string[];
  kitRole?: TeamRoleKey;
}

export interface TemplatePack {
  pack: string;
  version: number;
  updated: string;
  description: string;
  variables: Record<string, string>;
  sharedBlocks: string[];
  templates: AgentTemplate[];
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strs = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

const KEY_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SKILL_RE = /^(plugin\/[a-z0-9-]+\/[a-z0-9-]+|paperclipai\/[a-z0-9-]+(\/[a-z0-9-]+)+)$/;
const GROUPS: readonly string[] = ["core", "dev-team", "marketing", "support"];
const PROVISIONING: readonly string[] = ["hire", "host", "plugin"];
const EFFORTS: readonly string[] = ["low", "medium", "high"];
/** One rendered AGENTS.md stays under this (the host prints it into a hire task and a payload). */
export const MAX_INSTRUCTION_CHARS = 14_000;

function profileProblems(key: string, profile: RunProfile): string[] {
  const problems: string[] = [];
  if (!profile.model.trim()) problems.push(`${key}: the run profile has no model`);
  if (!EFFORTS.includes(profile.effort)) problems.push(`${key}: effort must be low, medium or high`);
  if (!Number.isInteger(profile.timeoutSec) || profile.timeoutSec <= 0 || profile.timeoutSec > 7200) problems.push(`${key}: timeoutSec must be between 1 and 7200 (never 0: the host reads 0 as unlimited)`);
  if (!Number.isInteger(profile.maxTurnsPerRun) || profile.maxTurnsPerRun < 1 || profile.maxTurnsPerRun >= 1000) problems.push(`${key}: maxTurnsPerRun must be between 1 and 999 (1000 is no cap)`);
  if (!Number.isInteger(profile.maxConcurrentRuns) || profile.maxConcurrentRuns < 1 || profile.maxConcurrentRuns > 10) problems.push(`${key}: maxConcurrentRuns must be between 1 and 10`);
  if (profile.hermes && (!profile.hermes.provider.trim() || !profile.hermes.model.trim())) problems.push(`${key}: the hermes profile needs a provider and a model`);
  return problems;
}

function resolveProfile(key: string, raw: unknown, problems: string[]): RunProfile | null {
  const spec = rec(raw);
  if (!spec) {
    problems.push(`${key}: runProfile is missing`);
    return null;
  }
  if (typeof spec.fromKitRole === "string") {
    const kit = (RUN_PROFILES as Record<string, RunProfile>)[spec.fromKitRole];
    if (!kit) {
      problems.push(`${key}: fromKitRole ${spec.fromKitRole} is not a kit team role`);
      return null;
    }
    return kit;
  }
  const hermes = rec(spec.hermes);
  const profile: RunProfile = {
    model: str(spec.model),
    ...(hermes ? { hermes: { provider: str(hermes.provider), model: str(hermes.model) } } : {}),
    effort: str(spec.effort) as RunProfile["effort"],
    timeoutSec: Number(spec.timeoutSec),
    maxTurnsPerRun: Number(spec.maxTurnsPerRun),
    maxConcurrentRuns: Number(spec.maxConcurrentRuns),
  };
  problems.push(...profileProblems(key, profile));
  return profile;
}

/** `{{include:name}}` and `{{variable}}` markers in a template file. */
const INCLUDE_RE = /\{\{include:([a-z0-9-]+)\}\}/g;
const VARIABLE_RE = /\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g;

/** Parses and checks the pack. `problems` is empty when the pack is sound. */
export function parsePack(raw: unknown, files: Record<string, string>, blocks: Record<string, string>): { pack: TemplatePack | null; problems: string[] } {
  const problems: string[] = [];
  const root = rec(raw);
  if (!root) return { pack: null, problems: ["the manifest is not an object"] };
  const version = Number(root.version);
  if (!Number.isInteger(version) || version < 1) problems.push("version must be a whole number from 1");
  const variables = Object.fromEntries(Object.entries(rec(root.variables) ?? {}).map(([name, text]) => [name, str(text)]));
  const sharedBlocks = strs(root.sharedBlocks);
  for (const block of sharedBlocks) if (!(block in blocks)) problems.push(`shared block ${block} has no file (templates/agents/_${block}.md)`);
  const templates: AgentTemplate[] = [];
  const list = Array.isArray(root.templates) ? root.templates : [];
  if (list.length === 0) problems.push("the pack has no templates");
  const keys = new Set<string>();
  const names = new Set<string>();
  const validKitRoles = new Set<string>(TEAM_ROLES.map((role) => role.key));
  for (const entry of list) {
    const t = rec(entry);
    const key = str(t?.key);
    if (!t || !KEY_RE.test(key)) {
      problems.push(`a template has a bad key: ${JSON.stringify(t?.key)}`);
      continue;
    }
    if (keys.has(key)) problems.push(`${key}: duplicate key`);
    keys.add(key);
    const name = str(t.name);
    if (!name || names.has(name.toLowerCase())) problems.push(`${key}: name is empty or used twice`);
    names.add(name.toLowerCase());
    for (const field of ["title", "role", "icon", "capabilities", "file"]) if (!str(t[field]).trim()) problems.push(`${key}: ${field} is missing`);
    if (!AGENT_ICONS.includes(str(t.icon))) problems.push(`${key}: icon ${JSON.stringify(t.icon)} is not an icon the host accepts`);
    if (!AGENT_ROLES.includes(str(t.role))) problems.push(`${key}: role ${JSON.stringify(t.role)} is not a role the host's agent-hires accepts (${AGENT_ROLES.join(", ")}); an agent made another way is recognised through match.roles`);
    if (!GROUPS.includes(str(t.group))) problems.push(`${key}: group must be one of ${GROUPS.join(", ")}`);
    if (!PROVISIONING.includes(str(t.provisioning))) problems.push(`${key}: provisioning must be one of ${PROVISIONING.join(", ")}`);
    const adapterPreference = strs(t.adapterPreference);
    if (adapterPreference.length === 0 || adapterPreference.some((adapter) => !AGENT_ADAPTER_TYPES.includes(adapter))) problems.push(`${key}: adapterPreference needs at least one adapter type, every one of them a type the host accepts`);
    const profile = resolveProfile(key, t.runProfile, problems);
    const desiredSkills = strs(t.desiredSkills);
    if (desiredSkills.length === 0) problems.push(`${key}: desiredSkills is empty`);
    for (const skill of desiredSkills) if (!SKILL_RE.test(skill)) problems.push(`${key}: skill key ${JSON.stringify(skill)} is not a canonical skill key`);
    if (new Set(desiredSkills).size !== desiredSkills.length) problems.push(`${key}: a skill is listed twice`);
    if (str(t.provisioning) === "hire" && !desiredSkills.includes(COMPANY_OS_KEY)) problems.push(`${key}: every hired agent carries the company operating manual (${COMPANY_OS_KEY})`);
    const kitRole = t.kitRole === undefined ? undefined : str(t.kitRole);
    if (kitRole !== undefined && !validKitRoles.has(kitRole)) problems.push(`${key}: kitRole ${kitRole} is not a kit team role`);
    const file = str(t.file);
    const text = files[file];
    if (text === undefined) problems.push(`${key}: templates/agents/${file}.md is missing`);
    else {
      for (const match of text.matchAll(INCLUDE_RE)) if (!sharedBlocks.includes(match[1]!)) problems.push(`${key}: includes ${match[1]}, which is not a shared block of the pack`);
      const expanded = expandBlocks(text, blocks);
      for (const match of expanded.matchAll(VARIABLE_RE)) if (!(match[1]! in variables)) problems.push(`${key}: uses {{${match[1]}}}, which the pack does not declare`);
    }
    const match = rec(t.match) ?? {};
    const requires = rec(t.requires) ?? {};
    if (profile) {
      templates.push({
        key,
        name,
        title: str(t.title),
        role: str(t.role),
        icon: str(t.icon),
        group: str(t.group) as TemplateGroup,
        capabilities: str(t.capabilities),
        reportsTo: t.reportsTo === null || t.reportsTo === undefined ? null : str(t.reportsTo),
        adapterPreference,
        runProfile: profile,
        desiredSkills,
        file,
        match: { names: strs(match.names), titles: strs(match.titles), roles: strs(match.roles) },
        provisioning: str(t.provisioning) as Provisioning,
        defaultOn: t.defaultOn === true,
        requires: { modules: strs(requires.modules), ...(str(requires.environment) ? { environment: str(requires.environment) } : {}) },
        notes: strs(t.notes),
        ...(kitRole ? { kitRole: kitRole as TeamRoleKey } : {}),
      });
    }
  }
  // The org chart: every reportsTo names a template of the pack, there is one head, and no loops.
  const byKey = new Map(templates.map((template) => [template.key, template]));
  for (const template of templates) {
    if (template.reportsTo !== null && !byKey.has(template.reportsTo) && template.reportsTo !== "ceo") problems.push(`${template.key}: reportsTo ${template.reportsTo} is not a template of the pack`);
    const seen = new Set<string>([template.key]);
    let next = template.reportsTo;
    while (next && byKey.has(next)) {
      if (seen.has(next)) {
        problems.push(`${template.key}: the reporting line loops through ${next}`);
        break;
      }
      seen.add(next);
      next = byKey.get(next)!.reportsTo;
    }
  }
  if (!byKey.has("ceo")) problems.push("the pack has no ceo template (everything else reports to it)");
  if (problems.length > 0) return { pack: null, problems };
  return {
    pack: {
      pack: str(root.pack),
      version,
      updated: str(root.updated),
      description: str(root.description),
      variables,
      sharedBlocks,
      templates,
    },
    problems,
  };
}

/** The file with its `{{include:block}}` markers replaced by the shared blocks. */
export function expandBlocks(text: string, blocks: Record<string, string>): string {
  return text.replace(INCLUDE_RE, (_all, name: string) => (blocks[name] ?? "").trimEnd()).trimEnd() + "\n";
}

let cached: TemplatePack | null = null;

/** The embedded pack. Throws when it is unsound (a test and the build catch that first). */
export function loadPack(): TemplatePack {
  if (cached) return cached;
  const { pack, problems } = parsePack(PACK_MANIFEST_JSON, PACK_AGENT_FILES, PACK_SHARED_BLOCKS);
  if (!pack) throw new Error(`The team template pack is not sound: ${problems.slice(0, 5).join("; ")}`);
  cached = pack;
  return pack;
}

export function templateByKey(key: string): AgentTemplate | null {
  return loadPack().templates.find((template) => template.key === key) ?? null;
}

/** Raw file text and shared blocks, for rendering. */
export function packSources(): { files: Record<string, string>; blocks: Record<string, string> } {
  return { files: PACK_AGENT_FILES, blocks: PACK_SHARED_BLOCKS };
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

export interface TemplateVars {
  company: string;
  prefix: string;
  owner: string;
  ceo: string;
  ceoLink: string;
  wikiRoot: string;
}

export const NO_WIKI_ROOT = "(not configured)";

/** What the rendered text says when the caller knows nothing: honest defaults, never an empty gap. */
export function templateVars(input: { company?: string | null; prefix?: string | null; owner?: string | null; ceo?: { name: string; urlKey?: string | null } | null; wikiRoot?: string | null } = {}): TemplateVars {
  const prefix = (input.prefix ?? "").trim();
  const ceoName = input.ceo?.name?.trim() || "";
  const ceoSlug = input.ceo ? (input.ceo.urlKey?.trim() || slugify(input.ceo.name)) : "";
  return {
    company: input.company?.trim() || "the company",
    prefix,
    owner: input.owner?.trim() || "the company owner",
    ceo: ceoName || "the CEO",
    ceoLink: ceoName && prefix && ceoSlug ? `[${ceoName}](/${prefix}/agents/${ceoSlug})` : "the CEO",
    wikiRoot: input.wikiRoot?.trim() || NO_WIKI_ROOT,
  };
}

/** The URL key the host gives an agent from its name (lower case, words joined with dashes). */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** An agent link in a template: `[Planner](/{{prefix}}/agents/planner)`. */
const PREFIX_LINK_RE = /\[([^\]]+)\]\(\/\{\{prefix\}\}\/[^)]*\)/g;

/**
 * Replaces `{{variable}}`; an unknown name is left visible so a review catches it.
 * When the company is not known (no prefix, no CEO) the text stays honest instead of broken: an agent link becomes
 * the plain name (never `//agents/x`), and "the CEO, the CEO" reads "the CEO".
 */
export function fillVariables(text: string, vars: TemplateVars): string {
  const linked = vars.prefix ? text : text.replace(PREFIX_LINK_RE, "$1");
  return linked
    .replace(VARIABLE_RE, (all, name: string) => (name in vars ? (vars as unknown as Record<string, string>)[name]! : all))
    .replace(/\bthe CEO, the CEO\b/g, "the CEO");
}

// ---------------------------------------------------------------------------
// Matching live agents
// ---------------------------------------------------------------------------

export interface AgentLike {
  id: string;
  name: string;
  title?: string | null;
  role?: string | null;
  status: string;
  reportsTo?: string | null;
  urlKey?: string | null;
}

const GONE = new Set(["terminated", "archived", "deleted"]);
const norm = (value: string | null | undefined) => (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The company's agent that already is this template (same name or title, or the template's role), or null. Terminated agents never count. */
export function matchTemplate(template: AgentTemplate, agents: readonly AgentLike[]): AgentLike | null {
  const live = agents.filter((agent) => !GONE.has(agent.status));
  const names = template.match.names.map(norm);
  const titles = template.match.titles.map(norm);
  const byName = live.find((agent) => names.includes(norm(agent.name)));
  if (byName) return byName;
  const byTitle = live.find((agent) => titles.includes(norm(agent.title)));
  if (byTitle) return byTitle;
  return template.match.roles.length ? live.find((agent) => template.match.roles.includes((agent.role ?? "").toLowerCase())) ?? null : null;
}

export type TemplateStaffing = "staffed" | "hiring" | "missing";

export interface TemplateHireLike {
  templateKey: string;
  issueId: string;
  status: string;
}

/** Where a template stands for the company: an agent matches it, an open hire task exists, or neither. */
export function templateStaffing(template: AgentTemplate, input: { agents: readonly AgentLike[] | null; hires: readonly TemplateHireLike[] }): { state: TemplateStaffing; agent: AgentLike | null; hire: TemplateHireLike | null } {
  const agent = input.agents ? matchTemplate(template, input.agents) : null;
  const hire = input.hires.find((entry) => entry.templateKey === template.key && entry.status === "open") ?? null;
  if (agent) return { state: "staffed", agent, hire };
  return { state: hire ? "hiring" : "missing", agent: null, hire };
}

/** Templates to open hire tasks for, in an order a manager is hired before the agents that report to it. */
export function hireOrder(templates: readonly AgentTemplate[]): AgentTemplate[] {
  const byKey = new Map(templates.map((template) => [template.key, template]));
  const depth = (template: AgentTemplate): number => {
    let count = 0;
    let next = template.reportsTo;
    while (next && byKey.has(next) && count < 20) {
      count += 1;
      next = byKey.get(next)!.reportsTo;
    }
    return count;
  };
  return [...templates].sort((a, b) => depth(a) - depth(b));
}

export function manager(template: AgentTemplate): AgentTemplate | null {
  return template.reportsTo ? templateByKey(template.reportsTo) : null;
}
