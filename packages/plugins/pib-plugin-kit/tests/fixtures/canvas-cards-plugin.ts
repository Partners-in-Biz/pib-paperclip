/**
 * A fixture plugin for `registerCanvasCards` (PAR-14389 plan, E: kit layer).
 *
 * Two kinds over one in-memory store: `card-thing` (search and related) and
 * `card-note` (no search, no related). A record is visible when it is in the
 * caller's company and the caller owns it or it is shared, the per-record
 * rule a real plugin's page applies. `calls` counts every kind call, so a test
 * can prove a refused or restricted call never reached a kind.
 */
import type { CanvasCardCall, CanvasCardInput, CanvasCardKind } from "../../src/canvas-cards.js";

export const CO_A = "11111111-1111-4111-8111-111111111111";
export const CO_B = "44444444-4444-4444-8444-444444444444";
export const ANN = "user-ann";
export const BOB = "user-bob";

export interface FixtureRecord {
  type: "card-thing" | "card-note";
  id: string;
  companyId: string;
  ownerId: string;
  shared?: boolean;
  title: string;
  subtitle?: string;
  status?: string;
  meta?: Array<{ label: string; value: string }>;
  href?: string;
  clientId?: string;
}

export const RECORDS: FixtureRecord[] = [
  { type: "card-thing", id: "t1", companyId: CO_A, ownerId: ANN, title: "Ann's thing", status: "open", href: "/things/t1", clientId: "client-1" },
  { type: "card-thing", id: "t2", companyId: CO_A, ownerId: BOB, title: "Bob's thing", href: "/things/t2", clientId: "client-1" },
  { type: "card-thing", id: "t3", companyId: CO_A, ownerId: BOB, shared: true, title: "Shared thing", href: "/things/t3", clientId: "client-1" },
  { type: "card-thing", id: "t4", companyId: CO_B, ownerId: ANN, title: "Other company's thing", href: "/things/t4", clientId: "client-1" },
  { type: "card-note", id: "n1", companyId: CO_A, ownerId: ANN, title: "Ann's note", href: "/notes/n1" },
];

export function fixtureKinds(records: FixtureRecord[] = RECORDS) {
  const calls: Array<{ kind: string; fn: "resolve" | "search" | "related"; call: CanvasCardCall }> = [];
  const viewer = (call: CanvasCardCall) => call.context.actor.onBehalfOfUserId ?? call.context.actor.userId;
  const visible = (call: CanvasCardCall, type: FixtureRecord["type"]) =>
    records.filter((r) => r.type === type && r.companyId === call.companyId && (r.shared || r.ownerId === viewer(call)));
  const card = (r: FixtureRecord): CanvasCardInput => ({
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    status: r.status,
    meta: r.meta,
    href: r.href ?? `/${r.type}/${r.id}`,
  });

  const thing: CanvasCardKind = {
    type: "card-thing",
    async resolve(ids, call) {
      calls.push({ kind: "card-thing", fn: "resolve", call });
      return visible(call, "card-thing").filter((r) => ids.includes(r.id)).map(card);
    },
    async search({ q, limit }, call) {
      calls.push({ kind: "card-thing", fn: "search", call });
      return visible(call, "card-thing").filter((r) => r.title.toLowerCase().includes(q.toLowerCase())).slice(0, limit).map(card);
    },
    async related({ of }, call) {
      calls.push({ kind: "card-thing", fn: "related", call });
      if (of.plugin !== "partnersinbiz.crm" || of.type !== "card-company") return [];
      // Hands back every match; the helper cuts to `limit` and sets `more`.
      return [{ relation: "things", label: "Things", cards: visible(call, "card-thing").filter((r) => r.clientId === of.id).map(card) }];
    },
  };

  const note: CanvasCardKind = {
    type: "card-note",
    async resolve(ids, call) {
      calls.push({ kind: "card-note", fn: "resolve", call });
      return visible(call, "card-note").filter((r) => ids.includes(r.id)).map(card);
    },
    search: false,
    related: false,
  };

  return { kinds: [thing, note], thing, note, calls };
}
