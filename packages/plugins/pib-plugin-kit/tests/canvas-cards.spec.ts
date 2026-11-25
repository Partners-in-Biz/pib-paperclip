/**
 * `registerCanvasCards` (PAR-14389 plan, C.1 "Kit" and E, kit layer): the
 * second layer of core's person rules against a fixture plugin with a
 * hand-built action context, registered once through the access guard's
 * `guard.action` and once through `ctx.actions.register` itself.
 */
import { describe, expect, it } from "vitest";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { canvasCardSummarySchema, canvasCardsRelatedResultSchema, canvasCardsResolveResultSchema, canvasCardsSearchResultSchema } from "@paperclipai/shared/canvas-cards";
import { createAccessGuard } from "../src/access/guard.js";
import { isRefusal } from "../src/access/refusal.js";
import {
  CANVAS_CARDS_INVALID_PARAMS,
  CANVAS_CARDS_PERSON_ONLY_CODE,
  CANVAS_CARDS_RELATED_ACTION,
  CANVAS_CARDS_RESOLVE_ACTION,
  CANVAS_CARDS_SEARCH_ACTION,
  capCardText,
  isCanvasCardHref,
  registerCanvasCards,
  type CanvasCardKind,
} from "../src/canvas-cards.js";
import { ANN, BOB, CO_A, CO_B, RECORDS, fixtureKinds, type FixtureRecord } from "./fixtures/canvas-cards-plugin.js";

