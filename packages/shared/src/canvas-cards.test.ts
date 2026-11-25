import { describe, expect, it } from "vitest";
import {
  CANVAS_CARDS_ACTION_KEYS,
  CANVAS_CARDS_PARAMS_SCHEMAS,
  canvasCardSummarySchema,
  canvasCardsRelatedParamsSchema,
  canvasCardsResolveParamsSchema,
  canvasCardsResolveResultSchema,
  canvasCardsSearchParamsSchema,
  isCanvasCardsActionKey,
} from "./canvas-cards.js";

describe("canvas card action contract (PAR-14389 C.1)", () => {
  it("names exactly three fixed keys under the reserved prefix", () => {
    expect(CANVAS_CARDS_ACTION_KEYS).toEqual(["canvas.cards.resolve", "canvas.cards.search", "canvas.cards.related"]);
    expect(Object.keys(CANVAS_CARDS_PARAMS_SCHEMAS).sort()).toEqual([...CANVAS_CARDS_ACTION_KEYS].sort());
    expect(isCanvasCardsActionKey("canvas.cards.resolve")).toBe(true);
    expect(isCanvasCardsActionKey("canvas.cards.delete")).toBe(false);
  });

  it("caps resolve at 100 items", () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "card-company", id: `c${i}` }));
    expect(canvasCardsResolveParamsSchema.safeParse({ items: items(100) }).success).toBe(true);
    expect(canvasCardsResolveParamsSchema.safeParse({ items: items(101) }).success).toBe(false);
    expect(canvasCardsResolveParamsSchema.safeParse({ items: [{ type: "card-company", id: "" }] }).success).toBe(false);
  });

  it("caps search at limit 20 and related at limit 50", () => {
    expect(canvasCardsSearchParamsSchema.safeParse({ type: "card-company", q: "acme", limit: 20 }).success).toBe(true);
    expect(canvasCardsSearchParamsSchema.safeParse({ type: "card-company", q: "acme", limit: 21 }).success).toBe(false);
    expect(canvasCardsSearchParamsSchema.safeParse({ type: "card-company", q: "x".repeat(201) }).success).toBe(false);
    const of = { plugin: "partnersinbiz.crm", type: "card-company", id: "c1" };
    expect(canvasCardsRelatedParamsSchema.safeParse({ of, limit: 50 }).success).toBe(true);
    expect(canvasCardsRelatedParamsSchema.safeParse({ of, limit: 51 }).success).toBe(false);
    expect(canvasCardsRelatedParamsSchema.safeParse({ limit: 5 }).success).toBe(false);
  });

  it("summaries are text with capped lengths, at most four meta rows and a one-slash relative href", () => {
    const summary = { type: "card-company", id: "c1", title: "Acme", href: "/crm?client=company:c1" };
    expect(canvasCardSummarySchema.safeParse(summary).success).toBe(true);
    for (const href of ["//evil.test/x", "https://evil.test", "javascript:alert(1)", "crm", "/\\evil.test"]) {
      expect(canvasCardSummarySchema.safeParse({ ...summary, href }).success, href).toBe(false);
    }
    expect(canvasCardSummarySchema.safeParse({ ...summary, title: "x".repeat(201) }).success).toBe(false);
    expect(canvasCardSummarySchema.safeParse({ ...summary, subtitle: "x".repeat(201) }).success).toBe(false);
    const meta = (n: number, value = "v") => Array.from({ length: n }, () => ({ label: "l", value }));
    expect(canvasCardSummarySchema.safeParse({ ...summary, meta: meta(4) }).success).toBe(true);
    expect(canvasCardSummarySchema.safeParse({ ...summary, meta: meta(5) }).success).toBe(false);
    expect(canvasCardSummarySchema.safeParse({ ...summary, meta: meta(1, "x".repeat(81)) }).success).toBe(false);
    expect(canvasCardSummarySchema.safeParse({ ...summary, props: { a: 1 } }).success).toBe(false);
  });

  it("a resolve answer holds hidden cards or summaries only", () => {
    expect(canvasCardsResolveResultSchema.safeParse({ cards: [{ type: "card-company", id: "c1", hidden: true }] }).success).toBe(true);
    expect(canvasCardsResolveResultSchema.safeParse({ cards: [{ type: "card-company", id: "c1", hidden: true, title: "Acme" }] }).success)
      .toBe(false);
  });
});
