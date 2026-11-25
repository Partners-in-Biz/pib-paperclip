/**
 * CRM company and contact cards on a planning canvas (PAR-14416; plan PAR-14389 E, A3): the manifest and the
 * registration, E paths 1 and 8 with a second company and a second person in one company, and page parity for all
 * three actions for three callers (an admin, a plain member, a member the page refuses).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accessCompanyScope, isRefusal, PERMISSION_DENIED } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { ACCESS_TABLE } from "../src/access-table.js";
import { boardBatcher, holdBoard } from "../src/ui/card-boards.js";
import { boot, CO, company, contact, seed } from "./helpers/crm.js";

const RESOLVE = "canvas.cards.resolve";
const SEARCH = "canvas.cards.search";
const RELATED = "canvas.cards.related";
const CRM = "partnersinbiz.crm";

const ADMIN = "a1416000-0000-4000-8000-000000000001";
const ANN = "a1416000-0000-4000-8000-000000000002";
const BOB = "a1416000-0000-4000-8000-000000000003";
const REFUSED = "a1416000-0000-4000-8000-000000000004";

type Card = { type: string; id: string; hidden?: true; title?: string; href?: string };
type Group = { relation: string; label: string; type: string; cards: Card[]; more: boolean };

/** Ann owns Acme and Ada, Bob owns Globex and Grace; Sipho (a sole trader) has no owner. Foreign Co is another company's. */
function store() {
  const s = seed();
  s.companies = [
    company("acme", "Acme Plumbing", { domain: "acme.co.za", lifecycle: "prospect", tags: ["retainer"], owner_user_id: ANN }),
    company("globex", "Globex", { domain: "globex.test", owner_user_id: BOB }),
    company("acme-north", "Acme North", { owner_user_id: BOB }),
    { ...company("foreign", "Foreign Acme"), company_id: "co-2", owner_user_id: ANN },
  ];
  s.contacts = [
    contact("ada", "Ada Lovelace", { emails: ["ada@acme.co.za"], phones: ["+27 82 123 4567"], owner_user_id: ANN }),
    contact("grace", "Grace Hopper", { emails: ["grace@globex.test"], owner_user_id: BOB }),
    contact("bert", "Bert Acme", { emails: ["bert@acme.co.za"], owner_user_id: BOB }),
    contact("solo", "Sipho Solo", { emails: ["sipho@solo.test"], lifecycle: "customer" }),
    { ...contact("alien", "Ada Foreign"), company_id: "co-2", owner_user_id: ANN },
  ];
  s.contact_companies = [
    { id: "l1", company_id: CO, contact_id: "ada", account_id: "acme", role_label: "owner", created_at: "2026-01-01T00:00:00Z" },
    { id: "l2", company_id: CO, contact_id: "grace", account_id: "globex", role_label: "buyer", created_at: "2026-01-01T00:00:00Z" },
    { id: "l3", company_id: CO, contact_id: "bert", account_id: "acme", role_label: "staff", created_at: "2026-01-02T00:00:00Z" },
    { id: "l4", company_id: CO, contact_id: "ada", account_id: "acme-north", role_label: "owner", created_at: "2026-01-03T00:00:00Z" },
  ];
  return s;
}

async function crm(mode?: "enforce") {
  const booted = await boot({ store: store() });
  const at = new Date().toISOString();
  const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: CO, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
  booted.harness.seed({ accessMembers: [member(ADMIN, "admin"), member(ANN, "member"), member(BOB, "member"), member(REFUSED, "member")] });
  if (mode) await booted.harness.ctx.state.set(accessCompanyScope(CO), { mode, rev: 1, userIds: [], receivedAt: at });
  const as = (userId: string) => ({ companyId: CO, actor: { type: "user" as const, userId, onBehalfOfUserId: userId, onBehalfOfRestricted: false } });
  const act = <T = unknown>(key: string, params: Record<string, unknown>, userId: string) => booted.harness.performAction<T>(key, params, as(userId));
  return { ...booted, act };
}

const COMPANY_IDS = ["acme", "globex", "acme-north", "foreign", "nope"];
const CONTACT_IDS = ["ada", "grace", "bert", "solo", "alien", "nope"];
const items = [...COMPANY_IDS.map((id) => ({ type: "card-company", id })), ...CONTACT_IDS.map((id) => ({ type: "card-contact", id }))];
const kindOf = (type: string) => (type === "card-company" ? "company" : "contact");

