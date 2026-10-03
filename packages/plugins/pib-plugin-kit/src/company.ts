/**
 * Every company, not only the one a call arrives from (Q7-2, Q7-12, Q3-9, Q7-3).
 *
 * The gap. A managed skill reached a company only when a company-scoped call
 * hit that plugin's worker (`createSkillSyncer.ensure`), or when a person ran
 * the sync by hand. A company nobody touched (Partners in Apps, idle since
 * 2026-09-28) kept stale copies, and nothing noticed. A new company got its
 * skills only through each plugin's own `company.created` handler, and nothing
 * checked that every plugin had one (the Cockpit had none).
 *
 * What the host allows, which bounds what is possible here (wiki
 * plugin-jobs-company-scope):
 * - A scheduled job runs with no invocation scope. A host call from a job
 *   passes only when it names a company that has a SAVED plugin config row for
 *   this plugin. A company whose plugin settings were never saved (Partners in
 *   Apps today) is refused with "company context is required", whatever the
 *   plugin does. So a job CANNOT sync skills for such a company; it can only
 *   report that it could not (`needs_settings`).
 * - Calls made inside an invocation for a company (tool, action, event) pass
 *   for that company, configured or not. That is why `company.created`, and
 *   the lazy events below, work for any company.
 * - `ctx.companies.list` fails while another call is in flight in the worker,
 *   so company ids come from the plugin's own memory (`knownCompanyIds`), not
 *   from a list call.
 *
 * Provided here: `syncAllCompanies` (sweep every known company), the periodic
 * variant (`createPeriodicSkillSync`, `registerSkillSyncJob`),
 * `registerCompanyBootstrap` (the one `company.created` wiring every plugin
 * calls once, plus lazy catch-up events), and the checks the Cockpit publishes
 * (`skillSyncCheck`, `skillsBehind`).
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { ownerUserFor, trackJob, type HealthCheck } from "./cockpit.js";
import { createWorkIssue } from "./issues.js";
import { knownCompanyIds, rememberCompany } from "./known-companies.js";
import { skillVersion, type SkillDeclarationLike, type SkillSyncer, type SkillSyncResult } from "./skills.js";
import { TEAM_SETUP_PATH } from "./team.js";

// ---------------------------------------------------------------------------
// Which companies
// ---------------------------------------------------------------------------

export interface CompanyIdList {
  ids: string[];
  /** `companies.list` answered (its ids are included); false when it was refused or absent. */
  listed: boolean;
  listError?: string;
}

/**
 * The company ids a plugin should act for: the ones given, the ones the plugin
 * remembered, and (best effort) the host's list. A refused `companies.list`
 * does not fail the call.
 */