type Handler = (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>;
const KEYS = [CANVAS_CARDS_RESOLVE_ACTION, CANVAS_CARDS_SEARCH_ACTION, CANVAS_CARDS_RELATED_ACTION] as const;
const PARAMS: Record<(typeof KEYS)[number], Record<string, unknown>> = {
  [CANVAS_CARDS_RESOLVE_ACTION]: { items: [{ type: "card-thing", id: "t1" }, { type: "card-note", id: "n1" }] },
  [CANVAS_CARDS_SEARCH_ACTION]: { type: "card-thing", q: "thing" },
  [CANVAS_CARDS_RELATED_ACTION]: { of: { plugin: "partnersinbiz.crm", type: "card-company", id: "client-1" } },
};

/** A hand-built action context. `restricted: "absent"` is a host older than the mark (no person fields). */
function actor(
  type: "user" | "agent" | "system",
  { userId = ANN, restricted = false, companyId = CO_A }: { userId?: string | null; restricted?: boolean | "absent"; companyId?: string | null } = {},
): PluginPerformActionContext {
  const person = restricted === "absent" ? {} : { onBehalfOfUserId: userId, onBehalfOfRestricted: restricted };
  return {
    companyId,
    actor: { type, userId: type === "user" ? userId : null, agentId: type === "agent" ? "agent-1" : null, runId: type === "agent" ? "run-1" : null, companyId, ...person },
  } as PluginPerformActionContext;
}

/** `ctx.actions.register` itself, as in Billing, Mailbox and Social. */
function direct(kinds: readonly CanvasCardKind[]) {
  const actions = new Map<string, Handler>();
  registerCanvasCards({ register: (key, handler) => void actions.set(key, handler), kinds });
  return actions;
}

/** The real access guard's `guard.action` (switch off), as in CRM and Campaigns. */
function viaGuard(kinds: readonly CanvasCardKind[]) {
  const actions = new Map<string, Handler>();
  const state = new Map<string, unknown>([["company", { mode: "off", rev: 1, userIds: [], receivedAt: new Date().toISOString() }]]);
  const ctx = {
    state: { get: async (s: { stateKey: string }) => state.get(s.stateKey) ?? null },
    events: { on: () => undefined, emit: async () => undefined },
    actions: { register: (k: string, h: Handler) => void actions.set(k, h) },
    logger: { info: () => undefined },
  } as unknown as PluginContext;
  const guard = createAccessGuard(ctx, { pluginKey: "partnersinbiz.fixture", table: {} });
  registerCanvasCards({ register: guard.action, kinds });
  return actions;
}

describe.each([
  ["ctx.actions.register", direct],
  ["guard.action", viaGuard],
] as const)("registerCanvasCards through %s", (_name, registerWith) => {
  const setup = (records?: FixtureRecord[]) => {
    const fx = fixtureKinds(records);
    const actions = registerWith(fx.kinds);
    const call = (key: string, params: Record<string, unknown>, context: PluginPerformActionContext) => actions.get(key)!(params, context);
    return { ...fx, actions, call };
  };

  it("registers the three fixed keys", () => {
    expect([...setup().actions.keys()]).toEqual(expect.arrayContaining([...KEYS]));
  });

  it.each(["agent", "system"] as const)("refuses a %s caller with the person-only code, without asking a kind", async (type) => {
    const fx = setup();
    for (const key of KEYS) {
      const answer = await fx.call(key, PARAMS[key], actor(type));
      expect(isRefusal(answer)).toBe(true);
      expect(answer).toMatchObject({ code: CANVAS_CARDS_PERSON_ONLY_CODE });
    }
    expect(fx.calls).toEqual([]);
  });

  it("refuses a call with no actor at all", async () => {
    const fx = setup();
    const answer = await fx.call(CANVAS_CARDS_RESOLVE_ACTION, PARAMS[CANVAS_CARDS_RESOLVE_ACTION], { companyId: CO_A } as PluginPerformActionContext);
    expect(answer).toMatchObject({ ok: false, refused: true, code: CANVAS_CARDS_PERSON_ONLY_CODE });
  });

  it("gives a restricted person hidden and empty answers, without asking a kind", async () => {
    const fx = setup();
    const ctx = actor("user", { restricted: true });
    expect(await fx.call(CANVAS_CARDS_RESOLVE_ACTION, PARAMS[CANVAS_CARDS_RESOLVE_ACTION], ctx)).toEqual({
      cards: [{ type: "card-thing", id: "t1", hidden: true }, { type: "card-note", id: "n1", hidden: true }],
    });
    expect(await fx.call(CANVAS_CARDS_SEARCH_ACTION, PARAMS[CANVAS_CARDS_SEARCH_ACTION], ctx)).toEqual({ cards: [] });
    expect(await fx.call(CANVAS_CARDS_RELATED_ACTION, PARAMS[CANVAS_CARDS_RELATED_ACTION], ctx)).toEqual({ groups: [] });
    expect(fx.calls).toEqual([]);
  });

  it("returns (does not throw) a MEMBER_RESTRICTION_UNAVAILABLE refusal when the host sent no restriction answer", async () => {
    const fx = setup();
    for (const key of KEYS) {
      const answer = fx.call(key, PARAMS[key], actor("user", { restricted: "absent" }));
      await expect(answer).resolves.toMatchObject({ ok: false, refused: true, code: "MEMBER_RESTRICTION_UNAVAILABLE" });
    }
    expect(fx.calls).toEqual([]);
  });

  it("answers a member: his own and shared records, hidden for another person's, another company's and unknown ids, in order", async () => {
    const fx = setup();
    const items = ["t2", "t1", "t4", "nope", "t3", "t1"].map((id) => ({ type: "card-thing", id })).concat({ type: "card-unknown", id: "x" });
    const answer = await fx.call(CANVAS_CARDS_RESOLVE_ACTION, { items }, actor("user"));
    expect(canvasCardsResolveResultSchema.parse(answer)).toEqual(answer);
    expect((answer as { cards: Array<{ id: string; hidden?: true; title?: string }> }).cards.map((c) => (c.hidden ? `${c.id}:hidden` : c.id))).toEqual([
      "t2:hidden", "t1", "t4:hidden", "nope:hidden", "t3", "t1", "x:hidden",
    ]);
    // One kind call per kind and batch, the id asked twice is asked once.
    expect(fx.calls.map((c) => [c.kind, c.fn])).toEqual([["card-thing", "resolve"]]);
  });

  it("asks a kind with the company of the call, and Bob sees only his records", async () => {
    const fx = setup();
    const answer = await fx.call(CANVAS_CARDS_SEARCH_ACTION, { type: "card-thing", q: "thing" }, actor("user", { userId: BOB }));
    expect((answer as { cards: Array<{ id: string }> }).cards.map((c) => c.id)).toEqual(["t2", "t3"]);
    expect(fx.calls[0]!.call.companyId).toBe(CO_A);
    const other = await fx.call(CANVAS_CARDS_SEARCH_ACTION, { type: "card-thing", q: "thing" }, actor("user", { companyId: CO_B }));
    expect((other as { cards: Array<{ id: string }> }).cards.map((c) => c.id)).toEqual(["t4"]);
  });

  it("lets the local board through as a user with no person", async () => {
    const fx = setup();
    const answer = await fx.call(CANVAS_CARDS_SEARCH_ACTION, { type: "card-thing", q: "" }, actor("user", { userId: null }));
    expect((answer as { cards: Array<{ id: string }> }).cards.map((c) => c.id)).toEqual(["t3"]);
  });

  it("gives hidden and empty answers to a call with no company", async () => {
    const fx = setup();
    const ctx = actor("user", { companyId: null });
    expect(await fx.call(CANVAS_CARDS_RESOLVE_ACTION, { items: [{ type: "card-thing", id: "t1" }] }, ctx)).toEqual({ cards: [{ type: "card-thing", id: "t1", hidden: true }] });
    expect(await fx.call(CANVAS_CARDS_SEARCH_ACTION, { type: "card-thing", q: "" }, ctx)).toEqual({ cards: [] });
    expect(fx.calls).toEqual([]);
  });

  it("refuses params that fail the shared schema", async () => {
    const fx = setup();
    const items = Array.from({ length: 101 }, (_, i) => ({ type: "card-thing", id: `t${i}` }));
    for (const [key, params] of [
      [CANVAS_CARDS_RESOLVE_ACTION, { items }],
      [CANVAS_CARDS_SEARCH_ACTION, { type: "card-thing", q: "x", limit: 21 }],
      [CANVAS_CARDS_RELATED_ACTION, { of: { plugin: "p", type: "t" }, limit: 5 }],
    ] as const) {
      expect(await fx.call(key, params, actor("user"))).toMatchObject({ refused: true, code: CANVAS_CARDS_INVALID_PARAMS });
    }
    expect(fx.calls).toEqual([]);
  });

  it.each(["//evil.test", "https://x", "javascript:x", "crm", "/\\evil.test", " /crm"])("refuses the href %j: hidden on resolve, dropped on search and related", async (href) => {
    expect(isCanvasCardHref(href)).toBe(false);
    const fx = setup(RECORDS.map((r) => (r.id === "t1" ? { ...r, href } : r)));
    const resolved = await fx.call(CANVAS_CARDS_RESOLVE_ACTION, { items: [{ type: "card-thing", id: "t1" }] }, actor("user"));
    expect(resolved).toEqual({ cards: [{ type: "card-thing", id: "t1", hidden: true }] });
    const found = await fx.call(CANVAS_CARDS_SEARCH_ACTION, { type: "card-thing", q: "thing" }, actor("user"));
    expect((found as { cards: Array<{ id: string }> }).cards.map((c) => c.id)).toEqual(["t3"]);
    const related = await fx.call(CANVAS_CARDS_RELATED_ACTION, PARAMS[CANVAS_CARDS_RELATED_ACTION], actor("user"));
    expect((related as { groups: Array<{ cards: Array<{ id: string }> }> }).groups[0]!.cards.map((c) => c.id)).toEqual(["t3"]);
  });

  it("caps over-long fields instead of refusing the card", async () => {
    const long = "x".repeat(500);
    const meta = Array.from({ length: 6 }, (_, i) => ({ label: `label ${i} ${long}`, value: `value ${i} ${long}` }));
    const fx = setup(RECORDS.map((r) => (r.id === "t1" ? { ...r, title: long, subtitle: long, status: long, meta } : r)));
    const answer = (await fx.call(CANVAS_CARDS_RESOLVE_ACTION, { items: [{ type: "card-thing", id: "t1" }] }, actor("user"))) as { cards: Array<Record<string, unknown>> };
    const card = canvasCardSummarySchema.parse(answer.cards[0]);
    expect(card.title).toHaveLength(200);
    expect(card.title.endsWith("…")).toBe(true);
    expect(card.subtitle).toHaveLength(200);
    expect(card.status).toHaveLength(80);
    expect(card.meta).toHaveLength(4);
    expect(card.meta!.every((m) => m.value.length === 80 && m.label.length === 80)).toBe(true);
    expect(card.href).toBe("/things/t1");
  });

  it("answers a search for a kind with no search, or an unknown kind, with no cards", async () => {
    const fx = setup();
    expect(await fx.call(CANVAS_CARDS_SEARCH_ACTION, { type: "card-note", q: "note" }, actor("user"))).toEqual({ cards: [] });
    expect(await fx.call(CANVAS_CARDS_SEARCH_ACTION, { type: "card-unknown", q: "note" }, actor("user"))).toEqual({ cards: [] });
    expect(fx.calls).toEqual([]);
  });

  it("answers related groups of the kind's type, cut to the limit with `more`, and none for an unknown record", async () => {
    const fx = setup();
    const answer = await fx.call(CANVAS_CARDS_RELATED_ACTION, { ...PARAMS[CANVAS_CARDS_RELATED_ACTION], limit: 1 }, actor("user"));
    expect(canvasCardsRelatedResultSchema.parse(answer)).toEqual({
      groups: [{ relation: "things", label: "Things", type: "card-thing", more: true, cards: [{ type: "card-thing", id: "t1", title: "Ann's thing", status: "open", href: "/things/t1" }] }],
    });
    const none = await fx.call(CANVAS_CARDS_RELATED_ACTION, { of: { plugin: "partnersinbiz.billing", type: "card-invoice", id: "i1" } }, actor("user"));
    expect(none).toEqual({ groups: [] });
  });

  it("caps search answers at the limit, whatever the kind returns", async () => {
    const { kinds } = fixtureKinds();
    const greedy: CanvasCardKind = { ...kinds[0]!, search: async () => RECORDS.map((r) => ({ id: r.id, title: r.title, href: `/x/${r.id}` })) };
    const actions = registerWith([greedy]);
    const answer = await actions.get(CANVAS_CARDS_SEARCH_ACTION)!({ type: "card-thing", q: "", limit: 2 }, actor("user"));
    expect(canvasCardsSearchResultSchema.parse(answer).cards).toHaveLength(2);
  });

  it("rethrows a kind's own fault (Couldn't load, not No access)", async () => {
    const { kinds } = fixtureKinds();
    const broken: CanvasCardKind = { ...kinds[0]!, resolve: async () => { throw new Error("store down"); } };
    const actions = registerWith([broken]);
    await expect(actions.get(CANVAS_CARDS_RESOLVE_ACTION)!({ items: [{ type: "card-thing", id: "t1" }] }, actor("user"))).rejects.toThrow("store down");
  });
});

describe("registerCanvasCards options", () => {
  it("registers no search handler when every kind has `search: false`", () => {
    const { note } = fixtureKinds();
    const actions = direct([{ ...note, related: async () => [] }]);
    expect([...actions.keys()].sort()).toEqual([CANVAS_CARDS_RELATED_ACTION, CANVAS_CARDS_RESOLVE_ACTION]);
  });

  it("passes the guard's check to the kind in a guarded plugin, and none when registered directly", async () => {
    for (const [registerWith, mode] of [[viaGuard, "off"], [direct, undefined]] as const) {
      const fx = fixtureKinds();
      const actions = registerWith(fx.kinds);
      await actions.get(CANVAS_CARDS_RESOLVE_ACTION)!({ items: [{ type: "card-thing", id: "t1" }] }, actor("user"));
      expect(fx.calls[0]!.call.check?.mode).toBe(mode);
    }
  });

  it("refuses a kind listed twice", () => {
    const { thing } = fixtureKinds();
    expect(() => direct([thing, thing])).toThrow(/listed twice/);
  });
});

describe("capCardText", () => {
  it("keeps short text and never splits a surrogate pair", () => {
    expect(capCardText("short", 10)).toBe("short");
    const cut = capCardText(`${"a".repeat(8)}😀😀`, 10);
    expect(cut.length).toBeLessThanOrEqual(10);
    expect(cut).toBe(`${"a".repeat(8)}…`);
  });

  it("accepts a relative path with one slash", () => {
    expect(isCanvasCardHref("/crm/companies/c1")).toBe(true);
    expect(isCanvasCardHref("/")).toBe(true);
  });
});
