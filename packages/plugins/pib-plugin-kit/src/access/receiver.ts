/**
 * Receives Setup's `access.updated` in one guarded plugin (PAR-12578 plan, 4.2).
 *
 * 1. Collects the parts of one `rev` in memory; nothing is written until all are there.
 * 2. Reads the stored company row. A read that throws stops the receive: nothing
 *    deleted, written or confirmed. A `rev` not higher than the stored one is dropped.
 * 3. Writes each grant under `u:<userId>` (where `loadGrant` reads) and deletes the
 *    grants of people who were in the stored list and are not in the new one.
 * 4. Writes the company row `{ mode, rev, userIds, receivedAt }` last, so a receive
 *    that stops half-way keeps the old mode and `rev` and the next send repeats it.
 * 5. Runs the cache-clear listeners and emits `access.synced { companyId, rev, pluginKey }`.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { accessGrantScope, clean } from "../permissions.js";
import { SETUP_PLUGIN } from "../setup.js";
import {
  ACCESS_EVENTS,
  accessCompanyScope,
  isAccessMode,
  isAccessRev,
  parseAccessRow,
  type AccessCompanyRow,
  type AccessMode,
} from "./switch.js";

/** One event of Setup's send. `part` counts from 1; `userIds` is complete in every part. */
export interface AccessUpdatedPayload {
  companyId: string;
  rev: number;
  mode: AccessMode;
  userIds: string[];
  part: number;
  parts: number;
  grants: Record<string, unknown>;
}

export const MAX_ACCESS_PARTS = 64;

export type AccessReceivedListener = (companyId: string, row: AccessCompanyRow) => void;

const listeners = new WeakMap<PluginContext, Set<AccessReceivedListener>>();

/** Called after every applied receive, before the confirmation (the guard cache clears here). */
export function onAccessReceived(ctx: PluginContext, listener: AccessReceivedListener): () => void {
  let set = listeners.get(ctx);
  if (!set) listeners.set(ctx, (set = new Set()));
  set.add(listener);
  return () => void set.delete(listener);
}

interface Pending {
  rev: number;
  mode: AccessMode;
  userIds: string[];
  parts: number;
  grants: Map<number, Record<string, unknown>>;
}

/** Checks the shape. Returns null for anything that is not a complete, valid part. */
export function parseAccessUpdate(raw: unknown, eventCompanyId: string | undefined): AccessUpdatedPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Partial<AccessUpdatedPayload>;
  const companyId = typeof p.companyId === "string" && p.companyId ? p.companyId : eventCompanyId;
  // The host stamps the event's company; a payload naming another company is refused.
  if (!companyId || (eventCompanyId && companyId !== eventCompanyId)) return null;
  if (!isAccessRev(p.rev) || !isAccessMode(p.mode)) return null;
  const parts = p.parts ?? 1;
  const part = p.part ?? 1;
  if (!Number.isInteger(parts) || parts < 1 || parts > MAX_ACCESS_PARTS) return null;
  if (!Number.isInteger(part) || part < 1 || part > parts) return null;
  if (!Array.isArray(p.userIds) || !p.userIds.every((id) => typeof id === "string" && id.length > 0)) return null;
  const grants = p.grants ?? {};
  if (typeof grants !== "object" || Array.isArray(grants)) return null;
  return { companyId, rev: p.rev, mode: p.mode, userIds: [...new Set(p.userIds)], part, parts, grants };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The event Setup sends; every guarded plugin but Setup subscribes to it. */
export const ACCESS_UPDATED_EVENT = `plugin.${SETUP_PLUGIN}.${ACCESS_EVENTS.updated}` as const;

const receivers = new WeakMap<PluginContext, (event: PluginEvent) => Promise<void>>();

/**
 * Subscribes to Setup's `access.updated`. `createAccessGuard` calls it, so a
 * plugin with a guard needs no call of its own (PAR-15008). Once per ctx: a
 * second call returns the first handler and does not subscribe again.
 * Returns the event handler, for tests.
 */