export async function listCompanyIds(ctx: PluginContext, options: { extra?: string[]; includeHostList?: boolean } = {}): Promise<CompanyIdList> {
  const ids = new Set<string>(options.extra ?? []);
  for (const id of await knownCompanyIds(ctx)) ids.add(id);
  let listed = false;
  let listError: string | undefined;
  if (options.includeHostList !== false) {
    try {
      const companies = (await ctx.companies.list({ limit: 100 })) as Array<{ id?: string }>;
      for (const company of companies) if (company?.id) ids.add(String(company.id));
      listed = true;
    } catch (error) {
      listError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ids: [...ids], listed, ...(listError ? { listError } : {}) };
}

// ---------------------------------------------------------------------------
// Sweeping every company
// ---------------------------------------------------------------------------

export type CompanySyncStatus = "synced" | "unchanged" | "needs_settings" | "failed" | "skipped";

export interface CompanySyncOutcome {
  companyId: string;
  status: CompanySyncStatus;
  /** Skill keys whose content was replaced. */
  reset: string[];
  error?: string;
}

export interface SkillSyncSweep {
  outcomes: CompanySyncOutcome[];
  listed: boolean;
  listError?: string;
}

/**
 * The error text the host gives a job that names a company with no saved plugin
 * config. Only this: the generic "is not allowed to perform" prefix is also what
 * a missing capability says, "requested company X but scoped to Y" is a caller
 * bug, and "missing, expired, or unknown invocation scope" is a transient scope
 * failure; none of those is fixed by saving settings, so they stay `failed`.
 */
const NEEDS_SETTINGS = /company context is required/i;

/** Classifies one company's sync results. */
export function classifySkillSync(results: SkillSyncResult[]): { status: CompanySyncStatus; reset: string[]; error?: string } {
  const failed = results.filter((r) => r.action === "failed");
  const reset = results.filter((r) => r.action === "reset").map((r) => r.skillKey);
  if (failed.length > 0) {
    const error = failed.map((f) => f.error ?? "failed").join("; ").slice(0, 400);
    return { status: failed.every((f) => NEEDS_SETTINGS.test(f.error ?? "")) ? "needs_settings" : "failed", reset, error };
  }
  return { status: reset.length > 0 ? "synced" : "unchanged", reset };
}

export interface SyncAllOptions {
  /** Companies to sync (the plugin's own rows); merged with the remembered ones. */
  companyIds?: string[];
  /** Reset every skill, not only changed ones. */
  force?: boolean;
  /** False for a company that switched this plugin's module off (kit `isModuleEnabled`); it is skipped. */
  isEnabled?: (companyId: string) => Promise<boolean>;
  /** Ask the host for its company list too (default true; a refusal is ignored). */
  includeHostList?: boolean;
  /** The plugin, for the status the Cockpit shows. */
  plugin?: string;
}

const SYNC_STATUS_STATE = { scopeKind: "instance" as const, namespace: "pib-kit", stateKey: "skill-sync-status" };

interface StoredSyncStatus {
  status: CompanySyncStatus;
  at: string;
  error?: string;
  plugin?: string;
}

async function recordSyncStatus(ctx: PluginContext, outcomes: CompanySyncOutcome[], plugin: string | undefined, now: string): Promise<void> {
  try {
    const stored = ((await ctx.state.get(SYNC_STATUS_STATE)) as { companies?: Record<string, StoredSyncStatus> } | null)?.companies ?? {};
    for (const outcome of outcomes) {
      stored[outcome.companyId] = { status: outcome.status, at: now, ...(outcome.error ? { error: outcome.error } : {}), ...(plugin ? { plugin } : {}) };
    }
    await ctx.state.set(SYNC_STATUS_STATE, { companies: stored });
  } catch {
    // status is best effort
  }
}

/**
 * Brings the managed skills of every known company up to date, each company on
 * its own so one failure does not stop the rest. Call it from a job (it names
 * each company explicitly), from `createPeriodicSkillSync`, or after a deploy.
 *
 * A company whose plugin settings were never saved cannot be synced from a job
 * (host rule above): it comes back `needs_settings`, and `skillSyncCheck` tells
 * the Cockpit to ask for the settings. It still syncs the first time any tool,
 * action or event for it reaches the plugin (`registerCompanyBootstrap`'s lazy
 * events, or the plugin's own `skillSync.ensure`).
 */
export async function syncAllCompanies(ctx: PluginContext, syncer: SkillSyncer, options: SyncAllOptions = {}): Promise<SkillSyncSweep> {
  const list = await listCompanyIds(ctx, { extra: options.companyIds, includeHostList: options.includeHostList });
  const outcomes: CompanySyncOutcome[] = [];
  for (const companyId of list.ids) {
    try {
      if (options.isEnabled && !(await options.isEnabled(companyId))) {
        outcomes.push({ companyId, status: "skipped", reset: [] });
        continue;
      }
      const results = options.force ? await syncer.force(companyId) : await syncer.check(companyId);
      outcomes.push({ companyId, ...classifySkillSync(results) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({ companyId, status: NEEDS_SETTINGS.test(message) ? "needs_settings" : "failed", reset: [], error: message.slice(0, 400) });
    }
  }
  await recordSyncStatus(ctx, outcomes, options.plugin, new Date().toISOString());
  const problems = outcomes.filter((o) => o.status === "needs_settings" || o.status === "failed");
  if (problems.length > 0) ctx.logger.info("Managed skill sweep incomplete", { plugin: options.plugin ?? null, problems: problems.map((p) => ({ companyId: p.companyId, status: p.status })) });
  return { outcomes, listed: list.listed, ...(list.listError ? { listError: list.listError } : {}) };
}

/** Manifest entry for a plugin that wants its own sweep job (a plugin may instead call the sweep from an hourly job it already has). */
export const SKILL_SYNC_JOB = {
  jobKey: "sync-skills-all",
  displayName: "Sync managed skills for every company",
  description: "Brings this plugin's managed skills up to date for every company it knows, not only the one a call comes from, and reports companies whose plugin settings are not saved.",
  schedule: "41 */6 * * *",
} as const;

/**
 * The periodic variant: a function a job calls. `options` is evaluated on every
 * run, so `companyIds` can read the plugin's own tables.
 */
export function createPeriodicSkillSync(
  ctx: PluginContext,
  syncer: SkillSyncer,
  options: Omit<SyncAllOptions, "companyIds"> & { companyIds?: () => Promise<string[]> | string[] } = {},
): () => Promise<SkillSyncSweep> {
  return async () => {
    const companyIds = options.companyIds ? await options.companyIds() : [];
    return syncAllCompanies(ctx, syncer, { ...options, companyIds });
  };
}

/** Registers `SKILL_SYNC_JOB` for the plugin (declare `SKILL_SYNC_JOB` in its manifest `jobs`). Tracked for job health. */
export function registerSkillSyncJob(ctx: PluginContext, syncer: SkillSyncer, options: Parameters<typeof createPeriodicSkillSync>[2] = {}): void {
  const sweep = createPeriodicSkillSync(ctx, syncer, options);
  ctx.jobs.register(SKILL_SYNC_JOB.jobKey, async () => {
    await trackJob(ctx, SKILL_SYNC_JOB.jobKey, sweep);
  });
}

// ---------------------------------------------------------------------------
// What the Cockpit shows
// ---------------------------------------------------------------------------

/** Cockpit health check: this plugin could not sync its skills for the company (settings not saved, or an error). Null when fine or unknown. */
export async function skillSyncCheck(ctx: PluginContext, companyId: string, pluginTitle: string, now: number = Date.now()): Promise<HealthCheck | null> {
  let entry: StoredSyncStatus | undefined;
  try {
    entry = ((await ctx.state.get(SYNC_STATUS_STATE)) as { companies?: Record<string, StoredSyncStatus> } | null)?.companies?.[companyId];
  } catch {
    return null;
  }
  if (!entry || (entry.status !== "needs_settings" && entry.status !== "failed")) return null;
  const since = entry.at;
  const age = Number.isFinite(Date.parse(since)) ? now - Date.parse(since) : 0;
  if (entry.status === "needs_settings") {
    return {
      key: `skills:${pluginTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      title: `${pluginTitle} skills not synced`,
      status: age > 24 * 3_600_000 ? "bad" : "warn",
      detail: `The ${pluginTitle} plugin's settings are not saved for this company, so its hourly job cannot reach the company to update the agents' skills; they stay on whatever version they have.`,
      fix: `Open Settings → Plugins → ${pluginTitle} and click Save Configuration once for this company. The skills then sync by themselves.`,
      href: "/company/settings/instance/plugins",
      since,
    };
  }
  return { key: `skills:${pluginTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, title: `${pluginTitle} skills not synced`, status: "warn", detail: `The last skill sync for this company failed: ${entry.error ?? "unknown error"}.`, fix: "Open the plugin page once; the sync retries on every visit and hourly.", since };
}

/**
 * Which of the syncer's skills this company has not received at their current
 * version (the version marker `syncManagedSkills` stores per company). Reading a
 * company's marker needs a scope for it (an action or tool call, or a job for a
 * configured company); `unreadable` is true when the host refused.
 */
export async function skillsBehind(ctx: PluginContext, companyId: string, skills: SkillDeclarationLike[]): Promise<{ behind: string[]; unreadable: boolean }> {
  const behind: string[] = [];
  for (const skill of skills) {
    try {
      const deployed = await ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: "pib-kit", stateKey: `skill-ver:${skill.skillKey}` });
      if (deployed !== skillVersion(skill)) behind.push(skill.skillKey);
    } catch {
      return { behind: [], unreadable: true };
    }
  }
  return { behind, unreadable: false };
}

// ---------------------------------------------------------------------------
// New companies
// ---------------------------------------------------------------------------

/**
 * Core events that carry a company id and are rare enough to run the bootstrap
 * lazily for a company that never saw `company.created`. Never an agent event:
 * `registerHireWatch` already subscribes to those in six plugins, the host runs
 * every handler subscribed to a name on each delivery, and a second handler
 * would run twice (the contract test `core event subscriptions` enforces it).
 */
export const LAZY_BOOTSTRAP_EVENTS = ["company.updated", "project.created"] as const;

export interface CompanyBootstrapOptions {
  /** The plugin's skill syncer (kit `createSkillSyncer`); `ensure` runs for the company. */
  syncer?: Pick<SkillSyncer, "ensure">;
  /** Create or reconcile the plugin's managed resources for the company (project, routines). */
  ensureResources?: (companyId: string) => Promise<unknown>;
  /** Anything else the plugin does for a new company. */
  onBootstrap?: (companyId: string, source: BootstrapSource) => Promise<void>;
  /**
   * Open ONE owner issue "Set up <company>" with Setup → Team deep links, once
   * per company (idempotent). Turn it on in exactly one plugin (Setup), or the
   * owner gets one per plugin. `originKind` defaults to `plugin:<manifest id>`.
   */
  ownerIssue?: false | { originKind?: string };
  /** Core events that run the bootstrap for a company that missed `company.created`; false for none. */
  lazyOn?: readonly string[] | false;
}

export type BootstrapSource = "company.created" | "lazy" | "manual";

export interface CompanyBootstrapReport {
  companyId: string;
  source: BootstrapSource;
  skills: SkillSyncResult[];
  resources: "ok" | "skipped" | "failed";
  ownerIssue: "opened" | "exists" | "skipped" | "failed";
  ownerIssueId?: string;
  errors: string[];
}

const BOOTSTRAP_ISSUE_ORIGIN = "company-setup";

/**
 * The one `company.created` wiring a plugin makes (replaces its hand-written
 * `ctx.events.on("company.created", ...)`): remembers the company, syncs the
 * plugin's skills, ensures its managed resources, and optionally opens the
 * owner's "Set up <company>" issue. Also runs lazily (once per process) on the
 * first rare core event for a company that missed `company.created`, which is
 * how a company created before the plugin was installed gets its skills without
 * anyone touching it. Returns `run` so a plugin can bootstrap by hand.
 */
export function registerCompanyBootstrap(ctx: PluginContext, options: CompanyBootstrapOptions = {}): { run: (companyId: string, source?: BootstrapSource) => Promise<CompanyBootstrapReport> } {
  const lazyDone = new Set<string>();
  const lazyRunning = new Set<string>();

  const run = async (companyId: string, source: BootstrapSource = "manual"): Promise<CompanyBootstrapReport> => {
    const report: CompanyBootstrapReport = { companyId, source, skills: [], resources: "skipped", ownerIssue: "skipped", errors: [] };
    await rememberCompany(ctx, companyId);
    if (options.syncer) {
      try {
        report.skills = await options.syncer.ensure(companyId);
      } catch (error) {
        report.errors.push(`skills: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (options.ensureResources) {
      try {
        await options.ensureResources(companyId);
        report.resources = "ok";
      } catch (error) {
        report.resources = "failed";
        report.errors.push(`resources: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (options.onBootstrap) {
      try {
        await options.onBootstrap(companyId, source);
      } catch (error) {
        report.errors.push(`bootstrap: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (options.ownerIssue && source !== "lazy") {
      try {
        const opened = await openCompanySetupIssue(ctx, companyId, options.ownerIssue.originKind);
        report.ownerIssue = opened.created ? "opened" : "exists";
        if (opened.id) report.ownerIssueId = opened.id;
      } catch (error) {
        report.ownerIssue = "failed";
        report.errors.push(`owner issue: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (report.errors.length > 0) ctx.logger.info("Company bootstrap incomplete", { companyId, source, errors: report.errors });
    return report;
  };

  ctx.events.on("company.created", async (event: PluginEvent) => {
    if (event.companyId) await run(event.companyId, "company.created");
  });
  if (options.lazyOn !== false) {
    for (const name of options.lazyOn ?? LAZY_BOOTSTRAP_EVENTS) {
      ctx.events.on(name as Parameters<PluginContext["events"]["on"]>[0], async (event: PluginEvent) => {
        const companyId = event.companyId;
        if (!companyId || lazyDone.has(companyId) || lazyRunning.has(companyId)) return;
        lazyRunning.add(companyId);
        try {
          // A clean run is final for this worker; one with errors is tried again on the next event.
          if ((await run(companyId, "lazy")).errors.length === 0) lazyDone.add(companyId);
        } finally {
          lazyRunning.delete(companyId);
        }
      });
    }
  }
  return { run };
}

const SETUP_ISSUE_STATE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "pib-kit", stateKey: "company-setup-issue" });

/** The text of the owner's first issue for a new company. Deterministic, so a test can read it. */
export function companySetupIssueText(company: { name: string; prefix: string | null }): { title: string; description: string } {
  const prefix = company.prefix ? `/${company.prefix}` : "";
  return {
    title: `Set up ${company.name}`,
    description: [
      `${company.name} is new. The PiB plugins are installed, and each plugin's skills are already in the company's skill library. Three one-time steps make the rest run by itself:`,
      "",
      `1. **Staff the team.** Open [Setup → Team](${prefix}${TEAM_SETUP_PATH}) and hire or pick an agent for each role. Roles are staffed only there.`,
      "2. **Save each plugin's settings once.** Open [Settings → Plugins](/company/settings/instance/plugins), open each PiB plugin and click Save Configuration. Until you do, the plugin's hourly jobs cannot act for this company, and its agents' skills stay as they are.",
      `3. **Check the owner.** In [Setup → Team](${prefix}${TEAM_SETUP_PATH}) make sure you are set as the owner: the owner receives the daily brief and every approval.`,
      "",
      "Setup shows what is still missing and links to each step. Close this issue when the Setup page says done.",
    ].join("\n"),
  };
}

/**
 * Opens the owner's "Set up <company>" issue once per company. Returns
 * `created: false` when it already exists. The owner is the company's default
 * responsible user (the roles copy does not exist yet at `company.created`);
 * with none, the issue opens unassigned (the host's company-level inbox).
 */
export async function openCompanySetupIssue(ctx: PluginContext, companyId: string, originKind?: string): Promise<{ created: boolean; id: string | null }> {
  try {
    const marker = (await ctx.state.get(SETUP_ISSUE_STATE(companyId))) as { issueId?: string } | null;
    if (marker?.issueId) return { created: false, id: marker.issueId };
  } catch {
    // fall through to the list check
  }
  const kind = originKind ?? `plugin:${(ctx as { manifest?: { id?: string } }).manifest?.id ?? "partnersinbiz.setup"}`;
  try {
    const existing = (await ctx.issues.list({ companyId, originKind: kind as never, originId: BOOTSTRAP_ISSUE_ORIGIN, limit: 1 })) as Array<{ id: string }>;
    if (existing[0]) return { created: false, id: existing[0].id };
  } catch {
    // creating is still safe: the marker below stops repeats
  }
  const company = (await ctx.companies.get(companyId).catch(() => null)) as { name?: string; issuePrefix?: string } | null;
  const text = companySetupIssueText({ name: company?.name ?? "the company", prefix: company?.issuePrefix ?? null });
  const owner = await ownerUserFor(ctx, companyId);
  const created = await createWorkIssue(ctx, {
    companyId,
    title: text.title,
    description: text.description,
    originKind: kind as never,
    originId: BOOTSTRAP_ISSUE_ORIGIN,
    ...(owner.userId ? { assigneeUserId: owner.userId } : {}),
    wake: false,
  } as Parameters<typeof createWorkIssue>[1]);
  await ctx.state.set(SETUP_ISSUE_STATE(companyId), { issueId: created.id, at: new Date().toISOString() }).catch(() => undefined);
  return { created: true, id: created.id };
}
