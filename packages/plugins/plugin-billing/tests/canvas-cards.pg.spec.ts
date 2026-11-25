/**
 * The invoice card on a Planning Canvas board (PAR-14420; plan PAR-14389 E, paths 1 and 8).
 * Real database: the card search is new SQL (`searchInvoices`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const OTHER_COMPANY = "22222222-2222-2222-2222-222222222222";
const RESOLVE = "canvas.cards.resolve";
const SEARCH = "canvas.cards.search";
const RELATED = "canvas.cards.related";
const CRM = "partnersinbiz.crm";

function person(userId: string, opts: { restricted?: boolean; companyId?: string } = {}) {
  const companyId = opts.companyId ?? COMPANY;
  return { companyId, actor: { type: "user" as const, userId, agentId: null, runId: null, companyId, onBehalfOfUserId: userId, onBehalfOfRestricted: opts.restricted === true } };
}
const ADMIN = person("admin-1");
const MEMBER = person("member-1");
const REFUSED = person("refused-1", { restricted: true });
const CALLERS = [ADMIN, MEMBER, REFUSED];

describe("the manifest and the worker (no database)", () => {
  it("declares the card-invoice slot with entityCard", () => {
    const slot = manifest.ui?.slots?.find((s) => s.id === "card-invoice");
    expect(slot).toMatchObject({ type: "canvasNode", exportName: "BillingInvoiceCard", entityCard: { kind: "invoice", search: true, related: true } });
  });

  it("registers the three actions through registerCanvasCards, on the register it is given", async () => {
    const keys: string[] = [];
    const { registerBillingCanvasCards } = await import("../src/canvas-cards.js");
    registerBillingCanvasCards({} as never, (key: string) => void keys.push(key));
    expect(keys.sort()).toEqual([RELATED, RESOLVE, SEARCH]);
  });
});

describe.skipIf(!available)("invoice cards (postgres)", () => {
  let h: Harness;
  let lumenA: string; // company A, Lumen Digital (contact ct-lumen)
  let lumenB: string; // company A, second invoice, same client
  let jo: string; // company A, another client
  let foreign: string; // company B
  let shared: string; // company B, shared with A

  const draft = (customerRef: string, companyId = COMPANY) =>
    h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef }, person("admin-1", { companyId })).then((r) => r.id);
  const ids = (answer: { cards: Array<{ id: string }> }) => answer.cards.map((c) => c.id).sort();

  beforeAll(async () => {
    h = await startHarness();
    await plugin.definition.setup(h.ctx);
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });
  beforeEach(async () => {
    await h.reset();
    h.config.set(COMPANY, { ...SETTINGS });
    h.config.set(OTHER_COMPANY, { ...SETTINGS });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
    await seedClient(h, { id: "ct-jo", name: "Jo Bloggs & 100% Sons_" });
    await h.client.query(`INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, emails, updated_at) VALUES ('ct-foreign', $1, 'Foreign Ltd', '{}', now())`, [OTHER_COMPANY]);
    lumenA = await draft("ct-lumen");
    lumenB = await draft("ct-lumen");
    jo = await draft("ct-jo");
    foreign = await draft("ct-foreign", OTHER_COMPANY);
    shared = await draft("ct-foreign", OTHER_COMPANY);
    await h.client.query(`INSERT INTO ${NAMESPACE}.invoice_grants (id, company_id, invoice_id, grantee_company_id) VALUES ('g1', $3, $1, $2)`, [shared, COMPANY, OTHER_COMPANY]);
    await h.client.query(`UPDATE ${NAMESPACE}.invoices SET number = 'INV-0042' WHERE id = $1`, [lumenA]);
  });

  it("resolve: own, shared, another company's, unknown and deleted ids (paths 1 and 8)", async () => {
    await h.call("billing.delete-draft-invoice", { invoiceId: lumenB }, ADMIN);
    const asB = await h.call<{ cards: Array<Record<string, unknown>> }>(RESOLVE, { items: [{ type: "card-invoice", id: lumenA }, { type: "card-invoice", id: lumenB }, { type: "card-invoice", id: foreign }, { type: "card-invoice", id: shared }, { type: "card-invoice", id: "nope" }] }, ADMIN);
    expect(asB.cards[0]).toMatchObject({ id: lumenA, title: "Invoice INV-0042", subtitle: "Lumen Digital", href: "/billing?client=contact%3Act-lumen" });
    expect(asB.cards.slice(1, 3)).toEqual([{ type: "card-invoice", id: lumenB, hidden: true }, { type: "card-invoice", id: foreign, hidden: true }]);
    expect(asB.cards[3]).toMatchObject({ id: shared });
    expect(asB.cards[4]).toEqual({ type: "card-invoice", id: "nope", hidden: true });
    // The other company asks for company A's invoice: hidden, whoever it is.
    for (const userId of ["admin-1", "member-1"]) {
      const answer = await h.call<{ cards: unknown[] }>(RESOLVE, { items: [{ type: "card-invoice", id: lumenA }] }, person(userId, { companyId: OTHER_COMPANY }));
      expect(answer.cards).toEqual([{ type: "card-invoice", id: lumenA, hidden: true }]);
    }
  });

  it("an agent and a restricted member get no cards", async () => {
    const items = [{ type: "card-invoice", id: lumenA }];
    expect(await h.call(RESOLVE, { items }, REFUSED)).toEqual({ cards: [{ type: "card-invoice", id: lumenA, hidden: true }] });
    expect(await h.call(SEARCH, { type: "card-invoice", q: "lumen" }, REFUSED)).toEqual({ cards: [] });
    expect(await h.call(RELATED, { of: { plugin: CRM, type: "card-contact", id: "ct-lumen" } }, REFUSED)).toEqual({ groups: [] });
    expect(await h.call(RESOLVE, { items }, { companyId: COMPANY, actor: { type: "agent", userId: null, agentId: "a", runId: "r", companyId: COMPANY } })).toMatchObject({ refused: true });
  });

  it("resolve agrees with the page's detail action, record by record, for three callers", async () => {
    for (const caller of CALLERS) {
      const answer = await h.call<{ cards: Array<{ id: string; hidden?: true; status?: string; title?: string }> }>(RESOLVE, { items: [lumenA, jo, foreign, shared].map((id) => ({ type: "card-invoice", id })) }, caller);
      for (const card of answer.cards) {
        if (caller.actor.onBehalfOfRestricted) {
          expect(card.hidden).toBe(true);
          continue;
        }
        const detail = await h.call<{ invoice: { id: string; status: string; number: string | null } }>("billing.invoice-detail", { invoiceId: card.id }, caller).catch(() => null);
        if (!detail) expect(card.hidden).toBe(true);
        else expect(card).toMatchObject({ id: detail.invoice.id, status: detail.invoice.status });
      }
    }
  });

  it("search equals the page's list for the same text (new SQL: searchInvoices), for three callers", async () => {
    const page = await h.call<{ invoices: Array<{ id: string; number: string | null; customerName: string | null }> }>("billing.load", {}, ADMIN);
    const byText = (text: string) => page.invoices.filter((i) => `${i.number ?? ""} ${i.customerName ?? ""}`.toLowerCase().includes(text.toLowerCase())).map((i) => i.id).sort();
    for (const caller of CALLERS) {
      for (const q of ["lumen", "INV-0042", "foreign", "zzz"]) {
        const cards = await h.call<{ cards: Array<{ id: string }> }>(SEARCH, { type: "card-invoice", q }, caller);
        if (caller.actor.onBehalfOfRestricted) expect(cards.cards).toEqual([]);
        else expect(ids(cards)).toEqual(byText(q));
      }
    }
    // Wildcards in the text are text, and `limit` holds.
    expect(ids(await h.call(SEARCH, { type: "card-invoice", q: "100%" }, ADMIN))).toEqual([jo]);
    expect(ids(await h.call(SEARCH, { type: "card-invoice", q: "%" }, ADMIN))).toEqual([jo]);
    expect(ids(await h.call(SEARCH, { type: "card-invoice", q: "_" }, ADMIN))).toEqual([jo]);
    expect((await h.call<{ cards: unknown[] }>(SEARCH, { type: "card-invoice", q: "", limit: 2 }, ADMIN)).cards).toHaveLength(2);
    // Company B sees its own and not company A's.
    const asB = await h.call<{ cards: Array<{ id: string }> }>(SEARCH, { type: "card-invoice", q: "lumen" }, person("admin-1", { companyId: OTHER_COMPANY }));
    expect(asB.cards).toEqual([]);
  });

  it("related equals the page's list filtered to that client, for three callers", async () => {
    for (const [type, kind, ref] of [["card-contact", "contact", "ct-lumen"], ["card-company", "company", "ct-lumen"], ["card-contact", "contact", "ct-foreign"]] as const) {
      const page = await h.call<{ invoices: Array<{ id: string }> }>("billing.load", { client: `${kind}:${ref}` }, ADMIN);
      for (const caller of CALLERS) {
        const answer = await h.call<{ groups: Array<{ relation: string; type: string; cards: Array<{ id: string }>; more: boolean }> }>(RELATED, { of: { plugin: CRM, type, id: ref } }, caller);
        const got = answer.groups.flatMap((g) => g.cards.map((c) => c.id)).sort();
        expect(got).toEqual(caller.actor.onBehalfOfRestricted ? [] : page.invoices.map((i) => i.id).sort());
      }
    }
    const lumen = await h.call<{ groups: Array<{ relation: string; type: string; more: boolean; cards: unknown[] }> }>(RELATED, { of: { plugin: CRM, type: "card-contact", id: "ct-lumen" }, limit: 1 }, ADMIN);
    expect(lumen.groups).toMatchObject([{ relation: "invoice", type: "card-invoice", more: true }]);
    expect(lumen.groups[0]?.cards).toHaveLength(1);
    // Another plugin's record, an unknown client: nothing.
    expect(await h.call(RELATED, { of: { plugin: "partnersinbiz.mailbox", type: "card-contact", id: "ct-lumen" } }, ADMIN)).toEqual({ groups: [] });
    expect(await h.call(RELATED, { of: { plugin: CRM, type: "card-contact", id: "ct-missing" } }, ADMIN)).toEqual({ groups: [] });
  });

  it("related for a client the caller cannot see in CRM answers what the page shows for that client", async () => {
    // company A's person asks about company B's CRM contact: A holds no invoice for it (the grant aside), so only the shared one shows,
    // exactly as `billing.load` with that client shows it.
    const page = await h.call<{ invoices: Array<{ id: string }> }>("billing.load", { client: "contact:ct-foreign" }, MEMBER);
    const answer = await h.call<{ groups: Array<{ cards: Array<{ id: string }> }> }>(RELATED, { of: { plugin: CRM, type: "card-contact", id: "ct-foreign" } }, MEMBER);
    expect(answer.groups.flatMap((g) => g.cards.map((c) => c.id))).toEqual(page.invoices.map((i) => i.id));
    expect(answer.groups.flatMap((g) => g.cards.map((c) => c.id))).not.toContain(foreign);
  });
});
