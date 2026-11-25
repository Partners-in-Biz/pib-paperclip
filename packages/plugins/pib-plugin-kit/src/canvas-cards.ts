/**
 * Entity cards on a planning canvas (PAR-14389 plan, C.1 "Kit").
 *
 * `registerCanvasCards({ register, kinds })` registers the three fixed actions
 * (`canvas.cards.resolve`, `.search`, `.related`). `register` is `guard.action`
 * in a guarded plugin and `ctx.actions.register` itself in an unguarded one,
 * never a local wrapper. A plugin supplies only `resolve`, `search` and
 * `related` per kind; the helper owns the rest:
 *
 * - Core's person rules again, as a second layer (core answers first; with
 *   core's guard reverted these still hold): a caller that is not a person
 *   (`context.actor.type !== "user"`) gets a `CANVAS_CARDS_PERSON_ONLY`
 *   refusal; a restricted person gets hidden and empty answers without a kind
 *   being asked; a missing restriction answer returns (does not throw) a
 *   `MEMBER_RESTRICTION_UNAVAILABLE` refusal.
 * - Params through the shared schemas (caps included).
 * - One answer for "no": `resolve` answers every item, in order; an item no
 *   kind returned, of an unknown kind, or whose card fails the rules is
 *   `{ type, id, hidden: true }`. `search` and `related` drop such cards.
 * - Caps: title and subtitle 200, status and meta label/value 80, at most 4
 *   meta rows; longer text is cut, not refused.
 * - `href`: a relative path starting with exactly one `/`, else the card is
 *   refused (hidden or dropped).
 *
 * A kind's own fault (a thrown error) is rethrown: the board shows "Couldn't
 * load" with retry, never "No access".
 */
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import {
  CANVAS_CARDS_LIMITS,
  CANVAS_CARDS_PERSON_ONLY_CODE,
  CANVAS_CARDS_RELATED_ACTION,
  CANVAS_CARDS_RESOLVE_ACTION,
  CANVAS_CARDS_SEARCH_ACTION,
  canvasCardSummarySchema,
  canvasCardsRelatedParamsSchema,
  canvasCardsResolveParamsSchema,
  canvasCardsSearchParamsSchema,
  type CanvasCardHidden,
  type CanvasCardSummary,
  type CanvasCardsRelatedParams,
  type CanvasCardsRelatedResult,
  type CanvasCardsResolveResult,
  type CanvasCardsSearchResult,
} from "@paperclipai/shared/canvas-cards";
import { MEMBER_RESTRICTION_UNAVAILABLE, actingRestriction } from "./access/acting-person.js";
import type { AccessCheck } from "./access/guard.js";
import { refusalOf, type ActionRefusal } from "./access/refusal.js";

export {
  CANVAS_CARDS_ACTION_KEYS,
  CANVAS_CARDS_PERSON_ONLY_CODE,
  CANVAS_CARDS_RELATED_ACTION,
  CANVAS_CARDS_RESOLVE_ACTION,
  CANVAS_CARDS_SEARCH_ACTION,
} from "@paperclipai/shared/canvas-cards";
export type { CanvasCardHidden, CanvasCardSummary, CanvasCardsRelatedResult, CanvasCardsResolveResult, CanvasCardsSearchResult };

/** Refusal code for params that fail the shared schema (core answers 400 first). */
export const CANVAS_CARDS_INVALID_PARAMS = "CANVAS_CARDS_INVALID_PARAMS";

const L = CANVAS_CARDS_LIMITS;

/** What a kind hands back for one record; the helper sets `type`, caps the text and checks `href`. */
export interface CanvasCardInput {
  id: string;
  title: string;
  subtitle?: string | null;
  status?: string | null;
  meta?: ReadonlyArray<{ label: string; value: string }> | null;
  href: string;
}

/** The call a kind answers for: the company and person are already checked by the helper. */
export interface CanvasCardCall {
  companyId: string;
  context: PluginPerformActionContext;
  /** The guard's check in a guarded plugin (its `decision` scope); undefined when registered directly. */
  check: AccessCheck | undefined;
}

