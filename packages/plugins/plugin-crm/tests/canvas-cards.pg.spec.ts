/**
 * The CRM canvas cards (PAR-14416) on a real Postgres (rule PAR-10373). The cards add no SQL: they read through
 * `listAccounts`, `listContacts`, `listLinks` and `grantsFor`, which had no real-database case before. One case per
 * reader, each with a second company and a second person in one company, plus a partner share and a deleted record.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { registerCanvasCards } from "@partnersinbiz/pib-plugin-kit";
import { crmCardKinds } from "../src/canvas-cards.js";
import { getAccount } from "../src/db.js";
import type { Viewer } from "../src/domain.js";
import { deleteCompanyRecord } from "../src/handoffs.js";
import { findRecords } from "../src/lookup.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const CO = "co-1";
const OTHER = "co-2";
const N = NAMESPACE;
const ROLES: Record<string, string> = { admin: "admin", ann: "member", bob: "member" };
const viewerOf = (userId: string): Viewer => ({ companyId: CO, userId, agentId: null, role: ROLES[userId] ?? null });
const available = await embeddedAvailable();

type Card = { id: string; hidden?: true; title?: string };
type Answer = { cards: Card[]; groups: Array<{ relation: string; cards: Card[] }> };
type Handler = (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>;

describe.skipIf(!available)("CRM canvas cards on a real Postgres", () => {
  let pg: PgHarness;
  let actions: Map<string, Handler>;
  beforeAll(async () => {
    pg = await startPg();
    actions = new Map();
    registerCanvasCards({
      register: (key, handler) => void actions.set(key, handler),
      kinds: crmCardKinds(pg.ctx, async (call) => viewerOf(call.context.actor.userId!)),
    });
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(async () => {
    await pg.reset();
    await seed();
  });

  const q = (sql: string) => pg.client.query(sql);
  const account = (id: string, company: string, name: string, owner: string | null, domain: string | null = null) =>
    q(`INSERT INTO ${N}.companies (id, company_id, name, domain, owner_user_id) VALUES ('${id}', '${company}', '${name}', ${domain ? `'${domain}'` : "NULL"}, ${owner ? `'${owner}'` : "NULL"})`);
  const person = (id: string, company: string, name: string, owner: string | null, email: string) =>
    q(`INSERT INTO ${N}.contacts (id, company_id, name, emails, owner_user_id) VALUES ('${id}', '${company}', '${name}', '["${email}"]'::jsonb, ${owner ? `'${owner}'` : "NULL"})`);
  const link = (id: string, company: string, contactId: string, accountId: string) =>
    q(`INSERT INTO ${N}.contact_companies (id, company_id, contact_id, account_id) VALUES ('${id}', '${company}', '${contactId}', '${accountId}')`);
  const grant = (id: string, company: string, type: string, recordId: string, principalType: string, principalId: string) =>
    q(`INSERT INTO ${N}.record_grants (id, company_id, record_type, record_id, principal_type, principal_id) VALUES ('${id}', '${company}', '${type}', '${recordId}', '${principalType}', '${principalId}')`);

  /** Ann owns Acme and Ada; Bob owns Globex and Grace and shares Globex with Ann; co-2 shares Partner Co with co-1. */
  async function seed() {
    await account("acme", CO, "Acme Plumbing", "ann", "acme.co.za");
    await account("globex", CO, "Globex", "bob", "globex.test");
    await account("initech", CO, "Initech Acme", "bob");
    await account("foreign", OTHER, "Foreign Acme", "ann");
    await account("partner", OTHER, "Partner Acme", null);
    await person("ada", CO, "Ada Lovelace", "ann", "ada@acme.co.za");
    await person("grace", CO, "Grace Hopper", "bob", "grace@globex.test");
    await person("alien", OTHER, "Ada Foreign", "ann", "ada@foreign.test");
    await link("l1", CO, "ada", "acme");
    await link("l2", CO, "grace", "acme");
    await link("l3", CO, "ada", "initech");
    await link("l4", OTHER, "alien", "foreign");
    await grant("g1", CO, "company", "globex", "user", "ann");
    await grant("g2", OTHER, "company", "partner", "company", CO);
  }

  const context = (userId: string) => ({ companyId: CO, actor: { type: "user", userId, agentId: null, runId: null, companyId: CO, onBehalfOfUserId: userId, onBehalfOfRestricted: false } }) as unknown as PluginPerformActionContext;
  const act = async (key: string, params: Record<string, unknown>, userId: string) => (await actions.get(key)!(params, context(userId))) as Answer;
  const shown = async (userId: string, type: string, ids: string[]) =>
    (await act("canvas.cards.resolve", { items: ids.map((id) => ({ type, id })) }, userId)).cards
      .filter((card) => !card.hidden).map((card) => card.id);

  it("listAccounts + grantsFor: resolve shows own, user-granted and partner-shared companies; another company's, unknown and deleted ones are hidden", async () => {
    const ids = ["acme", "globex", "initech", "foreign", "partner", "nope"];
    expect(await shown("admin", "card-company", ids)).toEqual(["acme", "globex", "initech", "partner"]);
    expect(await shown("ann", "card-company", ids)).toEqual(["acme", "globex", "partner"]);
    expect(await shown("bob", "card-company", ids)).toEqual(["globex", "initech", "partner"]);

    await deleteCompanyRecord(pg.ctx, CO, (await getAccount(pg.ctx, "acme"))!);
    expect(await getAccount(pg.ctx, "acme")).toBeNull();
    expect(await shown("admin", "card-company", ids)).toEqual(["globex", "initech", "partner"]);
    expect(await shown("ann", "card-company", ids)).toEqual(["globex", "partner"]);
  });

  it("listContacts: search is the page's find for the same text, per person; another company's contact never shows", async () => {
    for (const userId of ["admin", "ann", "bob"]) {
      for (const [type, kind] of [["card-company", "company"], ["card-contact", "contact"]] as const) {
        for (const text of ["acme", "Ada", "globex.test", "zzz"]) {
          const { cards } = await act("canvas.cards.search", { type, q: text, limit: 20 }, userId);
          const page = await findRecords(pg.ctx, viewerOf(userId), { query: text, kind, limit: 20 });
          expect(cards.map((c) => c.id), `${userId} ${type} "${text}"`).toEqual(page.results.map((r) => r.id));
        }
      }
    }
    const ada = (await act("canvas.cards.search", { type: "card-contact", q: "Ada" }, "admin")).cards;
    expect(ada.map((c) => c.id)).toEqual(["ada"]);
    expect(ada[0]).toMatchObject({ title: "Ada Lovelace", subtitle: "ada@acme.co.za", href: "/crm?client=contact%3Aada", meta: [{ label: "Company", value: "Acme Plumbing, Initech Acme" }] });
  });

  it("listLinks: related gives only visible records of this company's links, and nothing for an `of` the person cannot see", async () => {
    const related = async (userId: string, type: string, id: string) =>
      (await act("canvas.cards.related", { of: { plugin: "partnersinbiz.crm", type, id } }, userId)).groups
        .map((g) => ({ relation: g.relation, ids: g.cards.map((c) => c.id) }));
    expect(await related("admin", "card-company", "acme")).toEqual([{ relation: "contact", ids: ["ada", "grace"] }]);
    expect(await related("ann", "card-company", "acme")).toEqual([{ relation: "contact", ids: ["ada"] }]);
    expect(await related("admin", "card-contact", "ada")).toEqual([{ relation: "company", ids: ["acme", "initech"] }]);
    expect(await related("ann", "card-contact", "ada")).toEqual([{ relation: "company", ids: ["acme"] }]);
    // Not visible to the person, or another company's record and link.
    expect(await related("bob", "card-company", "acme")).toEqual([]);
    expect(await related("admin", "card-company", "foreign")).toEqual([]);
    expect(await related("admin", "card-contact", "alien")).toEqual([]);
  });
});
