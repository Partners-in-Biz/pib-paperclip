/**
 * Setup -> New company, worker side (Q7-1, Q7-5, Q7-13, Q10-1).
 *
 * The worker keeps the state of each company's bootstrap and does what a worker
 * can do alone: the module switches, the Finish setup issue, the hire tasks of
 * the team template pack, the starter pack approval. The steps that need another
 * plugin or an instance admin (saving settings, each plugin's start-hire, skill
 * syncs, the memory import) run from the Setup page and report back here, one
 * step at a time (`recordStep`). Every function names its company; none acts for
 * a company it was not asked about.
 */
import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { configSaved, createWorkIssue, runProfileConfig, TEAM_ROLES, type RunProfile } from "@partnersinbiz/pib-plugin-kit";
import {
  BOOTSTRAP_STEPS,
  clip,
  currentGrants,
  isStepId,
  isStepStatus,
  planSteps,
  runStatus,
  sanitizeGrants,
  sanitizeItems,
  SKILL_SYNC_ACTIONS,
  type BootstrapOptions,
  type BootstrapRunState,
  type PlanFacts,
  type PlannedStep,
  type StepId,
  type StepRecord,
} from "./bootstrap.js";
import {
  getChoice,
  getFinishIssue,
  getRun,
  getStarterApproval,
  getStarterImport,
  listStatuses,
  listTemplateHires,
  saveRun,
  saveStarterApproval,
  saveStarterImport,
  saveTemplateHire,
  ensureRun,
  type TemplateHireRow,
} from "./db.js";
import { SetupError } from "./modules.js";
import { PLUGIN_ID } from "./namespace.js";
import { loadStarterPack, parseImportResult, starterPackExport, type StarterPack } from "./starter-pack.js";
import { loadPack, matchTemplate, templateByKey, templateVars, type AgentLike, type AgentTemplate } from "./templates.js";
import { pickAdapter, renderHire, templateConfig } from "./templates-render.js";
import { message, refreshFinishIssue, saveModules, storedSummary, type Clock } from "./service.js";

const systemClock: Clock = { now: () => new Date() };

/** The steps only the worker records (the page never reports these). */
const WORKER_STEPS: readonly StepId[] = ["modules", "finish-issue"];

// ---------------------------------------------------------------------------
// Company facts
// ---------------------------------------------------------------------------

interface CompanyInfo {
  id: string;
  name: string;
  prefix: string | null;
  requireApproval: boolean | null;
}

async function companyInfo(ctx: PluginContext, companyId: string): Promise<CompanyInfo> {
  try {
    const company = (await ctx.companies.get(companyId)) as { name?: string; issuePrefix?: string | null; requireBoardApprovalForNewAgents?: boolean } | null;
    return { id: companyId, name: company?.name ?? "the company", prefix: company?.issuePrefix ?? null, requireApproval: typeof company?.requireBoardApprovalForNewAgents === "boolean" ? company.requireBoardApprovalForNewAgents : null };
  } catch {
    return { id: companyId, name: "the company", prefix: null, requireApproval: null };
  }
}

async function planFacts(ctx: PluginContext, companyId: string): Promise<PlanFacts> {
  const [choice, saved, issue, summary] = await Promise.all([
    getChoice(ctx, companyId),
    configSaved(ctx, companyId).catch(() => false),
    getFinishIssue(ctx, companyId),
    storedSummary(ctx, companyId).catch(() => null),
  ]);
  return { modulesSaved: !!choice, setupSettingsSaved: saved, finishIssueId: issue?.issueId ?? null, requiredLeft: summary ? summary.requiredLeft : null };
}

function freshRun(companyId: string, source: string, userId: string | null, now: string): BootstrapRunState {
  return { companyId, status: "created", options: {}, steps: {}, grants: [], source, startedBy: userId, createdAt: now, updatedAt: now, completedAt: null };
}

