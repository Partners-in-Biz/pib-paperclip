/**
 * The library panel on a Planning Canvas board (PAR-14280, plan PAR-14257 B.2 D): Studio files that pass the board's
 * scope (board-scope.ts), to place as embed cards. `listAssets` filters on the exact client, so another client's file
 * and, on a client board, own work never reach the list. `generateOn` tells the panel whether to offer "Add generate
 * card" (Studio's `boards.generate` switch, PAR-14817).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MEMBER_RESTRICTED, type ActingRestriction } from "@partnersinbiz/pib-plugin-kit";
import { listAssets } from "./assets.js";
import { boardTarget, REMOVED_STATUSES, type BoardScope } from "./board-scope.js";
import { StudioError } from "./errors.js";
import { assertOpenToPerson } from "./scope.js";

const LIBRARY_KINDS = new Set(["image", "video"]);

/**
 * The board's library panel: only files of the board's own client (or own work), images and videos, newest first.
 * A restricted member gets an empty list for a client board (plan G.2) and own work on the others.
 */
export async function boardLibrary(ctx: PluginContext, companyId: string, board: BoardScope, restriction: ActingRestriction, filter: { kind?: unknown; limit?: unknown } = {}) {
  const target = await boardTarget(ctx, companyId, board);
  const label = target.client ? { kind: "client" as const, name: target.clientName } : { kind: "own" as const, name: null };
  try {
    assertOpenToPerson(target.client, restriction);
  } catch (error) {
    if (error instanceof StudioError && error.code === MEMBER_RESTRICTED) return { board: { kind: "client" as const, name: null }, assets: [], withheld: true, generateOn: false };
    throw error;
  }
  const kind = typeof filter.kind === "string" && LIBRARY_KINDS.has(filter.kind) ? filter.kind : null;
  const limit = typeof filter.limit === "number" && Number.isFinite(filter.limit) ? filter.limit : 60;
  const rows = await listAssets(ctx, companyId, { scope: target.client, kind, limit });
  const assets = rows
    .filter((a) => LIBRARY_KINDS.has(a.kind) && !REMOVED_STATUSES.has(a.status))
    .map((a) => ({ id: a.id, name: a.name, kind: a.kind, mime: a.mime, altText: a.altText, status: a.status, prompt: a.prompt, createdAt: a.createdAt }));
  return { board: label, assets, withheld: false, generateOn: await target.config.boardGenerationOn() };
}
