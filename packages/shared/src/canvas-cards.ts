import { z } from "zod";

/**
 * Entity card contract (plan PAR-14389 C.1). A card is an `embed` node that
 * stores ids only; the plugin that owns the record answers three fixed
 * actions. Core (the action-route guard) and the plugin kit share these keys,
 * caps and schemas.
 */

export const CANVAS_CARDS_ACTION_PREFIX = "canvas.cards.";
export const CANVAS_CARDS_RESOLVE_ACTION = "canvas.cards.resolve";
export const CANVAS_CARDS_SEARCH_ACTION = "canvas.cards.search";
export const CANVAS_CARDS_RELATED_ACTION = "canvas.cards.related";
export const CANVAS_CARDS_ACTION_KEYS = [
  CANVAS_CARDS_RESOLVE_ACTION,
  CANVAS_CARDS_SEARCH_ACTION,
  CANVAS_CARDS_RELATED_ACTION,
] as const;
export type CanvasCardsActionKey = (typeof CANVAS_CARDS_ACTION_KEYS)[number];

/** Refusal code core answers when the caller is not a person (agent key, run token, system). */
export const CANVAS_CARDS_PERSON_ONLY_CODE = "CANVAS_CARDS_PERSON_ONLY";

export const CANVAS_CARDS_LIMITS = {
  resolveItemsMax: 100,
  searchLimitMax: 20,
  relatedLimitMax: 50,
  metaMax: 4,
  titleMax: 200,
  subtitleMax: 200,
  metaValueMax: 80,
  /** Not set by the plan; kept as short as a meta value. */
  metaLabelMax: 80,
  statusMax: 80,
  queryMax: 200,
  hrefMax: 2000,
  typeMax: 100,
  idMax: 200,
  pluginMax: 200,
  relationMax: 100,
  labelMax: 200,
} as const;

const L = CANVAS_CARDS_LIMITS;

export function isCanvasCardsActionKey(key: string): key is CanvasCardsActionKey {
  return (CANVAS_CARDS_ACTION_KEYS as readonly string[]).includes(key);
}

// Bounds follow `planningCanvasEmbedDataSchema` (type 100, assetId 200, plugin 200).
const cardTypeSchema = z.string().min(1).max(L.typeMax);
const cardIdSchema = z.string().min(1).max(L.idMax);

export const canvasCardsResolveParamsSchema = z.object({
  items: z.array(z.object({ type: cardTypeSchema, id: cardIdSchema })).max(L.resolveItemsMax),
});

export const canvasCardsSearchParamsSchema = z.object({
  type: cardTypeSchema,
  q: z.string().max(L.queryMax),
  limit: z.number().int().min(1).max(L.searchLimitMax).optional(),
});

export const canvasCardsRelatedParamsSchema = z.object({
  of: z.object({ plugin: z.string().min(1).max(L.pluginMax), type: cardTypeSchema, id: cardIdSchema }),
  limit: z.number().int().min(1).max(L.relatedLimitMax).optional(),
});

export const CANVAS_CARDS_PARAMS_SCHEMAS = {
  [CANVAS_CARDS_RESOLVE_ACTION]: canvasCardsResolveParamsSchema,
  [CANVAS_CARDS_SEARCH_ACTION]: canvasCardsSearchParamsSchema,
  [CANVAS_CARDS_RELATED_ACTION]: canvasCardsRelatedParamsSchema,
} as const;

export type CanvasCardsResolveParams = z.infer<typeof canvasCardsResolveParamsSchema>;
export type CanvasCardsSearchParams = z.infer<typeof canvasCardsSearchParamsSchema>;
export type CanvasCardsRelatedParams = z.infer<typeof canvasCardsRelatedParamsSchema>;

/** A relative app path with exactly one leading slash (no scheme, no `//host`). */
const cardHrefSchema = z.string().max(L.hrefMax).regex(/^\/(?![/\\])/, "href must be a relative path starting with one /");

export const canvasCardSummarySchema = z.object({
  type: cardTypeSchema,
  id: cardIdSchema,
  title: z.string().max(L.titleMax),
  subtitle: z.string().max(L.subtitleMax).optional(),
  status: z.string().max(L.statusMax).optional(),
  meta: z.array(z.object({ label: z.string().max(L.metaLabelMax), value: z.string().max(L.metaValueMax) })).max(L.metaMax).optional(),
  href: cardHrefSchema,
}).strict();

export const canvasCardHiddenSchema = z.object({ type: cardTypeSchema, id: cardIdSchema, hidden: z.literal(true) }).strict();

export const canvasCardsResolveResultSchema = z.object({
  cards: z.array(z.union([canvasCardHiddenSchema, canvasCardSummarySchema])).max(L.resolveItemsMax),
});

export const canvasCardsSearchResultSchema = z.object({
  cards: z.array(canvasCardSummarySchema).max(L.searchLimitMax),
});

export const canvasCardsRelatedResultSchema = z.object({
  groups: z.array(z.object({
    relation: z.string().min(1).max(L.relationMax),
    label: z.string().max(L.labelMax),
    type: cardTypeSchema,
    cards: z.array(canvasCardSummarySchema).max(L.relatedLimitMax),
    /** True when the plugin holds more records of this group than it returned. */
    more: z.boolean(),
  })),
});

export type CanvasCardSummary = z.infer<typeof canvasCardSummarySchema>;
export type CanvasCardHidden = z.infer<typeof canvasCardHiddenSchema>;
export type CanvasCardsResolveResult = z.infer<typeof canvasCardsResolveResultSchema>;
export type CanvasCardsSearchResult = z.infer<typeof canvasCardsSearchResultSchema>;
export type CanvasCardsRelatedResult = z.infer<typeof canvasCardsRelatedResultSchema>;