/** The options a call may set: ids and switches only, never free text the worker would store or run. */
export function sanitizeOptions(raw: unknown): BootstrapOptions {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: BootstrapOptions = {};
  if (row.modules && typeof row.modules === "object" && !Array.isArray(row.modules)) out.modules = row.modules as BootstrapOptions["modules"];
  if (typeof row.copyFromCompanyId === "string" && /^[0-9a-f-]{8,64}$/i.test(row.copyFromCompanyId)) out.copyFromCompanyId = row.copyFromCompanyId;
  if (typeof row.includeOptionalRoles === "boolean") out.includeOptionalRoles = row.includeOptionalRoles;
  if (Array.isArray(row.templates)) out.templates = row.templates.filter((key): key is string => typeof key === "string" && !!templateByKey(key)).slice(0, 20);
  if (typeof row.hiringAgentId === "string" && /^[0-9a-f-]{8,64}$/i.test(row.hiringAgentId)) out.hiringAgentId = row.hiringAgentId;
  if (typeof row.starterPack === "boolean") out.starterPack = row.starterPack;
  return out;
}

// ---------------------------------------------------------------------------
// The starter pack
// ---------------------------------------------------------------------------

/** Hash of what would be seeded (the facts, not the reviewer's notes): the owner approves exactly this. */
export function starterPackHash(pack: StarterPack): string {
  const content = pack.facts.map((fact) => [fact.text, fact.kind, fact.area, fact.pinned]);
  return createHash("sha256").update(JSON.stringify({ version: pack.version, facts: content })).digest("hex");
}

export async function starterPackView(ctx: PluginContext, companyId?: string, options: { includeFacts?: boolean } = {}) {
  const pack = loadStarterPack();
  // The facts and the review notes are for a person to read before approving; an agent reading the state gets the counts only.
  const includeFacts = options.includeFacts !== false;
  const hash = starterPackHash(pack);
  const approval = await getStarterApproval(ctx, pack.version, hash).catch(() => null);
  const imported = companyId ? await getStarterImport(ctx, companyId, pack.version, hash).catch(() => null) : null;
  return {
    name: pack.name,
    version: pack.version,
    hash,
    status: pack.status,
    needsOwnerOk: true,
    builtFrom: pack.builtFrom,
    howToUse: pack.howToUse,
    reviewNotes: includeFacts ? pack.reviewNotes : [],
    facts: includeFacts ? pack.facts : [],
    excluded: includeFacts ? pack.excluded : [],
    factCount: pack.facts.length,
    excludedCount: pack.excluded.length,
    approved: !!approval,
    approvedBy: approval?.approvedBy ?? null,
    approvedAt: approval?.approvedAt ?? null,
    /** When this company got the pack (null: not yet). */
    importedAt: imported?.importedAt ?? null,
  };
}

/** The owner approves this exact version of the pack. A hash that is not the current content is refused: they must have seen what they approve. */
export async function approveStarterPack(ctx: PluginContext, input: { userId: string | null; hash: unknown }, clock: Clock = systemClock) {
  if (!input.userId) throw new SetupError("Only a board user can approve the starter pack");
  const pack = loadStarterPack();
  const hash = starterPackHash(pack);
  if (input.hash !== hash) throw new SetupError("The starter pack changed since you opened it. Reload the page, read it again, then approve.");
  await saveStarterApproval(ctx, { packVersion: pack.version, contentHash: hash, approvedBy: input.userId, approvedAt: clock.now().toISOString() });
  return starterPackView(ctx);
}

/** The body for the Cockpit's `memory.import`, only once the owner approved this version. */
export async function starterPackForImport(ctx: PluginContext, clock: Clock = systemClock) {
  const pack = loadStarterPack();
  const hash = starterPackHash(pack);
  if (!(await getStarterApproval(ctx, pack.version, hash))) throw new SetupError("The starter pack needs the owner's OK first: open Setup -> New company -> Memory starter pack and approve this version.");
  return { version: pack.version, hash, data: starterPackExport(pack, clock.now().toISOString()) };
}

// ---------------------------------------------------------------------------
// Reading the section
// ---------------------------------------------------------------------------

