/**
 * Worker-side setup logic. Every function takes `companyId` explicitly: jobs
 * have no company scope, and the host only lets a job act for a company whose
 * Setup settings were saved.
 */
import { createHash } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { configSaved, createWorkIssue, readConfig } from "@partnersinbiz/pib-plugin-kit";
import { SETUP_EVENTS, type ModulesPayload, type SetupStatus } from "./kit-setup.js";
import {
  clearFinishIssue,
  getChoice,
  getFinishIssue,
  listChoices,
  listStatuses,
  saveChoice,
  saveFinishIssue,
  upsertStatus,
} from "./db.js";
import { finishSetupContent, type InstalledPlugin } from "./finish-issue.js";
import { normalizeModules, type ModuleChoice } from "./modules.js";
import { PLUGIN_ID } from "./namespace.js";
import { parseSetupStatus } from "./status.js";

export interface Clock {
  now(): Date;
}

const systemClock: Clock = { now: () => new Date() };

const INSTALLED_STATE = { scopeKind: "instance" as const, namespace: "setup", stateKey: "installed-plugins" };

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
  const modules = normalizeModules(input.modules);
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
  for (const choice of await listChoices(ctx)) {
    if (!(await configSaved(ctx, choice.companyId))) {
      result.skipped += 1;
      continue;
    }
    try {
      await emitModules(ctx, choice.companyId, choice.modules, choice.updatedAt);
      result.emitted += 1;
    } catch (error) {
      result.failed += 1;
      ctx.logger.info("Module switch re-emit failed", { companyId: choice.companyId, error: message(error) });
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
  | { action: "skipped"; reason: string }
  | { action: "created" | "updated" | "unchanged" | "closed" | "none"; issueId: string | null; missing: number };

const CLOSED = new Set(["done", "cancelled"]);

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
  const choice = await getChoice(ctx, companyId);
  if (!choice) return { action: "skipped", reason: "no module choice saved" };
  const statuses = Object.fromEntries((await listStatuses(ctx, companyId)).map((row) => [row.pluginKey, row.status]));
  const content = finishSetupContent({
    modules: choice.modules,
    statuses,
    installed: await readInstalled(ctx),
    prefix: await companyPrefix(ctx, companyId),
  });
  const existing = await getFinishIssue(ctx, companyId);
  const issue = existing ? await ctx.issues.get(existing.issueId, companyId).catch(() => null) : null;
  const open = issue && !CLOSED.has(String(issue.status)) ? issue : null;
  const now = clock.now().toISOString();

  if (!content) {
    if (open) {
      await ctx.issues.update(open.id, { status: "done", description: `${open.description ?? ""}\n\nEverything required is set up. Closed by the Setup plugin.`.trim() }, companyId);
      await clearFinishIssue(ctx, companyId);
      return { action: "closed", issueId: open.id, missing: 0 };
    }
    if (existing) await clearFinishIssue(ctx, companyId);
    return { action: "none", issueId: null, missing: 0 };
  }

  const print = fingerprint(content.title, content.description);
  if (open) {
    if (existing?.fingerprint === print) return { action: "unchanged", issueId: open.id, missing: content.missing.length };
    await ctx.issues.update(open.id, { title: content.title, description: content.description }, companyId);
    await saveFinishIssue(ctx, { companyId, issueId: open.id, fingerprint: print, missingCount: content.missing.length }, now);
    return { action: "updated", issueId: open.id, missing: content.missing.length };
  }
  if (!options.allowCreate) return { action: "none", issueId: null, missing: content.missing.length };
  if (!(await weeklyIssueOn(ctx, companyId))) return { action: "skipped", reason: "weekly issue switched off" };
  const created = await createWorkIssue(ctx, {
    companyId,
    title: content.title,
    description: content.description,
    originKind: `plugin:${PLUGIN_ID}`,
    originId: `finish-setup:${companyId}`,
    ...(choice.updatedBy ? { assigneeUserId: choice.updatedBy } : {}),
  });
  await saveFinishIssue(ctx, { companyId, issueId: created.id, fingerprint: print, missingCount: content.missing.length }, now);
  return { action: "created", issueId: created.id, missing: content.missing.length };
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
  const [choice, statuses, issue, saved, installed] = await Promise.all([
    getChoice(ctx, companyId),
    listStatuses(ctx, companyId),
    getFinishIssue(ctx, companyId),
    configSaved(ctx, companyId),
    readInstalled(ctx),
  ]);
  return {
    modules: choice?.modules ?? null,
    updatedAt: choice?.updatedAt ?? null,
    updatedBy: choice?.updatedBy ?? null,
    statuses: Object.fromEntries(statuses.map((row) => [row.pluginKey, { status: row.status, receivedAt: row.receivedAt }])),
    finishIssueId: issue?.issueId ?? null,
    settingsSaved: saved,
    installed,
  };
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
