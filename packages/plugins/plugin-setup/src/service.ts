/**
 * Worker-side setup logic. Every function takes `companyId` explicitly: jobs
 * have no company scope, and the host only lets a job act for a company whose
 * Setup settings were saved.
 */
import { createHash } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { PIB_PLUGINS, configSaved, createWorkIssue, readConfig } from "@partnersinbiz/pib-plugin-kit";
import { DRIVE_BINDING_EVENT, DRIVE_BINDING_SET_EVENT, parseDriveBindingEvent, type DriveBinding } from "./drive-checklist.js";
import { listAllCompanies } from "./access.js";
import { ENTITLEMENT_STATES, entitledModules, isPlan, planModules, type EntitlementRow, type EntitlementState } from "./entitlements.js";
import { MODULE_KEYS, moduleOfPlugin, MODULES, SETUP_EVENTS, type ModuleKey, type ModulesPayload, type SetupStatus, type SetupSummary } from "./kit-setup.js";
import { currentGrants, grantsMarkdown } from "./bootstrap.js";
import {
  clearFinishIssue,
  companiesWithEntitlements,
  getChoice,
  getEntitlements,
  getFinishIssue,
  getRun,
  listChoices,
  listStatuses,
  insertEntitlementIfMissing,
  saveChoice,
  saveEntitlement,
  saveFinishIssue,
  upsertStatus,
} from "./db.js";
import { finishSetupContent, finishSetupSummary, type InstalledPlugin } from "./finish-issue.js";
import { memoryStatus, parseWikiSnapshot, WIKI_PLUGIN } from "./memory.js";
import { effectiveModules, normalizeEntitledModules, SetupError, type ModuleChoice } from "./modules.js";
import { PLUGIN_ID } from "./namespace.js";
import { parseSetupStatus } from "./status.js";

/**
 * Setup → Cockpit: the one setup count for a company, sent whenever it is
 * worked out (and hourly), so the Operator's brief says the same number as
 * the Setup page. Arrives as `plugin.partnersinbiz.setup.setup.summary`.
 */
export const SUMMARY_EVENT = "setup.summary";

export interface SummaryPayload extends SetupSummary {
  companyId: string;
  /** The open Finish setup issue, when there is one (so the Cockpit lists it once). */
  finishIssueId: string | null;
  updatedAt: string;
}

export interface Clock {
  now(): Date;
}

const systemClock: Clock = { now: () => new Date() };

const INSTALLED_STATE = { scopeKind: "instance" as const, namespace: "setup", stateKey: "installed-plugins" };

// ---------------------------------------------------------------------------
// Drive binding (CRM integration)
// ---------------------------------------------------------------------------

const driveBindingState = (companyId: string) => ({ scopeKind: "company" as const, namespace: "setup", stateKey: `drive-binding:${companyId}` });

export async function onDriveBindingEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const binding = parseDriveBindingEvent(event.payload);
  if (!binding) return;
  try {
    await ctx.state.set(driveBindingState(binding.companyId), binding);
  } catch (error) {
    ctx.logger.info("Could not store drive binding", { companyId: binding.companyId, error: message(error) });
  }
}

export async function readDriveBinding(ctx: PluginContext, companyId: string): Promise<DriveBinding | null> {
  try {
    const raw = await ctx.state.get(driveBindingState(companyId));
    const parsed = parseDriveBindingEvent(raw);
    return parsed;
  } catch {
    return null;
  }
}