export async function loadNewCompany(ctx: PluginContext, companyId: string, options: { includeFacts?: boolean } = {}) {
  const [run, facts, hires, starterPack, statusRows] = await Promise.all([
    getRun(ctx, companyId),
    planFacts(ctx, companyId),
    listTemplateHires(ctx, companyId),
    starterPackView(ctx, companyId, options),
    listStatuses(ctx, companyId).catch(() => []),
  ]);
  const steps = planSteps(run, facts);
  const pack = loadPack();
  const statuses = Object.fromEntries(statusRows.map((row) => [row.pluginKey, row.status]));
  return {
    // The stored owner list minus what the plugins now report done.
    run: run ? { ...run, grants: currentGrants(run.grants, statuses) } : null,
    status: run ? runStatus(steps) : "created",
    steps,
    facts,
    hires,
    starterPack,
    pack: { name: pack.pack, version: pack.version, updated: pack.updated, templates: pack.templates.length },
  };
}

// ---------------------------------------------------------------------------
// Running the worker's steps and recording the page's
// ---------------------------------------------------------------------------

function withStep(run: BootstrapRunState, id: StepId, record: Omit<StepRecord, "at">, now: string): BootstrapRunState {
  return { ...run, steps: { ...run.steps, [id]: { ...record, at: now } } };
}

function finish(run: BootstrapRunState, facts: PlanFacts, now: string): { run: BootstrapRunState; steps: PlannedStep[] } {
  const steps = planSteps(run, facts);
  const status = runStatus(steps);
  const completedAt = status === "complete" ? run.completedAt ?? now : null;
  return { run: { ...run, status, updatedAt: now, completedAt }, steps };
}

/**
 * The first call of a bootstrap (and every repeat): saves the module choice
 * (every module on unless `options.modules` says otherwise; a choice already
 * saved is kept when no switches are passed), opens or updates the Finish setup
 * issue, and returns the plan with each step's status. Idempotent: repeating it
 * changes nothing that is already done.
 */
export async function bootstrapCompany(
  ctx: PluginContext,
  input: { companyId: string; userId: string | null; options?: unknown },
  clock: Clock = systemClock,
): Promise<{ run: BootstrapRunState; steps: PlannedStep[]; modules: Record<string, boolean> | null; company: CompanyInfo }> {
  if (!input.userId) throw new SetupError("Only a board user can bootstrap a company");
  const now = clock.now().toISOString();
  const options = sanitizeOptions(input.options);
  const company = await companyInfo(ctx, input.companyId);
  let run = (await getRun(ctx, input.companyId)) ?? freshRun(input.companyId, "page", input.userId, now);
  run = { ...run, options: { ...run.options, ...options }, startedBy: run.startedBy ?? input.userId };

  // 1. modules (and, through saveModules, the Finish setup issue)
  const existing = await getChoice(ctx, input.companyId);
  let modules: Record<string, boolean> | null = existing ? (existing.modules as Record<string, boolean>) : null;
  let issueNote: { status: StepRecord["status"]; detail: string };
  if (options.modules !== undefined || !existing) {
    const saved = await saveModules(ctx, { companyId: input.companyId, modules: options.modules ?? {}, userId: input.userId }, clock);
    modules = saved.modules as Record<string, boolean>;
    const off = Object.entries(saved.modules).filter(([, on]) => !on).map(([key]) => key);
    run = withStep(run, "modules", { status: "done", detail: off.length ? `Saved. Switched off: ${off.join(", ")}.` : "Saved: every module is on." }, now);
    issueNote = issueStatus(saved.issue);
  } else {
    run = withStep(run, "modules", { status: "done", detail: "The module choice was already saved." }, now);
    try {
      issueNote = issueStatus(await refreshFinishIssue(ctx, input.companyId, { allowCreate: true }, clock));
    } catch (error) {
      issueNote = { status: "failed", detail: `Could not open the Finish setup issue: ${message(error)}` };
    }
  }
  run = withStep(run, "finish-issue", issueNote, now);
  const result = finish(run, await planFacts(ctx, input.companyId), now);
  await saveRun(ctx, result.run);
  return { run: result.run, steps: result.steps, modules, company };
}