export interface CanvasCardRelatedGroup {
  relation: string;
  label: string;
  cards: CanvasCardInput[];
  /** True when the plugin holds more records of this group than it returned. The helper sets it when it cuts to `limit`. */
  more?: boolean;
}

export interface CanvasCardKind {
  /** Slot id, e.g. `card-company`; the `type` of every card of this kind. */
  type: string;
  /** The cards the caller may see among `ids` (company and per-record rule checked). Any order; one left out is hidden. */
  resolve(ids: string[], call: CanvasCardCall): Promise<CanvasCardInput[]>;
  /** Records the caller may see matching `q`, at most `limit`. `false`: this kind has no search (Mailbox). */
  search: false | ((input: { q: string; limit: number }, call: CanvasCardCall) => Promise<CanvasCardInput[]>);
  /** Groups of this kind's records related to `of` (often a record of another plugin); `[]` for an `of` it does not know. */
  related: false | ((input: { of: CanvasCardsRelatedParams["of"]; limit: number }, call: CanvasCardCall) => Promise<CanvasCardRelatedGroup[]>);
}

export type CanvasCardsHandler = (params: Record<string, unknown>, context: PluginPerformActionContext, check?: AccessCheck) => Promise<unknown>;

export interface RegisterCanvasCardsOptions {
  /** `guard.action` (guarded plugins) or `ctx.actions.register` (unguarded ones). */
  register: (key: string, handler: CanvasCardsHandler) => void;
  kinds: readonly CanvasCardKind[];
}

/** A relative app path with exactly one leading slash: the shared schema's rule. */
export function isCanvasCardHref(href: unknown): href is string {
  return canvasCardSummarySchema.shape.href.safeParse(href).success;
}

/** Cuts text to `max` UTF-16 units with an ellipsis, never splitting a surrogate pair. */
export function capCardText(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = value.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v ? capCardText(v, max) : undefined);

/** A kind's card in the summary form, capped; `null` when it breaks a rule (bad `href`, id or title). */
export function canvasCardSummary(type: string, input: CanvasCardInput): CanvasCardSummary | null {
  if (!input || typeof input !== "object" || typeof input.title !== "string") return null;
  const card: CanvasCardSummary = { type, id: input.id, title: capCardText(input.title, L.titleMax), href: input.href };
  const subtitle = text(input.subtitle, L.subtitleMax);
  if (subtitle) card.subtitle = subtitle;
  const status = text(input.status, L.statusMax);
  if (status) card.status = status;
  const meta = (Array.isArray(input.meta) ? input.meta : [])
    .filter((m) => m && typeof m.label === "string" && typeof m.value === "string")
    .slice(0, L.metaMax)
    .map((m) => ({ label: capCardText(m.label, L.metaLabelMax), value: capCardText(m.value, L.metaValueMax) }));
  if (meta.length) card.meta = meta;
  return canvasCardSummarySchema.safeParse(card).success ? card : null;
}

const hidden = (type: string, id: string): CanvasCardHidden => ({ type, id, hidden: true });
const summaries = (type: string, inputs: CanvasCardInput[] | null | undefined, limit: number) =>
  (Array.isArray(inputs) ? inputs : []).map((c) => canvasCardSummary(type, c)).filter((c): c is CanvasCardSummary => c !== null).slice(0, limit);

type Gate = { refused: ActionRefusal } | { empty: true } | { call: CanvasCardCall };

/** The second layer of core's person rules, then the company. */
function gate(context: PluginPerformActionContext | undefined, check: AccessCheck | undefined): Gate {
  if (context?.actor?.type !== "user") {
    return { refused: refusalOf({ code: CANVAS_CARDS_PERSON_ONLY_CODE, message: "Canvas cards are answered for people only; agents use the plugin's tools" }) };
  }
  const restriction = actingRestriction(context.actor);
  if (restriction === "unavailable") {
    return { refused: refusalOf({ code: MEMBER_RESTRICTION_UNAVAILABLE, message: "Cannot verify your access right now; try again" }) };
  }
  const companyId = context.companyId ?? context.actor.companyId ?? null;
  // A restricted person, or a call with no company: nothing vouches for any id.
  if (restriction === "restricted" || !companyId) return { empty: true };
  return { call: { companyId, context, check } };
}