export function registerAccessReceiver(ctx: PluginContext, pluginKey: string): (event: PluginEvent) => Promise<void> {
  const existing = receivers.get(ctx);
  if (existing) return existing;
  const pending = new Map<string, Pending>();
  // Receives of one company run one after another, so two sends never interleave writes.
  const queues = new Map<string, Promise<void>>();

  const confirm = async (companyId: string, rev: number) => {
    try {
      await ctx.events.emit(ACCESS_EVENTS.synced, companyId, { companyId, rev, pluginKey });
    } catch (error) {
      ctx.logger.info("Access confirmation failed", { companyId, rev, error: errorText(error) });
    }
  };

  const apply = async (companyId: string, update: Pending) => {
    let stored: ReturnType<typeof parseAccessRow>;
    try {
      stored = parseAccessRow(await ctx.state.get(accessCompanyScope(companyId)));
    } catch (error) {
      ctx.logger.info("Access receive stopped: stored row unreadable", { companyId, rev: update.rev, error: errorText(error) });
      return;
    }
    // An unreadable row has no old `userIds` to diff: grants of people only in it stay until a later send.
    const current = stored === null || stored === "invalid" ? null : stored;
    if (current && update.rev <= current.rev) {
      if (update.rev < current.rev) return;
      // Same rev again: no grant writes, but refresh `receivedAt` so the switch stops asking
      // (the row is written last, so a row at this rev means its grants are complete), and
      // confirm, so a lost confirmation is repaired.
      try {
        const row: AccessCompanyRow = { mode: current.mode, rev: current.rev, userIds: current.userIds, receivedAt: new Date().toISOString() };
        await ctx.state.set(accessCompanyScope(companyId), row);
      } catch (error) {
        ctx.logger.info("Access receive: row refresh failed", { companyId, rev: current.rev, error: errorText(error) });
      }
      await confirm(companyId, current.rev);
      return;
    }

    const grants: Record<string, unknown> = {};
    for (const part of update.grants.values()) Object.assign(grants, part);
    try {
      for (const userId of update.userIds) {
        const grant = clean(grants[userId], userId);
        // No readable grant for a listed person means no access: remove any old copy.
        if (grant) await ctx.state.set(accessGrantScope(companyId, userId), grant);
        else await ctx.state.delete(accessGrantScope(companyId, userId));
      }
      const keep = new Set(update.userIds);
      for (const userId of current?.userIds ?? []) {
        if (!keep.has(userId)) await ctx.state.delete(accessGrantScope(companyId, userId));
      }
      const row: AccessCompanyRow = { mode: update.mode, rev: update.rev, userIds: update.userIds, receivedAt: new Date().toISOString() };
      await ctx.state.set(accessCompanyScope(companyId), row);
      for (const listener of listeners.get(ctx) ?? []) {
        try {
          listener(companyId, row);
        } catch (error) {
          ctx.logger.info("Access receive listener failed", { companyId, error: errorText(error) });
        }
      }
    } catch (error) {
      ctx.logger.info("Access receive stopped: write failed", { companyId, rev: update.rev, error: errorText(error) });
      return;
    }
    await confirm(companyId, update.rev);
  };

  const handle = async (event: PluginEvent) => {
    const update = parseAccessUpdate(event.payload, event.companyId);
    if (!update) {
      ctx.logger.info("Access update ignored: not a valid payload", { companyId: event.companyId });
      return;
    }
    const { companyId } = update;
    let entry = pending.get(companyId);
    if (entry && update.rev < entry.rev) return;
    if (!entry || update.rev > entry.rev || update.parts !== entry.parts) {
      entry = { rev: update.rev, mode: update.mode, userIds: update.userIds, parts: update.parts, grants: new Map() };
      pending.set(companyId, entry);
    }
    entry.grants.set(update.part, update.grants);
    if (entry.grants.size < entry.parts) return;
    pending.delete(companyId);

    const ready = entry;
    const run = (queues.get(companyId) ?? Promise.resolve()).then(() => apply(companyId, ready));
    queues.set(companyId, run);
    try {
      await run;
    } finally {
      if (queues.get(companyId) === run) queues.delete(companyId);
    }
  };

  ctx.events.on(ACCESS_UPDATED_EVENT, handle);
  receivers.set(ctx, handle);
  return handle;
}