function issueStatus(result: Awaited<ReturnType<typeof refreshFinishIssue>> | null): { status: StepRecord["status"]; detail: string } {
  if (!result) return { status: "failed", detail: "The Finish setup issue could not be opened." };
  if (result.action === "skipped") return { status: "skipped", detail: `Not opened: ${result.reason}.` };
  if (result.action === "none" || result.action === "closed") return { status: "done", detail: "Nothing required is missing, so there is no Finish setup issue." };
  return { status: "done", detail: result.action === "created" ? "Opened the Finish setup issue." : "The Finish setup issue is open and up to date." };
}

export interface RecordInput {
  companyId: string;
  userId: string | null;
  stepId: unknown;
  status: unknown;
  detail?: unknown;
  items?: unknown;
  grants?: unknown;
  /** The Cockpit's import result, when the starter pack step imported. */
  starterImport?: unknown;
}

/** The page reports one step's outcome. Size and shape are checked here, never trusted. */
export async function recordStep(ctx: PluginContext, input: RecordInput, clock: Clock = systemClock) {
  if (!input.userId) throw new SetupError("Only a board user can record a bootstrap step");
  if (!isStepId(input.stepId)) throw new SetupError("Unknown bootstrap step");
  if (WORKER_STEPS.includes(input.stepId)) throw new SetupError(`${input.stepId} is run by Setup itself`);
  if (!isStepStatus(input.status)) throw new SetupError("Unknown step status");
  const now = clock.now().toISOString();
  let run = (await getRun(ctx, input.companyId)) ?? freshRun(input.companyId, "page", input.userId, now);
  const items = sanitizeItems(input.items);
  const record: Omit<StepRecord, "at"> = { status: input.status, detail: clip(input.detail, 500) || null, ...(items.length ? { items } : {}) };
  run = withStep(run, input.stepId, record, now);
  let grantsChanged = false;
  if (input.stepId === "owner-list" && input.grants !== undefined) {
    const grants = sanitizeGrants(input.grants);
    grantsChanged = JSON.stringify(grants) !== JSON.stringify(run.grants);
    run = { ...run, grants };
    run = withStep(run, "owner-list", { status: grants.length ? "needs_owner" : "done", detail: grants.length ? `${grants.length} one-time ${grants.length === 1 ? "step" : "steps"} for you.` : "Nothing needs you.", ...(items.length ? { items } : {}) }, now);
  }
  if (input.stepId === "starter-pack" && input.starterImport) {
    const pack = loadStarterPack();
    await saveStarterImport(ctx, { companyId: input.companyId, packVersion: pack.version, contentHash: starterPackHash(pack), result: { ...parseImportResult(input.starterImport) }, importedBy: input.userId, importedAt: now });
  }
  const result = finish(run, await planFacts(ctx, input.companyId), now);
  await saveRun(ctx, result.run);
  if (grantsChanged) {
    try {
      await refreshFinishIssue(ctx, input.companyId, { allowCreate: false }, clock);
    } catch (error) {
      ctx.logger.info("Finish setup refresh failed", { companyId: input.companyId, error: message(error) });
    }
  }
  return { run: result.run, steps: result.steps };
}

/** At company.created the plugin only remembers the company; nothing is run. */
export async function rememberNewCompany(ctx: PluginContext, companyId: string, source: string, clock: Clock = systemClock): Promise<void> {
  await ensureRun(ctx, { companyId, source, now: clock.now().toISOString() });
}

// ---------------------------------------------------------------------------
// Template pack: drafts and hire tasks
// ---------------------------------------------------------------------------

/** Agents as the page sends them: only the fields matching needs, at most 200. */
export function toAgentLikes(raw: unknown): AgentLike[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentLike[] = [];
  for (const entry of raw.slice(0, 200)) {
    const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const id = typeof row?.id === "string" ? row.id : "";
    if (!row || !id) continue;
    out.push({
      id,
      name: typeof row.name === "string" ? row.name : "Agent",
      title: typeof row.title === "string" ? row.title : null,
      role: typeof row.role === "string" ? row.role : null,
      status: typeof row.status === "string" ? row.status : "",
      reportsTo: typeof row.reportsTo === "string" ? row.reportsTo : null,
      urlKey: typeof row.urlKey === "string" ? row.urlKey : null,
    });
  }
  return out;
}