describe("CRM canvas cards: manifest and registration", () => {
  it("declares card-company and card-contact as canvasNode slots with entityCard, both exported by the page bundle", () => {
    const slots = (manifest.ui?.slots ?? []).filter((slot) => slot.type === "canvasNode");
    expect(slots.map((slot) => ({ id: slot.id, exportName: slot.exportName, entityCard: slot.entityCard }))).toEqual([
      { id: "card-company", exportName: "CrmCompanyCard", entityCard: { kind: "company", search: true, related: true } },
      { id: "card-contact", exportName: "CrmContactCard", entityCard: { kind: "contact", search: true, related: true } },
    ]);
    const index = readFileSync(new URL("../src/ui/index.tsx", import.meta.url), "utf8");
    expect(index).toContain(`export { CrmCompanyCard, CrmContactCard } from "./canvas-card.js";`);
  });

  it("the worker registers the three actions through registerCanvasCards on guard.action; each is companies view in the table", async () => {
    const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(worker).toMatch(/registerCanvasCards\(\{\s*register: guard\.action,/);
    for (const key of [RESOLVE, SEARCH, RELATED]) expect(ACCESS_TABLE[key], key).toEqual({ resource: "crm.companies", action: "view" });
    const { act } = await crm();
    await expect(act(RESOLVE, { items: [] }, ADMIN)).resolves.toEqual({ cards: [] });
    await expect(act(SEARCH, { type: "card-company", q: "" }, ADMIN)).resolves.toEqual({ cards: [] });
    await expect(act(RELATED, { of: { plugin: CRM, type: "card-company", id: "nope" } }, ADMIN)).resolves.toEqual({ groups: [] });
  });

  it("an agent is refused by the kit's second layer", async () => {
    const { harness } = await crm();
    const answer = await harness.performAction(RESOLVE, { items }, { companyId: CO, actor: { type: "agent", agentId: "agent-1", runId: "run-1" } as never });
    expect(isRefusal(answer) && answer.code).toBe("CANVAS_CARDS_PERSON_ONLY");
  });
});

describe("CRM canvas cards: paths 1 and 8", () => {
  it("a plain member sees only what they own; the other member's record, another company's, an unknown and a deleted one are hidden", async () => {
    const { act } = await crm();
    const visible = async (userId: string) =>
      ((await act<{ cards: Card[] }>(RESOLVE, { items }, userId)).cards).filter((card) => !card.hidden).map((card) => card.id);
    expect(await visible(ANN)).toEqual(["acme", "ada"]);
    expect(await visible(BOB)).toEqual(["globex", "acme-north", "grace", "bert"]);
    expect(await visible(ADMIN)).toEqual(["acme", "globex", "acme-north", "ada", "grace", "bert", "solo"]);

    const before = await act<{ cards: Card[] }>(RESOLVE, { items: [{ type: "card-company", id: "acme" }] }, ADMIN);
    expect(before.cards[0]).toMatchObject({ id: "acme", title: "Acme Plumbing", subtitle: "acme.co.za", status: "prospect", href: "/PIB/crm?client=company%3Aacme" });
    await act("crm.delete-company", { companyRecordId: "acme", confirm: true }, ADMIN);
    const after = await act<{ cards: Card[] }>(RESOLVE, { items: [{ type: "card-company", id: "acme" }, { type: "card-company", id: "foreign" }, { type: "card-contact", id: "nope" }] }, ADMIN);
    expect(after.cards).toEqual([
      { type: "card-company", id: "acme", hidden: true },
      { type: "card-company", id: "foreign", hidden: true },
      { type: "card-contact", id: "nope", hidden: true },
    ]);
  });

  it("related with an `of` the person cannot see in the CRM answers no group", async () => {
    const { act } = await crm();
    for (const of of [
      { plugin: CRM, type: "card-company", id: "globex" }, // Bob's
      { plugin: CRM, type: "card-company", id: "foreign" }, // another company's
      { plugin: CRM, type: "card-contact", id: "grace" },
      { plugin: CRM, type: "card-contact", id: "nope" },
    ]) {
      expect(await act(RELATED, { of }, ANN), of.id).toEqual({ groups: [] });
    }
    // A record of another plugin is not the CRM's to relate.
    expect(await act(RELATED, { of: { plugin: "partnersinbiz.billing", type: "card-company", id: "acme" } }, ADMIN)).toEqual({ groups: [] });
  });
});

describe("CRM canvas cards: page parity", () => {
  it.each([["an admin", ADMIN], ["a plain member", ANN], ["the other plain member", BOB]])("%s: resolve, search and related agree with the page's own actions", async (_who, userId) => {
    const { act } = await crm();

    // resolve agrees with the client workspace record by record.
    const { cards } = await act<{ cards: Card[] }>(RESOLVE, { items }, userId);
    expect(cards.map(({ type, id }) => ({ type, id }))).toEqual(items);
    for (const card of cards) {
      const page = await act<{ found: boolean; company?: { name: string }; contact?: { name: string } }>("crm.client-workspace", { kind: kindOf(card.type), id: card.id }, userId);
      expect(!card.hidden, `${card.type} ${card.id}`).toBe(page.found);
      if (page.found) expect(card.title).toBe((page.company ?? page.contact)!.name);
    }

    // search returns the set the page's find returns for the same text.
    for (const type of ["card-company", "card-contact"]) {
      for (const q of ["acme", "a", "globex.test", "ada@", "Sipho", "zzz"]) {
        const card = await act<{ cards: Card[] }>(SEARCH, { type, q, limit: 20 }, userId);
        const page = await act<{ results: Array<{ id: string }> }>("crm.find-records", { query: q, kind: kindOf(type), limit: 20 }, userId);
        expect(card.cards.map((c) => c.id), `${type} "${q}"`).toEqual(page.results.map((r) => r.id));
      }
    }

    // related: every record is one the person can open, and the set is the client workspace's.
    for (const card of cards.filter((c) => !c.hidden)) {
      const { groups } = await act<{ groups: Group[] }>(RELATED, { of: { plugin: CRM, type: card.type, id: card.id } }, userId);
      const page = await act<{ contacts: Array<{ id: string }>; companies: Array<{ id: string }> }>("crm.client-workspace", { kind: kindOf(card.type), id: card.id }, userId);
      const expected = card.type === "card-company"
        ? { relation: "contact", label: "Contacts", type: "card-contact", ids: page.contacts.map((c) => c.id) }
        : { relation: "company", label: "Companies", type: "card-company", ids: page.companies.map((c) => c.id) };
      expect(groups.map((g) => ({ relation: g.relation, label: g.label, type: g.type, ids: g.cards.map((c) => c.id) })), card.id).toEqual([expected]);
      for (const related of groups[0]!.cards) {
        expect((await act<{ found: boolean }>("crm.client-workspace", { kind: kindOf(related.type), id: related.id }, userId)).found, related.id).toBe(true);
      }
    }
  });

  it("a member the page refuses (enforce, no grant) is refused by every card action as by the page; the admin still passes", async () => {
    const { act } = await crm("enforce");
    const page = await act("crm.client-workspace", { kind: "company", id: "acme" }, REFUSED);
    expect(isRefusal(page) && page.code).toBe(PERMISSION_DENIED);
    const find = await act("crm.find-records", { query: "acme" }, REFUSED);
    expect(isRefusal(find) && find.code).toBe(PERMISSION_DENIED);
    for (const [key, params] of [
      [RESOLVE, { items }],
      [SEARCH, { type: "card-company", q: "acme" }],
      [RELATED, { of: { plugin: CRM, type: "card-company", id: "acme" } }],
    ] as const) {
      const answer = await act(key, params, REFUSED);
      expect(isRefusal(answer) && answer.code, key).toBe(PERMISSION_DENIED);
    }
    const admin = await act<{ cards: Card[] }>(RESOLVE, { items: [{ type: "card-company", id: "acme" }] }, ADMIN);
    expect(admin.cards[0]).toMatchObject({ id: "acme", title: "Acme Plumbing" });
  });
});

describe("CRM canvas cards: one batcher per board", () => {
  it("cards of one board share one resolve call; the batcher goes with the board's last card", async () => {
    const calls: unknown[] = [];
    const resolve = async (params: { items: { type: string; id: string }[] }) => {
      calls.push(params);
      return { cards: params.items.map((item) => ({ ...item, title: item.id, href: `/crm?client=company:${item.id}` })) };
    };
    const first = boardBatcher("co-1\u0000board-1", resolve);
    const second = boardBatcher("co-1\u0000board-1", resolve);
    expect(second).toBe(first);
    const dropFirst = holdBoard("co-1\u0000board-1", first);
    const dropSecond = holdBoard("co-1\u0000board-1", second);
    const states = await Promise.all([first.batcher.load("card-company", "acme"), second.batcher.load("card-contact", "ada")]);
    expect(states.map((s) => s.state)).toEqual(["card", "card"]);
    expect(calls).toEqual([{ items: [{ type: "card-company", id: "acme" }, { type: "card-contact", id: "ada" }] }]);
    expect(boardBatcher("co-1\u0000board-2", resolve)).not.toBe(first);
    dropFirst();
    expect(boardBatcher("co-1\u0000board-1", resolve)).toBe(first);
    dropSecond();
    expect(boardBatcher("co-1\u0000board-1", resolve)).not.toBe(first);
  });
});