const invalid = (key: string) => refusalOf({ code: CANVAS_CARDS_INVALID_PARAMS, message: `Invalid params for ${key}` });

export function registerCanvasCards({ register, kinds }: RegisterCanvasCardsOptions): void {
  const byType = new Map<string, CanvasCardKind>();
  for (const kind of kinds) {
    if (byType.has(kind.type)) throw new Error(`registerCanvasCards: kind ${kind.type} is listed twice`);
    byType.set(kind.type, kind);
  }

  register(CANVAS_CARDS_RESOLVE_ACTION, async (params, context, check): Promise<CanvasCardsResolveResult | ActionRefusal> => {
    const g = gate(context, check);
    if ("refused" in g) return g.refused;
    const parsed = canvasCardsResolveParamsSchema.safeParse(params ?? {});
    if (!parsed.success) return invalid(CANVAS_CARDS_RESOLVE_ACTION);
    const { items } = parsed.data;
    if ("empty" in g) return { cards: items.map(({ type, id }) => hidden(type, id)) };
    const found = new Map<string, CanvasCardSummary>();
    for (const [type, kind] of byType) {
      const ids = [...new Set(items.filter((i) => i.type === type).map((i) => i.id))];
      if (!ids.length) continue;
      const wanted = new Set(ids);
      for (const card of summaries(type, await kind.resolve(ids, g.call), Number.MAX_SAFE_INTEGER)) {
        if (wanted.has(card.id) && !found.has(`${type}\n${card.id}`)) found.set(`${type}\n${card.id}`, card);
      }
    }
    return { cards: items.map(({ type, id }) => found.get(`${type}\n${id}`) ?? hidden(type, id)) };
  });

  if (kinds.some((k) => k.search !== false)) {
    register(CANVAS_CARDS_SEARCH_ACTION, async (params, context, check): Promise<CanvasCardsSearchResult | ActionRefusal> => {
      const g = gate(context, check);
      if ("refused" in g) return g.refused;
      const parsed = canvasCardsSearchParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalid(CANVAS_CARDS_SEARCH_ACTION);
      const kind = byType.get(parsed.data.type);
      if ("empty" in g || !kind || kind.search === false) return { cards: [] };
      const limit = parsed.data.limit ?? L.searchLimitMax;
      return { cards: summaries(kind.type, await kind.search({ q: parsed.data.q, limit }, g.call), limit) };
    });
  }

  if (kinds.some((k) => k.related !== false)) {
    register(CANVAS_CARDS_RELATED_ACTION, async (params, context, check): Promise<CanvasCardsRelatedResult | ActionRefusal> => {
      const g = gate(context, check);
      if ("refused" in g) return g.refused;
      const parsed = canvasCardsRelatedParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalid(CANVAS_CARDS_RELATED_ACTION);
      if ("empty" in g) return { groups: [] };
      const limit = parsed.data.limit ?? L.relatedLimitMax;
      const groups: CanvasCardsRelatedResult["groups"] = [];
      for (const kind of kinds) {
        if (kind.related === false) continue;
        for (const group of (await kind.related({ of: parsed.data.of, limit }, g.call)) ?? []) {
          if (!group || typeof group.relation !== "string" || !group.relation) continue;
          const all = summaries(kind.type, group.cards, Number.MAX_SAFE_INTEGER);
          groups.push({
            relation: capCardText(group.relation, L.relationMax),
            label: capCardText(typeof group.label === "string" ? group.label : "", L.labelMax),
            type: kind.type,
            cards: all.slice(0, limit),
            more: group.more === true || all.length > limit,
          });
        }
      }
      return { groups };
    });
  }
}