interface DraftInput {
  companyId: string;
  key: unknown;
  agents?: unknown;
  ceo?: unknown;
  ownerName?: unknown;
  wikiRoot?: unknown;
}

async function varsFor(ctx: PluginContext, input: DraftInput) {
  const company = await companyInfo(ctx, input.companyId);
  const ceo = input.ceo && typeof input.ceo === "object" ? (input.ceo as Record<string, unknown>) : null;
  return {
    company,
    vars: templateVars({
      company: company.name === "the company" ? null : company.name,
      prefix: company.prefix,
      owner: typeof input.ownerName === "string" ? input.ownerName.slice(0, 80) : null,
      ceo: ceo && typeof ceo.name === "string" ? { name: ceo.name.slice(0, 80), urlKey: typeof ceo.urlKey === "string" ? ceo.urlKey : null } : null,
      wikiRoot: typeof input.wikiRoot === "string" ? input.wikiRoot.slice(0, 300) : null,
    }),
  };
}

function templateOrThrow(key: unknown): AgentTemplate {
  const template = typeof key === "string" ? templateByKey(key) : null;
  if (!template) throw new SetupError("Unknown template. Setup lists the pack's templates on the New company page.");
  return template;
}

export async function templateDraft(ctx: PluginContext, input: DraftInput) {
  const template = templateOrThrow(input.key);
  const { vars } = await varsFor(ctx, input);
  const draft = renderHire(template, { vars, agents: toAgentLikes(input.agents) });
  return { key: template.key, kitRole: template.kitRole ?? null, provisioning: template.provisioning, title: draft.title, description: draft.description, payload: draft.payload, adapterType: draft.adapterType, warnings: draft.warnings };
}

const CLOSED = new Set(["done", "cancelled"]);

/**
 * Opens the hire task for one template and assigns it (the CEO agent, or a
 * person when the company has no CEO yet). Idempotent: an open task for the
 * template is returned instead of a second one, and an agent that already is the
 * template needs none. A template that holds a kit role (the Growth Marketing
 * Lead holds Social) is hired through that plugin, not here, so the plugin links
 * and wires the agent.
 */
export async function startTemplateHire(
  ctx: PluginContext,
  input: DraftInput & { userId: string | null; assigneeAgentId?: unknown; assigneeUserId?: unknown },
  clock: Clock = systemClock,
) {
  if (!input.userId) throw new SetupError("Only a board user can open a hire task");
  const template = templateOrThrow(input.key);
  if (template.kitRole) {
    const role = TEAM_ROLES.find((entry) => entry.key === template.kitRole);
    throw new SetupError(`${template.name} holds the ${role?.title ?? template.kitRole} role: hire it from Setup -> Team (it uses ${role?.pluginKey ?? "the plugin"}'s own hire, so the agent is linked and wired). Use setup.template-draft for its description.`);
  }
  const agents = toAgentLikes(input.agents);
  const staffed = agents.length ? matchTemplate(template, agents) : null;
  if (staffed) return { hire: null, identifier: null, staffed: { id: staffed.id, name: staffed.name }, existed: false, woke: false };
  const assigneeAgentId = typeof input.assigneeAgentId === "string" && /^[0-9a-f-]{8,64}$/i.test(input.assigneeAgentId) ? input.assigneeAgentId : null;
  const assigneeUserId = !assigneeAgentId && typeof input.assigneeUserId === "string" && input.assigneeUserId ? input.assigneeUserId.slice(0, 80) : null;
  if (!assigneeAgentId && !assigneeUserId) throw new SetupError("Pick who does the hire: the CEO agent, or yourself when the company has no CEO yet.");

  const current = (await listTemplateHires(ctx, input.companyId)).find((row) => row.templateKey === template.key);
  if (current && current.status === "open") {
    const issue = await ctx.issues.get(current.issueId, input.companyId).catch(() => null);
    if (issue && !CLOSED.has(String(issue.status))) return { hire: current, identifier: (issue as { identifier?: string | null }).identifier ?? null, staffed: null, existed: true, woke: false };
  }
  const { vars } = await varsFor(ctx, input);
  const draft = renderHire(template, { vars, agents });
  const created = await createWorkIssue(ctx, {
    companyId: input.companyId,
    title: draft.title,
    description: draft.description,
    originKind: `plugin:${PLUGIN_ID}` as never,
    originId: `template-hire:${template.key}`,
    ...(assigneeAgentId ? { assigneeAgentId } : { assigneeUserId }),
    wakeReason: `Hire request for the ${template.name} (team template pack)`,
    actor: { actorUserId: input.userId },
  } as Parameters<typeof createWorkIssue>[1]);
  const row: TemplateHireRow = {
    companyId: input.companyId,
    templateKey: template.key,
    packVersion: loadPack().version,
    issueId: created.id,
    assigneeAgentId,
    assigneeUserId,
    status: "open",
    createdAt: clock.now().toISOString(),
  };
  await saveTemplateHire(ctx, row);
  const made = (await ctx.issues.get(created.id, input.companyId).catch(() => null)) as { identifier?: string | null } | null;
  return { hire: row, identifier: made?.identifier ?? null, staffed: null, existed: false, woke: created.woke };
}

