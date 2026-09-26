import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { SkillSyncResult } from "@partnersinbiz/pib-plugin-kit";

export interface SkillSyncer {
  ensure(companyId: string): Promise<SkillSyncResult[]>;
  force(companyId: string): Promise<SkillSyncResult[]>;
}

/** What every worker-side function needs. `now` is injectable for tests. */
export interface Env {
  ctx: PluginContext;
  skills: SkillSyncer;
  now: () => Date;
}

export class CockpitError extends Error {}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const INSTALLED_STATE = { scopeKind: "instance" as const, namespace: "cockpit", stateKey: "installed-plugins" };

export interface InstalledPlugin {
  id: string;
  status: string | null;
}

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

/** The page reports which plugins are installed (instance-wide); jobs use it for "not reporting". */
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