export async function onDriveBind(ctx: PluginContext, input: { companyId: string; sharedDriveId: unknown }): Promise<{ ok: boolean; error?: string }> {
  const binding = await readDriveBinding(ctx, input.companyId);
  const driveId = String(input.sharedDriveId ?? "");

  // Reject if the ID is not in the candidates
  if (!binding || !binding.candidates.some((c) => c.id === driveId)) {
    return { ok: false, error: "Drive ID not in available candidates" };
  }

  // Emit the drive.binding.set event for the CRM to handle
  try {
    await ctx.events.emit(
      DRIVE_BINDING_SET_EVENT,
      input.companyId,
      { companyId: input.companyId, sharedDriveId: driveId } as unknown as Record<string, unknown>,
    );
  } catch (error) {
    ctx.logger.info("Could not emit drive binding set event", { companyId: input.companyId, error: message(error) });
    return { ok: false, error: "Could not send binding request" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Module choice
// ---------------------------------------------------------------------------

export async function emitModules(ctx: PluginContext, companyId: string, modules: Partial<ModuleChoice>, updatedAt: string): Promise<void> {
  const payload: ModulesPayload = { companyId, modules, updatedAt };
  await ctx.events.emit(SETUP_EVENTS.modulesUpdated, companyId, payload as unknown as Record<string, unknown>);
}

export async function saveModules(
  ctx: PluginContext,
  input: { companyId: string; modules: unknown; userId: string | null },
  clock: Clock = systemClock,
): Promise<{ modules: ModuleChoice; updatedAt: string; issue: RefreshResult | null }> {
  const { entitled } = await moduleView(ctx, input.companyId, clock);
  const modules = normalizeEntitledModules(input.modules, entitled);
  const updatedAt = clock.now().toISOString();
  const previous = await getChoice(ctx, input.companyId);
  await saveChoice(ctx, { companyId: input.companyId, modules, updatedAt, updatedBy: input.userId ?? previous?.updatedBy ?? null });
  try {
    await emitModules(ctx, input.companyId, modules, updatedAt);
  } catch (error) {
    // The hourly re-emit catches up.
    ctx.logger.info("Module switch emit failed", { companyId: input.companyId, error: message(error) });
  }
  let issue: RefreshResult | null = null;
  try {
    issue = await refreshFinishIssue(ctx, input.companyId, { allowCreate: true }, clock);
  } catch (error) {
    ctx.logger.info("Finish setup refresh failed", { companyId: input.companyId, error: message(error) });
  }
  return { modules, updatedAt, issue };
}

/** Events are at-most-once: re-send every saved choice (hourly job). */
export async function reemitModules(ctx: PluginContext): Promise<{ emitted: number; skipped: number; failed: number }> {
  const result = { emitted: 0, skipped: 0, failed: 0 };
  // Companies with a saved choice, and companies with entitlements but no choice yet (they get exactly their entitlements).
  const companyIds = [...new Set([...(await listChoices(ctx)).map((choice) => choice.companyId), ...(await companiesWithEntitlements(ctx))])].sort();
  for (const companyId of companyIds) {
    if (!(await configSaved(ctx, companyId))) {
      result.skipped += 1;
      continue;
    }
    try {
      const view = await moduleView(ctx, companyId);
      await emitModules(ctx, companyId, view.modules, view.updatedAt ?? new Date().toISOString());
      result.emitted += 1;
    } catch (error) {
      result.failed += 1;
      ctx.logger.info("Module switch re-emit failed", { companyId, error: message(error) });
    }
    // The setup count too (the Cockpit's copy of it), for the same reason.
    try {
      const summary = await storedSummary(ctx, companyId);
      const issue = await getFinishIssue(ctx, companyId);
      if (summary) await emitSummary(ctx, companyId, summary, issue?.issueId ?? null);
    } catch (error) {
      ctx.logger.info("Setup summary re-emit failed", { companyId: companyId, error: message(error) });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Status projection
// ---------------------------------------------------------------------------

/** Store the newest `SetupStatus` a plugin pushed for a company. */
export async function onStatusEvent(ctx: PluginContext, pluginKey: string, event: PluginEvent, clock: Clock = systemClock): Promise<boolean> {
  const companyId = event.companyId;
  if (!companyId) return false;
  const status = parseSetupStatus(event.payload, pluginKey);
  if (!status) return false;
  // The subscription says who sent it; a payload cannot claim another plugin.
  const stored: SetupStatus = { ...status, plugin: pluginKey };
  await upsertStatus(ctx, { companyId, pluginKey, status: stored, checkedAt: stored.checkedAt, receivedAt: clock.now().toISOString() });
  // Keep an open Finish setup issue current (never opens a new one).
  try {
    await refreshFinishIssue(ctx, companyId, { allowCreate: false }, clock);
  } catch (error) {
    ctx.logger.info("Finish setup refresh failed", { companyId, error: message(error) });
  }
  return true;
}

/** The PiB plugins behind the modules (Company wiki reports through `reportMemory`). */
const REPORTABLE = new Set<string>(Object.values(MODULES).flatMap((module) => [...module.plugins] as string[]).filter((key) => key !== WIKI_PLUGIN));

/**
 * The Setup page checks each plugin live (`GET /setup-status`, board session)
 * and reports what it saw, so the stored statuses, the sidebar badge, the
 * Finish setup issue and the Cockpit count the same steps as the page. A
 * plugin's own hourly push replaces it again (newest `checkedAt` wins); a
 * reported time is never later than now, so it cannot block those pushes.
 */
export async function reportStatuses(ctx: PluginContext, companyId: string, statuses: unknown, clock: Clock = systemClock): Promise<{ stored: string[]; summary: SetupSummary | null }> {
  const stored: string[] = [];
  if (statuses && typeof statuses === "object" && !Array.isArray(statuses)) {
    const now = clock.now();
    for (const [pluginKey, raw] of Object.entries(statuses as Record<string, unknown>).slice(0, 40)) {
      if (!REPORTABLE.has(pluginKey)) continue;
      const parsed = parseSetupStatus(raw, pluginKey);
      if (!parsed) continue;
      const checked = Date.parse(parsed.checkedAt);
      const checkedAt = Number.isFinite(checked) && checked <= now.getTime() ? new Date(checked).toISOString() : now.toISOString();
      const status: SetupStatus = { ...parsed, plugin: pluginKey, module: parsed.module ?? moduleOfPlugin(pluginKey), checkedAt };
      await upsertStatus(ctx, { companyId, pluginKey, status, checkedAt, receivedAt: now.toISOString() });
      stored.push(pluginKey);
    }
  }
  let summary: SetupSummary | null = null;
  try {
    const result = await refreshFinishIssue(ctx, companyId, { allowCreate: false }, clock);
    summary = result.summary ?? null;
  } catch (error) {
    ctx.logger.info("Finish setup refresh failed", { companyId, error: message(error) });
  }
  return { stored, summary };
}

/**
 * Company wiki: LLM Wiki cannot push a status, so the Setup page reads it
 * (board session) and sends a snapshot. The worker builds the checklist from
 * it itself, so a page can report what it saw but not invent items or links.
 */
export async function reportMemory(ctx: PluginContext, companyId: string, snapshot: unknown, clock: Clock = systemClock): Promise<SetupStatus | null> {
  const parsed = parseWikiSnapshot(snapshot);
  if (!parsed) return null;
  const status = memoryStatus(parsed);
  await upsertStatus(ctx, { companyId, pluginKey: WIKI_PLUGIN, status, checkedAt: status.checkedAt, receivedAt: clock.now().toISOString() });
  try {
    await refreshFinishIssue(ctx, companyId, { allowCreate: false }, clock);
  } catch (error) {
    ctx.logger.info("Finish setup refresh failed", { companyId, error: message(error) });
  }
  return status;
}

// ---------------------------------------------------------------------------
// Installed plugins (instance-wide, reported by the Setup page)
// ---------------------------------------------------------------------------

export function parseInstalled(value: unknown): Record<string, InstalledPlugin> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, InstalledPlugin> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || !entry.id) continue;
    out[key] = { id: entry.id, status: typeof entry.status === "string" ? entry.status : null };
  }
  return out;
}

export async function rememberInstalled(ctx: PluginContext, installed: unknown): Promise<void> {
  const parsed = parseInstalled(installed);
  if (!parsed) return;
  try {
    await ctx.state.set(INSTALLED_STATE, parsed);
  } catch (error) {
    ctx.logger.info("Could not store installed plugins", { error: message(error) });
  }
}

export async function readInstalled(ctx: PluginContext): Promise<Record<string, InstalledPlugin> | null> {
  try {
    return parseInstalled(await ctx.state.get(INSTALLED_STATE));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Finish setup issue
// ---------------------------------------------------------------------------

export type RefreshResult =
  | { action: "skipped"; reason: string; summary?: SetupSummary }
  | { action: "created" | "updated" | "unchanged" | "closed" | "none"; issueId: string | null; missing: number; summary: SetupSummary };

const CLOSED = new Set(["done", "cancelled"]);

/** Tell the Cockpit the company's setup count (events can be lost: the hourly job sends it again). */
export async function emitSummary(ctx: PluginContext, companyId: string, summary: SetupSummary, finishIssueId: string | null, clock: Clock = systemClock): Promise<void> {
  const payload: SummaryPayload = { companyId, ...summary, finishIssueId, updatedAt: clock.now().toISOString() };
  try {
    await ctx.events.emit(SUMMARY_EVENT, companyId, payload as unknown as Record<string, unknown>);
  } catch (error) {
    ctx.logger.info("Setup summary emit failed", { companyId, error: message(error) });
  }
}

/** The company's setup count from what is stored now (the same count the issue, the sidebar and the Cockpit show). */
export async function storedSummary(ctx: PluginContext, companyId: string): Promise<SetupSummary | null> {
  const { choice, modules } = await moduleView(ctx, companyId);
  if (!choice) return null;
  const statuses = Object.fromEntries((await listStatuses(ctx, companyId)).map((row) => [row.pluginKey, row.status]));
  return finishSetupSummary({ modules, statuses, installed: await readInstalled(ctx) });
}

export function fingerprint(title: string, description: string): string {
  return createHash("sha256").update(`${title}\n${description}`).digest("hex").slice(0, 32);
}

async function companyPrefix(ctx: PluginContext, companyId: string): Promise<string | null> {
  try {
    return (await ctx.companies.get(companyId))?.issuePrefix ?? null;
  } catch {
    return null;
  }
}

async function weeklyIssueOn(ctx: PluginContext, companyId: string): Promise<boolean> {
  try {
    const config = await readConfig(ctx, companyId);
    return config.weeklyIssue !== false;
  } catch {
    return true;
  }
}

/**
 * One open "Finish setup" issue per company with a saved module choice.
 * Updates it while open, closes it when nothing required is missing, and
 * opens a new one only when `allowCreate` (weekly job, module changes).
 */
export async function refreshFinishIssue(
  ctx: PluginContext,
  companyId: string,
  options: { allowCreate: boolean },
  clock: Clock = systemClock,
): Promise<RefreshResult> {
  const { choice, modules } = await moduleView(ctx, companyId, clock);
  if (!choice) return { action: "skipped", reason: "no module choice saved" };
  const result = await refreshIssue(ctx, companyId, { ...choice, modules }, options, clock);
  // The Cockpit lists the same count (and the issue once) on Waiting on you and in the daily brief.
  await emitSummary(ctx, companyId, result.summary!, "issueId" in result && result.action !== "closed" ? result.issueId : null, clock);
  return result;
}

async function refreshIssue(
  ctx: PluginContext,
  companyId: string,
  choice: { modules: Partial<Record<string, boolean>>; updatedBy: string | null },
  options: { allowCreate: boolean },
  clock: Clock,
): Promise<RefreshResult> {
  const statuses = Object.fromEntries((await listStatuses(ctx, companyId)).map((row) => [row.pluginKey, row.status]));
  const prefix = await companyPrefix(ctx, companyId);
  // The New company bootstrap's one list of grants only a person can give rides on the issue.
  const run = await getRun(ctx, companyId).catch(() => null);
  // The list is a snapshot of the last owner-list step: what a plugin now reports done is left out.
  const grants = run ? currentGrants(run.grants, statuses) : [];
  const input = {
    modules: choice.modules,
    statuses,
    installed: await readInstalled(ctx),
    prefix,
    extra: grants.length ? grantsMarkdown(grants, prefix) : null,
  };
  const summary = finishSetupSummary(input);
  const content = finishSetupContent(input);
  const existing = await getFinishIssue(ctx, companyId);
  const issue = existing ? await ctx.issues.get(existing.issueId, companyId).catch(() => null) : null;
  const open = issue && !CLOSED.has(String(issue.status)) ? issue : null;
  const now = clock.now().toISOString();

  if (!content) {
    if (open) {
      await ctx.issues.update(open.id, { status: "done", description: `${open.description ?? ""}\n\nEverything required is set up. Closed by the Setup plugin.`.trim() }, companyId);
      await clearFinishIssue(ctx, companyId);
      return { action: "closed", issueId: open.id, missing: 0, summary };
    }
    if (existing) await clearFinishIssue(ctx, companyId);
    return { action: "none", issueId: null, missing: 0, summary };
  }

  const print = fingerprint(content.title, content.description);
  if (open) {
    if (existing?.fingerprint === print) return { action: "unchanged", issueId: open.id, missing: content.missing.length, summary };
    await ctx.issues.update(open.id, { title: content.title, description: content.description }, companyId);
    await saveFinishIssue(ctx, { companyId, issueId: open.id, fingerprint: print, missingCount: content.missing.length }, now);
    return { action: "updated", issueId: open.id, missing: content.missing.length, summary };
  }
  if (!options.allowCreate) return { action: "none", issueId: null, missing: content.missing.length, summary };
  if (!(await weeklyIssueOn(ctx, companyId))) return { action: "skipped", reason: "weekly issue switched off", summary };
  // A new company already has the owner's "Set up <company>" issue (opened at company.created): reuse it, so the owner has one issue, not two.
  const adopted = await adoptSetupIssue(ctx, companyId);
  if (adopted) {
    await ctx.issues.update(adopted, { title: content.title, description: content.description }, companyId);
    await saveFinishIssue(ctx, { companyId, issueId: adopted, fingerprint: print, missingCount: content.missing.length }, now);
    return { action: "updated", issueId: adopted, missing: content.missing.length, summary };
  }
  const created = await createWorkIssue(ctx, {
    companyId,
    title: content.title,
    description: content.description,
    originKind: `plugin:${PLUGIN_ID}`,
    originId: `finish-setup:${companyId}`,
    ...(choice.updatedBy ? { assigneeUserId: choice.updatedBy } : {}),
  });
  await saveFinishIssue(ctx, { companyId, issueId: created.id, fingerprint: print, missingCount: content.missing.length }, now);
  return { action: "created", issueId: created.id, missing: content.missing.length, summary };
}

/** The open "Set up <company>" issue the kit opened at company.created (originId `company-setup`), or null. */
export async function adoptSetupIssue(ctx: PluginContext, companyId: string): Promise<string | null> {
  try {
    const found = (await ctx.issues.list({ companyId, originKind: `plugin:${PLUGIN_ID}` as never, originId: "company-setup", limit: 3 })) as Array<{ id: string; status?: string }>;
    return found.find((issue) => !CLOSED.has(String(issue.status)))?.id ?? null;
  } catch {
    return null;
  }
}

/** Weekly job: every company with a saved module choice and saved Setup settings. */
export async function weeklyFinishSetup(ctx: PluginContext, clock: Clock = systemClock): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const choice of await listChoices(ctx)) {
    let key: string;
    if (!(await configSaved(ctx, choice.companyId))) {
      key = "skipped";
    } else {
      try {
        const result = await refreshFinishIssue(ctx, choice.companyId, { allowCreate: true }, clock);
        key = result.action;
      } catch (error) {
        key = "failed";
        ctx.logger.info("Finish setup issue failed", { companyId: choice.companyId, error: message(error) });
      }
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Page data
// ---------------------------------------------------------------------------

export async function loadSetup(ctx: PluginContext, companyId: string, params: Record<string, unknown> = {}) {
  if (params.installed) await rememberInstalled(ctx, params.installed);
  const [view, statuses, issue, saved, installed, run, drive] = await Promise.all([
    moduleView(ctx, companyId),
    listStatuses(ctx, companyId),
    getFinishIssue(ctx, companyId),
    configSaved(ctx, companyId),
    readInstalled(ctx),
    getRun(ctx, companyId).catch(() => null),
    readDriveBinding(ctx, companyId),
  ]);
  const choice = view.choice;
  return {
    modules: choice?.modules ?? null,
    // What the company may use (the page shows the rest locked) and its plan label.
    entitled: view.entitled,
    plan: view.plan,
    updatedAt: choice?.updatedAt ?? null,
    updatedBy: choice?.updatedBy ?? null,
    statuses: Object.fromEntries(statuses.map((row) => [row.pluginKey, { status: row.status, receivedAt: row.receivedAt }])),
    finishIssueId: issue?.issueId ?? null,
    settingsSaved: saved,
    installed,
    drive: drive ?? null,
    // Where the New company bootstrap stands (null: the plugin never saw this company, or it predates the bootstrap).
    bootstrap: run ? { status: run.status, updatedAt: run.updatedAt } : null,
    // The one setup count (kit setupSummary): the sidebar badge and the Cockpit show it as it is.
    summary: choice
      ? finishSetupSummary({ modules: view.modules, statuses: Object.fromEntries(statuses.map((row) => [row.pluginKey, row.status])), installed })
      : null,
  };
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Entitlements (what the company bought)
// ---------------------------------------------------------------------------

const BACKFILL_STATE = { scopeKind: "instance" as const, namespace: "setup", stateKey: "entitlements-backfilled" };

export interface ModuleView {
  choice: Awaited<ReturnType<typeof getChoice>>;
  /** What the company may use now. */
  entitled: Record<ModuleKey, boolean>;
  plan: string | null;
  /** Saved choice AND entitlement. */
  modules: ModuleChoice;
  /** False until the one-time backfill has run: nothing is locked yet. */
  ready: boolean;
  /** The newest change to either (null: nothing stored). */
  updatedAt: string | null;
}

/**
 * The company's switches as everything else must read them. Until the one-time backfill has run
 * (it entitles every company that existed before entitlements to everything), nobody is locked
 * out: a failed backfill must never switch a module off for PAR or PARA.
 */
export async function moduleView(ctx: PluginContext, companyId: string, clock: Clock = systemClock): Promise<ModuleView> {
  const [choice, rows, ready] = await Promise.all([getChoice(ctx, companyId), getEntitlements(ctx, companyId), entitlementsReady(ctx)]);
  const entitled = ready ? entitledModules(rows, clock.now()) : (Object.fromEntries(MODULE_KEYS.map((key) => [key, true])) as Record<ModuleKey, boolean>);
  const stamps = [choice?.updatedAt, ...rows.map((row) => row.updatedAt)].filter((stamp): stamp is string => !!stamp).sort();
  return {
    choice,
    entitled,
    plan: rows.find((row) => row.plan)?.plan ?? null,
    ready,
    modules: effectiveModules(choice?.modules ?? null, entitled),
    updatedAt: stamps.length ? stamps[stamps.length - 1]! : null,
  };
}

export async function entitlementsReady(ctx: PluginContext): Promise<boolean> {
  return (await ctx.state.get(BACKFILL_STATE)) != null;
}

/**
 * Plan 1.4: the first start after the migration entitles every existing company to every module
 * (plan `pib`), so nothing changes for PAR or PARA. Runs once (a marker in plugin state); it never
 * overwrites a row someone set, and a company created later gets none. Throws on failure: the
 * caller logs it and the hourly job retries.
 */
export async function backfillEntitlements(ctx: PluginContext, clock: Clock = systemClock): Promise<{ companies: number; alreadyDone: boolean }> {
  if (await entitlementsReady(ctx)) return { companies: 0, alreadyDone: true };
  const have = await companiesWithEntitlements(ctx);
  const at = clock.now().toISOString();
  let companies = 0;
  for (const company of await listAllCompanies(ctx)) {
    if (have.has(company.id)) continue;
    for (const module of MODULE_KEYS) {
      await insertEntitlementIfMissing(ctx, { companyId: company.id, module, state: "entitled", plan: "pib", until: null, updatedBy: "backfill", updatedAt: at });
    }
    companies += 1;
  }
  await ctx.state.set(BACKFILL_STATE, { at, companies });
  return { companies, alreadyDone: false };
}

/**
 * Sets what a company bought: a plan label (its modules entitled, the others off) and/or a state
 * per module (`entitled`, `trial` with an end time, `off`). Cockpit is always entitled. The caller
 * has already been checked as an operator-company owner or admin.
 */
export async function setEntitlements(
  ctx: PluginContext,
  input: { companyId: string; plan?: unknown; modules?: unknown; until?: unknown; userId: string },
  clock: Clock = systemClock,
): Promise<{ plan: string | null; entitled: Record<ModuleKey, boolean>; modules: ModuleChoice; updatedAt: string }> {
  if (!(await ctx.companies.get(input.companyId))) throw new SetupError("Unknown company");
  const hasPlan = input.plan !== undefined && input.plan !== null;
  const hasModules = input.modules !== undefined && input.modules !== null;
  if (!hasPlan && !hasModules) throw new SetupError("Give a plan, a module → state map, or both");
  if (hasPlan && !isPlan(input.plan)) throw new SetupError("plan must be starter, growth, business or pib");
  if (hasModules && (typeof input.modules !== "object" || Array.isArray(input.modules))) throw new SetupError("modules must be an object of module → entitled, trial or off");
  const until = input.until == null ? null : typeof input.until === "string" && !Number.isNaN(Date.parse(input.until)) ? new Date(input.until).toISOString() : (() => { throw new SetupError("until must be an ISO date"); })();

  const existing = await getEntitlements(ctx, input.companyId);
  const states = new Map<ModuleKey, { state: EntitlementState; until: string | null }>(existing.map((row) => [row.module, { state: row.state, until: row.until }]));
  const plan = hasPlan ? (input.plan as string) : (existing.find((row) => row.plan)?.plan ?? null);
  if (hasPlan) {
    const included = new Set(planModules(input.plan as never));
    for (const key of MODULE_KEYS) states.set(key, { state: included.has(key) ? "entitled" : "off", until: null });
  }
  if (hasModules) {
    for (const [key, value] of Object.entries(input.modules as Record<string, unknown>)) {
      if (!(MODULE_KEYS as readonly string[]).includes(key)) throw new SetupError(`Unknown module ${key}`);
      if (typeof value !== "string" || !(ENTITLEMENT_STATES as readonly string[]).includes(value)) throw new SetupError(`modules.${key} must be entitled, trial or off`);
      if (value === "off" && key === "cockpit") throw new SetupError("Cockpit is always entitled");
      if (value === "trial" && !until) throw new SetupError("A trial needs an until date");
      states.set(key as ModuleKey, { state: value as EntitlementState, until: value === "trial" ? until : null });
    }
  }
  const updatedAt = clock.now().toISOString();
  for (const key of MODULE_KEYS) {
    const next = states.get(key) ?? { state: "off" as const, until: null };
    const row: EntitlementRow = { companyId: input.companyId, module: key, state: next.state, plan, until: next.until, updatedBy: input.userId, updatedAt };
    await saveEntitlement(ctx, row);
  }
  const view = await moduleView(ctx, input.companyId, clock);
  try {
    await emitModules(ctx, input.companyId, view.modules, updatedAt);
  } catch (error) {
    // The hourly re-emit catches up.
    ctx.logger.info("Module switch emit failed", { companyId: input.companyId, error: message(error) });
  }
  try {
    await refreshFinishIssue(ctx, input.companyId, { allowCreate: false }, clock);
  } catch (error) {
    ctx.logger.info("Finish setup refresh failed", { companyId: input.companyId, error: message(error) });
  }
  // `entitled` is what the stored rows grant; `modules` is what is switched on now (nothing is locked before the backfill has run).
  return { plan, entitled: entitledModules(await getEntitlements(ctx, input.companyId), clock.now()), modules: view.modules, updatedAt };
}
