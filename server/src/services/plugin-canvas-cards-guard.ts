import type { PluginPerformActionActorContext } from "@paperclipai/plugin-sdk";
import {
  CANVAS_CARDS_ACTION_PREFIX,
  CANVAS_CARDS_PARAMS_SCHEMAS,
  CANVAS_CARDS_PERSON_ONLY_CODE,
  CANVAS_CARDS_RESOLVE_ACTION,
  CANVAS_CARDS_SEARCH_ACTION,
  isCanvasCardsActionKey,
  type CanvasCardsResolveParams,
  type PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";

/**
 * The core guard on the fixed `canvas.cards.*` action keys (plan PAR-14389
 * C.1, steps 1 to 6). Both plugin action routes call it after the core plugin
 * gate and after the actor context is built, so a failed restriction read has
 * already answered 503 (step 5). Card data is for people only, and a
 * restricted person gets hidden and empty answers from core itself: a plugin
 * that answers these keys is never asked on their behalf.
 */

export type CanvasCardsGuardOutcome =
  /** Not a card key, or a card call the worker may answer (step 6). */
  | { kind: "worker" }
  /** Core answers itself; the worker is not called (step 4). */
  | { kind: "answer"; data: unknown };

export function pluginDeclaresEntityCard(manifest: Pick<PaperclipPluginManifestV1, "ui"> | null | undefined): boolean {
  return manifest?.ui?.slots?.some((slot) => slot.type === "canvasNode" && Boolean(slot.entityCard)) ?? false;
}

export function canvasCardsGuard(input: {
  key: string;
  manifest: Pick<PaperclipPluginManifestV1, "ui"> | null | undefined;
  actorContext: Pick<PluginPerformActionActorContext, "type" | "onBehalfOfRestricted">;
  params: unknown;
}): CanvasCardsGuardOutcome {
  const { key } = input;
  if (!key.startsWith(CANVAS_CARDS_ACTION_PREFIX)) return { kind: "worker" };
  // 1. The prefix is reserved: an unknown key, or a plugin with no card slot, is not found.
  if (!isCanvasCardsActionKey(key) || !pluginDeclaresEntityCard(input.manifest)) {
    throw notFound("Canvas card action not found");
  }
  // 2. People only. The local board is a user with no person and passes.
  if (input.actorContext.type !== "user") {
    throw forbidden("Canvas cards are answered for people only; agents use the plugin's tools",
      { code: CANVAS_CARDS_PERSON_ONLY_CODE });
  }
  // 3. Params, caps included.
  const parsed = CANVAS_CARDS_PARAMS_SCHEMAS[key].safeParse(input.params ?? {});
  if (!parsed.success) {
    throw badRequest(`Invalid params for ${key}`, { issues: parsed.error.issues });
  }
  // 4. A restricted person under `enforce`: hidden and empty, from core.
  if (input.actorContext.onBehalfOfRestricted === true) {
    if (key === CANVAS_CARDS_RESOLVE_ACTION) {
      const { items } = parsed.data as CanvasCardsResolveParams;
      return { kind: "answer", data: { cards: items.map(({ type, id }) => ({ type, id, hidden: true })) } };
    }
    if (key === CANVAS_CARDS_SEARCH_ACTION) return { kind: "answer", data: { cards: [] } };
    return { kind: "answer", data: { groups: [] } };
  }
  return { kind: "worker" };
}
