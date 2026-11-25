/**
 * Setup's own access guard (spec PAR-12578 4.2 and 4.4; A4-Setup, PAR-12686).
 *
 * Every other plugin keeps a copy of Setup's company row, written by the kit
 * receiver. Setup is the source and runs no receiver, so its guard reads the
 * switch from its own table `access_settings` ("Setup's own guard reads its own
 * tables, so it never waits for an event"). The kit guard reads the switch
 * through `ctx.state`; the context given to it answers that one key from the
 * table and passes every other call through unchanged:
 *
 * - a settings row: `{ mode, rev, userIds }`, received now, so it is never stale
 *   and Setup never asks itself;
 * - no settings row: a row stored in Setup's own state (none in production, as
 *   nothing writes one; the kit's shared access check seeds them), else `off`
 *   at rev 0, which is what "nothing saved" means in the table;
 * - a table read that throws throws here, so the guard fails closed (`enforce`).
 *
 * Grants are already in Setup's own state under the kit's key (`saveGrant`), so
 * the guard reads them as in every plugin. `changed` drops the guard's cached
 * grants and roles for a company after Setup changed its access.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ACCESS_NAMESPACE, createAccessGuard, noteAccessReceived, type AccessCompanyRow, type AccessGuard } from "@partnersinbiz/pib-plugin-kit";
import { SETUP_ACCESS_TABLE } from "./access-table.js";
import { getAccessSettings } from "./access-store.js";
import { PLUGIN_ID } from "./namespace.js";

type StateKey = Parameters<PluginContext["state"]["get"]>[0];

const isCompanyRow = (key: StateKey): key is StateKey & { scopeId: string } =>
  key.scopeKind === "company" && key.namespace === ACCESS_NAMESPACE && key.stateKey === "company" && typeof key.scopeId === "string";

/** The company row the guard reads, from `access_settings`. Exported for tests. */
export async function ownAccessRow(ctx: PluginContext, key: StateKey & { scopeId: string }): Promise<AccessCompanyRow | unknown> {
  const settings = await getAccessSettings(ctx, key.scopeId);
  const receivedAt = new Date().toISOString();
  if (settings) return { mode: settings.mode, rev: settings.rev, userIds: settings.grantedUserIds, receivedAt };
  return (await ctx.state.get(key)) ?? { mode: "off", rev: 0, userIds: [], receivedAt };
}

/** The context the guard gets: `state.get` of the company row reads the table. */
export function ownSwitchContext(ctx: PluginContext): PluginContext {
  const get = (key: StateKey) => (isCompanyRow(key) ? ownAccessRow(ctx, key) : ctx.state.get(key));
  const state = new Proxy(ctx.state, { get: (target, prop) => (prop === "get" ? get : Reflect.get(target, prop)) });
  return new Proxy(ctx, { get: (target, prop) => (prop === "state" ? state : Reflect.get(target, prop)) });
}

export interface SetupGuard {
  guard: AccessGuard;
  /** After a grant or switch change: the guard reads the company's people again. */
  changed(companyId: string): void;
}

export function createSetupGuard(ctx: PluginContext): SetupGuard {
  const own = ownSwitchContext(ctx);
  const guard = createAccessGuard(own, { pluginKey: PLUGIN_ID, table: SETUP_ACCESS_TABLE });
  return { guard, changed: (companyId) => noteAccessReceived(own, companyId) };
}
