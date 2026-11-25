/**
 * Sends the company's whole access state to the guarded plugins (PAR-12578 plan, 4.2).
 *
 * `access.updated { companyId, rev, mode, userIds, part, parts, grants }` always
 * carries the whole state, never a delta, so a re-send also removes cleared
 * grants. When the payload text would pass 150,000 bytes, `grants` is split over
 * several events of the same `rev`; `userIds` is complete in every part.
 *
 * Order that keeps a `rev` honest: a grant change writes the grant first and
 * raises `rev` after (see access-grants.ts), and the payload reads `rev` first
 * and the grants after. So a payload labelled with the new `rev` always holds
 * the new grant; one built in between carries the old `rev`, which a plugin that
 * already has it drops.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ACCESS_EVENTS, loadGrant, type AccessGrant, type AccessMode } from "@partnersinbiz/pib-plugin-kit";
import { getAccessSettings } from "./access-store.js";

export const ACCESS_PART_MAX_BYTES = 150_000;
/** The kit receiver drops a send of more parts than this. */
export const ACCESS_MAX_PARTS = 64;

export interface AccessUpdatedPayload {
  companyId: string;
  rev: number;
  mode: AccessMode;
  userIds: string[];
  part: number;
  parts: number;
  grants: Record<string, AccessGrant>;
}

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/**
 * Splits one company state into parts of at most `maxBytes` of JSON text each.
 * `userIds` lists the people with a grant, in the given order. A single grant
 * larger than a part on its own still goes, alone in its part.
 */
export function splitAccessPayload(
  state: { companyId: string; rev: number; mode: AccessMode },
  grants: Record<string, AccessGrant>,
  maxBytes = ACCESS_PART_MAX_BYTES,
): AccessUpdatedPayload[] {
  const userIds = Object.keys(grants);
  const whole: AccessUpdatedPayload = { ...state, userIds, part: 1, parts: 1, grants };
  if (bytes(whole) <= maxBytes) return [whole];

  // Room left in a part after everything but the grants (part numbers sized generously).
  const room = maxBytes - bytes({ ...state, userIds, part: 99_999, parts: 99_999, grants: {} });
  const chunks: Array<Record<string, AccessGrant>> = [];
  let chunk: Record<string, AccessGrant> = {};
  let used = 0;
  for (const userId of userIds) {
    // `"id":{...}` plus the comma before it.
    const size = bytes(userId) + 1 + bytes(grants[userId]) + 1;
    if (used > 0 && used + size > room) {
      chunks.push(chunk);
      chunk = {};
      used = 0;
    }
    chunk[userId] = grants[userId]!;
    used += size;
  }
  chunks.push(chunk);
  return chunks.map((part, index) => ({ ...state, userIds, part: index + 1, parts: chunks.length, grants: part }));
}

/**
 * Builds the company's payloads from Setup's tables: the settings row first, then
 * one `loadGrant` per listed person. An id with no grant is skipped. A grant read
 * that throws stops the build: a missing grant must never be sent as "no access".
 */
export async function buildAccessPayloads(ctx: PluginContext, companyId: string): Promise<AccessUpdatedPayload[]> {
  const settings = await getAccessSettings(ctx, companyId);
  const grants: Record<string, AccessGrant> = {};
  for (const userId of settings?.grantedUserIds ?? []) {
    const grant = await loadGrant(ctx, companyId, userId);
    if (grant) grants[userId] = grant;
  }
  return splitAccessPayload({ companyId, rev: settings?.rev ?? 0, mode: settings?.mode ?? "off" }, grants);
}

/** Emits every part of the company's current state. Throws when the state cannot be read or a part cannot be sent. */
export async function publishAccess(ctx: PluginContext, companyId: string): Promise<{ rev: number; parts: number }> {
  const payloads = await buildAccessPayloads(ctx, companyId);
  const { rev, parts } = payloads[0]!;
  if (parts > ACCESS_MAX_PARTS) throw new Error(`Access state of ${parts} parts is more than the ${ACCESS_MAX_PARTS} a plugin accepts`);
  for (const payload of payloads) {
    await ctx.events.emit(ACCESS_EVENTS.updated, companyId, payload as unknown as Record<string, unknown>);
  }
  return { rev, parts };
}