// ---------------------------------------------------------------------------
// For the ops scripts: the pack and the kit roles' run profiles for one company
// ---------------------------------------------------------------------------

/** The adapter and runtime settings of a profile for each adapter it can run on (Hermes only when the profile has a Hermes model). */
function profilesFor(profile: RunProfile) {
  const heartbeat = (extra: Record<string, unknown> = {}) => ({ heartbeat: { maxConcurrentRuns: profile.maxConcurrentRuns, ...extra } });
  return {
    claude_local: { adapterConfig: runProfileConfig(profile, "claude_local").adapterConfig, runtimeConfig: heartbeat() },
    hermes_local: profile.hermes ? { adapterConfig: runProfileConfig(profile, "hermes_local").adapterConfig, runtimeConfig: heartbeat() } : null,
  };
}

/**
 * Everything `new-company.py` needs from the plugin, so the script has no copy of
 * any profile: each template rendered for the company (instructions, payload,
 * adapter and runtime settings per adapter), each kit role's skills and run
 * profile, and the skill sync action of each plugin. Served by `GET /templates`.
 */
export async function templatesForOps(ctx: PluginContext, input: DraftInput) {
  const { company, vars } = await varsFor(ctx, input);
  const agents = toAgentLikes(input.agents);
  const pack = loadPack();
  return {
    company: { id: company.id, name: company.name, prefix: company.prefix },
    pack: { name: pack.pack, version: pack.version, updated: pack.updated },
    templates: pack.templates.map((template) => {
      const draft = renderHire(template, { vars, agents });
      const adapterType = pickAdapter(template);
      const config = templateConfig(template, adapterType);
      return {
        key: template.key,
        name: template.name,
        title: template.title,
        role: template.role,
        group: template.group,
        provisioning: template.provisioning,
        defaultOn: template.defaultOn,
        kitRole: template.kitRole ?? null,
        reportsTo: template.reportsTo,
        adapterType,
        adapterConfig: config.adapterConfig,
        runtimeConfig: config.runtimeConfig,
        profiles: profilesFor(template.runProfile),
        desiredSkills: template.desiredSkills,
        match: template.match,
        requires: template.requires,
        instructions: draft.instructions,
        payload: draft.payload,
      };
    }),
    kitRoles: TEAM_ROLES.map((role) => ({
      key: role.key,
      title: role.title,
      module: role.module,
      pluginKey: role.pluginKey,
      skills: role.skills,
      extraSkills: role.extraSkills ?? [],
      runProfile: role.runProfile,
      profiles: profilesFor(role.runProfile),
    })),
    skillSyncActions: SKILL_SYNC_ACTIONS,
    steps: BOOTSTRAP_STEPS.map((step) => ({ id: step.id, title: step.title, where: step.where })),
  };
}
