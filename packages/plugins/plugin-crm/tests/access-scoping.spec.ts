/**
 * Access stage B-2 (PAR-15204; plan PAR-12581 B-D3, B-D4): under a `linked` decision the CRM shows only the person's
 * own companies' records. Jan (preset Client manager, scope `linked`) owns Acme. Per area: his company's records open,
 * a guessed id and another company's id are refused, lists hold only his rows; the owner and the switch off/report
 * keep today's answer (the parity test).
 */
import { describe, expect, it } from "vitest";
import { accessCompanyScope, accessGrantScope, isRefusal } from "@partnersinbiz/pib-plugin-kit";
import { canSeeRecord, visibleSets, type Viewer } from "../src/domain.js";
import { boot, CO, company, contact, deal, seed } from "./helpers/crm.js";
import type { Route, Store } from "./helpers/fake-db.js";

const OWNER = "user-owner";
const JAN = "user-jan";
const at = "2026-11-01T00:00:00Z";
const member = (userId: string, role: string) => ({
  id: `m-${userId}`, companyId: CO, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at,
});

/** `managedAccountIds` (the CRM's own-companies resolver) on the fake store. */
const MANAGED: Route = [/manager_user_ids @> jsonb_build_array/, (p, s) =>
  (s.companies ?? []).filter((row) => row.company_id === p[0] && (row.owner_user_id === p[1] || ((row.manager_user_ids as string[] | undefined) ?? []).includes(String(p[1])))).map((row) => ({ id: row.id }))];

/**
 * Acme (Jan's) with Ada; Globex (not his) with Grace and Gail; Ada also works at Globex; Kim is Jan's own contact with
 * no company (and shares Ada's address); Sipho Solo is nobody's. Foreign is another workspace's company.
 */
function store(): Store {
  const base = seed();
  return {
    ...base,
    companies: [
      company("acme", "Acme Plumbing", { domain: "acme.co.za", owner_user_id: JAN }),
      company("globex", "Globex", { domain: "globex.test" }),
      { ...company("foreign", "Foreign Co"), company_id: "co-2" },
    ],
    contacts: [
      contact("ada", "Ada Lovelace", { emails: ["ada@acme.co.za"], next_action_kind: "call", next_action_due_at: "2026-01-01T00:00:00Z" }),
      contact("grace", "Grace Hopper", { emails: ["grace@globex.test"], next_action_kind: "call", next_action_due_at: "2026-01-01T00:00:00Z" }),
      contact("gail", "Gail Globex", { emails: ["grace@globex.test"] }),
      contact("kim", "Kim Own", { emails: ["kim@own.test", "ada@acme.co.za"], owner_user_id: JAN }),
      contact("solo", "Sipho Solo", { emails: ["sipho@solo.test"], next_action_kind: "call", next_action_due_at: "2026-01-01T00:00:00Z" }),
    ],
    contact_companies: [
      { id: "l1", company_id: CO, contact_id: "ada", account_id: "acme", role_label: "owner", created_at: at },
      { id: "l2", company_id: CO, contact_id: "grace", account_id: "globex", role_label: "buyer", created_at: at },
      { id: "l3", company_id: CO, contact_id: "gail", account_id: "globex", role_label: "staff", created_at: at },
      { id: "l4", company_id: CO, contact_id: "ada", account_id: "globex", role_label: "advisor", created_at: at },
    ],
    deals: [
      deal("d-acme", "Acme SEO retainer", { account_id: "acme", contact_id: "ada" }),
      deal("d-globex", "Globex site", { account_id: "globex", contact_id: "grace" }),
      deal("d-kim", "Kim's job", { contact_id: "kim" }),
      deal("d-solo", "Solo website", { contact_id: "solo" }),
    ],
  };
}

async function world(mode: "off" | "report" | "enforce" | null) {
  const booted = await boot({ store: store(), routes: [MANAGED] });
  const { harness } = booted;
  harness.seed({ accessMembers: [member(OWNER, "owner"), member(JAN, "member")] as never });
  if (mode) await harness.ctx.state.set(accessCompanyScope(CO), { mode, rev: 1, userIds: [], receivedAt: new Date().toISOString() });
  await harness.ctx.state.set(accessGrantScope(CO, JAN), { preset: "clientManager" });
  const as = (userId: string) => ({ companyId: CO, actor: { type: "user" as const, userId } });
  const act = <T = Record<string, any>>(key: string, params: Record<string, unknown>, userId = JAN) => harness.performAction<T>(key, params, as(userId));
  /** A canvas card call: the host sends the acting person (Jan is limited by his grant, not a core-restricted member). */
  const card = <T = Record<string, any>>(key: string, params: Record<string, unknown>) =>
    harness.performAction<T>(key, params, { companyId: CO, actor: { type: "user" as const, userId: JAN, onBehalfOfUserId: JAN, onBehalfOfRestricted: false } } as never);
  /** An agent tool for the person (the host sends the acting person, H3). */
  const tool = async (name: string, params: Record<string, unknown>, userId = JAN) =>
    harness.executeTool<{ data?: Record<string, any>; error?: string }>(name, params, { companyId: CO, agentId: "agent-1", runId: "run-1", onBehalfOfUserId: userId, onBehalfOfRestricted: false });
  return { ...booted, act, tool, card };
}

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();

describe("stage B-2: a limited person on enforce sees only his companies' records", () => {
  it("crm.load: his company, its people, his own contact and their deals; a link to another company is not shown", async () => {
    const { act } = await world("enforce");
    const load = await act("crm.load", {});
    expect(isRefusal(load)).toBe(false);
    expect(ids(load.accounts)).toEqual(["acme"]);
    expect(ids(load.contacts)).toEqual(["ada", "kim"]);
    expect(ids(load.deals)).toEqual(["d-acme", "d-kim"]);
    expect(load.links.map((link: { id: string }) => link.id)).toEqual(["l1"]);
    expect(load.summary.companyCount).toBe(1);
    expect(load.hire).toBeNull();
  });

  it("crm.client-workspace: his company opens; another company, another workspace's and a guessed id do not", async () => {
    const { act } = await world("enforce");
    const acme = await act("crm.client-workspace", { kind: "company", id: "acme" });
    expect(acme.found).toBe(true);
    expect(ids(acme.contacts)).toEqual(["ada"]);
    expect(ids(acme.deals)).toEqual(["d-acme"]);
    expect(ids(acme.options.companies)).toEqual(["acme"]);
    const ada = await act("crm.client-workspace", { kind: "contact", id: "ada" });
    expect(ids(ada.companies)).toEqual(["acme"]);
    for (const ref of [{ kind: "company", id: "globex" }, { kind: "company", id: "foreign" }, { kind: "company", id: "guess-1" }, { kind: "contact", id: "grace" }, { kind: "contact", id: "solo" }]) {
      expect((await act("crm.client-workspace", ref)).found, ref.id).toBe(false);
    }
  });

  it("find-records (action and tool): only his rows, and a contact names only his companies", async () => {
    const { act, tool } = await world("enforce");
    expect((await act("crm.find-records", { query: "Globex" })).total).toBe(0);
    const found = await act("crm.find-records", { query: "a", limit: 50 });
    expect(found.results.map((row: { id: string }) => row.id).sort()).toEqual(["acme", "ada", "kim"]);
    expect(found.results.find((row: { id: string }) => row.id === "ada").companies).toEqual(["Acme Plumbing"]);
    expect((await tool("find-records", { query: "Grace" })).data?.total).toBe(0);
  });

  it("crm.desk and crm.call-list: due work on his records only", async () => {
    const { act } = await world("enforce");
    const desk = await act<{ items: Array<{ recordId: string }> }>("crm.desk", {});
    expect(desk.items.map((item) => item.recordId).sort()).toEqual(["ada"]);
    const calls = await act<{ items: Array<{ ref: string }> }>("crm.call-list", { scope: "all" });
    expect(calls.items.map((item) => item.ref)).toEqual(["contact:ada"]);
  });

  it("record tools: his company and contact open; another company's id and a guessed id are refused", async () => {
    const { tool } = await world("enforce");
    expect((await tool("get-company", { companyRecordId: "acme" })).data?.id).toBe("acme");
    expect((await tool("get-contact", { contactId: "kim" })).data?.id).toBe("kim");
    for (const id of ["globex", "foreign", "guess-1"]) expect((await tool("get-company", { companyRecordId: id })).error, id).toMatch(/not visible|not found/i);
    for (const id of ["grace", "solo", "guess-1"]) expect((await tool("get-contact", { contactId: id })).error, id).toMatch(/not visible|not found/i);
    expect((await tool("field-history", { recordType: "company", recordId: "globex" })).error).toBe("Company was not found");
    expect((await tool("list-deal-products", { dealId: "d-globex" })).error).toBe("Deal was not found");
    expect((await tool("list-deal-products", { dealId: "guess-1" })).error).toBe("Deal was not found");
    expect((await tool("field-history", { recordType: "company", recordId: "guess-1" })).error).toBe((await tool("field-history", { recordType: "company", recordId: "globex" })).error);
  });

  it("writes: his records change; another company's record and a guessed id are refused", async () => {
    const { act, store: rows } = await world("enforce");
    await expect(act("crm.update-contact", { contactId: "ada", name: "Ada King" })).resolves.toBeTruthy();
    expect(rows.contacts!.find((row) => row.id === "ada")!.name).toBe("Ada King");
    // Another company's id and a guessed id give the same text (stage B2: he cannot tell that an id exists elsewhere).
    const same = async (other: () => Promise<unknown>, guessed: () => Promise<unknown>, text: string) => {
      await expect(other()).rejects.toThrow(new RegExp(`^${text}$`));
      await expect(guessed()).rejects.toThrow(new RegExp(`^${text}$`));
    };
    await same(() => act("crm.update-contact", { contactId: "grace", name: "Hacked" }), () => act("crm.update-contact", { contactId: "guess-1", name: "Hacked" }), "Contact was not found");
    await same(() => act("crm.update-company", { companyRecordId: "globex", name: "Hacked" }), () => act("crm.update-company", { companyRecordId: "guess-1", name: "Hacked" }), "Company was not found");
    await same(() => act("crm.update-deal", { dealId: "d-globex", name: "Hacked" }), () => act("crm.update-deal", { dealId: "guess-1", name: "Hacked" }), "Deal was not found");
    await same(() => act("crm.move-deal", { dealId: "d-globex", stageId: "st-won" }), () => act("crm.move-deal", { dealId: "guess-1", stageId: "st-won" }), "Deal was not found");
    await same(() => act("crm.link-contact", { contactId: "kim", companyRecordId: "globex" }), () => act("crm.link-contact", { contactId: "kim", companyRecordId: "guess-1" }), "Company was not found");
    await same(() => act("crm.activities", { recordType: "contact", recordId: "solo" }), () => act("crm.activities", { recordType: "contact", recordId: "guess-1" }), "Contact was not found");
    expect(rows.contacts!.find((row) => row.id === "grace")!.name).toBe("Grace Hopper");
  });

  it("list-deals, export-contacts, find-duplicates and contact-graph: his rows and his companies' names only", async () => {
    const { tool } = await world("enforce");
    expect((await tool("list-deals", {})).data?.deals.map((row: { id: string }) => row.id).sort()).toEqual(["d-acme", "d-kim"]);
    expect((await tool("list-deals", { client: "company:globex" })).data?.total).toBe(0);
    const exported = (await tool("export-contacts", {})).data!;
    expect(exported.count).toBe(2);
    expect(exported.csv).not.toMatch(/Grace|Gail|Sipho|globex/);
    expect(exported.csv).toMatch(/company:acme/);
    const groups = (await tool("find-duplicates", {})).data!;
    expect(JSON.stringify(groups)).not.toMatch(/grace|gail/);
    expect(JSON.stringify(groups)).toMatch(/kim/);
    const graph = (await tool("contact-graph", { contactId: "ada" })).data!;
    expect(graph.companies.map((row: { id: string }) => row.id)).toEqual(["acme"]);
    expect((await tool("contact-graph", { contactId: "grace" })).error).toBe("Contact was not found");
    expect((await tool("contact-graph", { contactId: "guess-1" })).error).toBe("Contact was not found");
  });

  it("export-person-data and request-erasure: only a person wholly his; another company's person, a guessed id or a bare address are refused", async () => {
    const { tool } = await world("enforce");
    const kim = (await tool("export-person-data", { contactId: "kim" })).data!;
    expect(JSON.stringify(kim)).toMatch(/kim@own\.test/);
    for (const params of [{ contactId: "grace" }, { contactId: "guess-1" }, { email: "grace@globex.test" }, { email: "nobody@else.test" }]) {
      expect((await tool("export-person-data", params)).error, JSON.stringify(params)).toMatch(/not found/);
      expect((await tool("request-erasure", { ...params, evidence: "The person emailed us on 1 Nov from the address on file.", identityChecked: true })).error).toMatch(/not found/);
    }
  });

  it("canvas cards: his company resolves, another company's and a guessed id are hidden", async () => {
    const { card } = await world("enforce");
    const out = await card<{ cards: Array<{ id: string; hidden?: true }> }>("canvas.cards.resolve", {
      items: [{ type: "card-company", id: "acme" }, { type: "card-company", id: "globex" }, { type: "card-company", id: "foreign" }, { type: "card-company", id: "guess-1" }, { type: "card-contact", id: "grace" }],
    });
    expect(out, JSON.stringify(out)).toHaveProperty("cards");
    expect(out.cards.filter((card) => !card.hidden).map((card) => card.id)).toEqual(["acme"]);
  });

  it("company-wide areas stay closed to him: reports and settings", async () => {
    const { act, tool } = await world("enforce");
    expect(isRefusal(await act("crm.settings-status", {}))).toBe(true);
    expect((await tool("pipeline-forecast", {})).error).toBeTruthy();
  });
});

describe("stage B-2 parity: the owner on enforce, and everyone with the switch off or on report, get today's answer", () => {
  const view = (load: Record<string, any>) => ({ accounts: ids(load.accounts), contacts: ids(load.contacts), deals: ids(load.deals), links: load.links.length });

  it("the owner sees the whole workspace on enforce, the same as with the switch off", async () => {
    const enforce = await world("enforce");
    const off = await world(null);
    const a = await enforce.act("crm.load", {}, OWNER);
    const b = await off.act("crm.load", {}, OWNER);
    expect(view(a)).toEqual(view(b));
    expect(view(a).accounts).toEqual(["acme", "globex"]);
    expect((await enforce.tool("get-company", { companyRecordId: "globex" }, OWNER)).data?.id).toBe("globex");
  });

  it.each([null, "off", "report"] as const)("switch %s: Jan keeps today's member rule (only what he owns), no own-companies filter", async (mode) => {
    const { act, tool } = await world(mode);
    const load = await act("crm.load", {});
    expect(view(load)).toEqual({ accounts: ["acme"], contacts: ["kim"], deals: [], links: 0 });
    // Today's rule ignores the person's companies: Ada (at his company, not his) is not his.
    expect((await act("crm.client-workspace", { kind: "contact", id: "ada" })).found).toBe(false);
    // find-duplicates never filtered by visibility; it still does not.
    expect(JSON.stringify((await tool("find-duplicates", {})).data)).toMatch(/gail/);
  });
});

describe("the B-D3 rule (domain)", () => {
  const viewer = (extra: Partial<Viewer> = {}): Viewer => ({ companyId: CO, userId: JAN, agentId: "agent-1", role: "admin", ...extra });
  const row = { companyId: CO, ownerUserId: null, assigneeAgentId: "agent-1" };

  it("under linked, agent assignment, agent grants, workspace grants and the role do not open a record; his company, his ownership and a user share do", () => {
    const linked = viewer({ linkedCompanyIds: ["acme"] });
    expect(canSeeRecord(linked, row, [{ principalType: "agent", principalId: "agent-1" }, { principalType: "company", principalId: CO }])).toBe(false);
    expect(canSeeRecord(linked, row, [], ["acme"])).toBe(true);
    expect(canSeeRecord(linked, { ...row, ownerUserId: JAN }, [])).toBe(true);
    expect(canSeeRecord(linked, row, [{ principalType: "user", principalId: JAN }])).toBe(true);
    expect(canSeeRecord(linked, { ...row, companyId: "co-2" }, [], ["acme"])).toBe(false);
    expect(canSeeRecord(viewer({ linkedCompanyIds: [] }), row, [], ["acme"])).toBe(false);
  });

  it("scope all keeps today's rule", () => {
    expect(canSeeRecord(viewer(), row, [])).toBe(true);
    expect(canSeeRecord(viewer({ role: "member", agentId: null }), row, [{ principalType: "company", principalId: CO }])).toBe(true);
    expect(canSeeRecord(viewer({ role: "member", agentId: null, linkedCompanyIds: null }), row, [])).toBe(false);
  });

  it("a deal with no company follows its contact; a link to a company that is not his is dropped", () => {
    const none = new Map();
    const base = { companyId: CO, ownerUserId: null, assigneeAgentId: null };
    const sets = visibleSets(viewer({ role: "member", linkedCompanyIds: ["acme"] }), {
      accounts: [{ ...base, id: "acme" }, { ...base, id: "globex" }] as never,
      contacts: [{ ...base, id: "ada" }, { ...base, id: "grace" }] as never,
      deals: [{ ...base, id: "d1", accountId: null, contactId: "ada" }, { ...base, id: "d2", accountId: null, contactId: "grace" }, { ...base, id: "d3", accountId: "globex", contactId: "ada" }] as never,
      links: [{ id: "l1", companyId: CO, contactId: "ada", accountId: "acme", roleLabel: "" }, { id: "l2", companyId: CO, contactId: "ada", accountId: "globex", roleLabel: "" }, { id: "l3", companyId: CO, contactId: "grace", accountId: "globex", roleLabel: "" }],
    }, { company: none, contact: none, deal: none });
    expect(ids(sets.accounts)).toEqual(["acme"]);
    expect(ids(sets.contacts)).toEqual(["ada"]);
    expect(ids(sets.deals)).toEqual(["d1"]);
    expect(sets.links.map((link) => link.id)).toEqual(["l1"]);
  });
});

describe("PAR-15253: a limited person creates his own company under enforce", () => {
  const REFUSAL = "A company with this name or website is already in the CRM. Ask an owner or admin to add you to its Managed by.";
  const CANARY = "The canary flag can only be set by an owner or admin.";
  const row = (rows: Record<string, any[]>, id: string) => rows.companies.find((c) => c.id === id) as Record<string, any>;
  const snap = (rows: Record<string, any[]>) => JSON.stringify({ companies: rows.companies, activities: rows.activities ?? [], handoffs: rows.handoffs ?? [] });

  it("1 + 2a/2b: the action and the tool as him: owner = him, no managers, then it is his", async () => {
    const { act, tool, store: rows } = await world("enforce");
    const made = await act("crm.create-company", { name: "New Co" });
    expect(row(rows as any, made.id).owner_user_id).toBe(JAN);
    expect(row(rows as any, made.id).manager_user_ids ?? []).toEqual([]);
    expect(ids((await act("crm.load", {})).accounts)).toContain(made.id);
    expect((await tool("get-company", { companyRecordId: made.id })).data?.id).toBe(made.id);
    const viaTool = await tool("create-company", { name: "Tool Ltd" });
    expect(row(rows as any, viaTool.data!.id).owner_user_id).toBe(JAN);
    expect(row(rows as any, viaTool.data!.id).manager_user_ids ?? []).toEqual([]);
  });

  it("guard refuses a run it cannot look up (non-UUID harness ids; not proof of plan 2c)", async () => {
    const { harness, store: rows } = await world("enforce");
    (rows as any).heartbeat_runs = [{ id: "run-1", company_id: CO, agent_id: "agent-1", responsible_user_id: JAN }];
    const out = await harness.executeTool<{ data?: Record<string, any>; error?: string }>("create-company", { name: "Run Co" }, { companyId: CO, agentId: "agent-1", runId: "run-1" } as never);
    // The harness company id is not a UUID, so the guard's run lookup (acting-person.ts) answers "not found": the call is refused
    // before the handler and nothing is created. The handler's own run fallback (viewerFor) is the existing code the plan names.
    expect(out.error).toMatch(/Access refused/);
    expect((rows as any).companies.some((c: any) => c.name === "Run Co")).toBe(false);
  });

  it("4: a name match and a website match on another member's company: one fixed refusal, nothing written or emitted, one audit entry", async () => {
    const { act, tool, store: rows, emit, harness } = await world("enforce");
    const before = snap(rows as any);
    const count = (rows as any).companies.length;
    const answers: unknown[] = [];
    for (const params of [{ name: "globex", tags: ["x"], phone: "1" }, { name: "Other", domain: "globex.test", tags: ["x"], phone: "1" }]) {
      await expect(act("crm.create-company", params)).rejects.toThrow(new RegExp(`^${REFUSAL.replace(/[.]/g, "\\.")}$`));
      const viaTool = await tool("create-company", params);
      answers.push(viaTool);
      expect(viaTool).toMatchObject({ error: REFUSAL });
      expect(JSON.stringify(viaTool)).not.toMatch(/globex|matchedOn|owner_user|ownerUserId/i);
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(snap(rows as any)).toBe(before);
    expect((rows as any).companies.length).toBe(count);
    expect(emit).not.toHaveBeenCalledWith(expect.stringMatching(/company\.upserted/), expect.anything());
    const audits = harness.activity.filter((a) => a.message === "A limited person's company create matched a company that is not theirs");
    expect(audits).toHaveLength(4);
    expect(audits[0]).toMatchObject({ entityType: "crm_company", metadata: { userId: JAN, attemptedName: "globex" } });
    expect(audits[0]!.entityId).toBeUndefined();
  });

  it("5: mixed matches: his own company is taken even when another member's matches first", async () => {
    const { act, store: rows } = await world("enforce");
    (rows as any).companies.push(company("acme-dup", "Other Acme", { domain: "acme.co.za", created_at: "2025-01-01T00:00:00Z" }));
    const before = JSON.stringify(row(rows as any, "acme-dup"));
    const out = await act("crm.create-company", { name: "Acme Plumbing", domain: "acme.co.za", phone: "012" });
    expect(out.id).toBe("acme");
    expect(out.matched).toBe(true);
    expect(JSON.stringify(row(rows as any, "acme-dup"))).toBe(before);
  });

  it("6: a match on only his own company fills empty fields and returns it", async () => {
    const { act } = await world("enforce");
    const out = await act("crm.create-company", { name: "Acme Plumbing", phone: "012" });
    expect(out.matched).toBe(true);
    expect(out.id).toBe("acme");
    expect(out.filled).toContain("phone");
  });

  it("guard refuses a run with no person (not proof of plan 3; the handler line is untested)", async () => {
    const { harness, store: rows } = await world("enforce");
    (rows as any).heartbeat_runs = [{ id: "run-1", company_id: CO, agent_id: "agent-1", responsible_user_id: null }];
    const before = snap(rows as any);
    const out = await harness.executeTool<{ data?: Record<string, any>; error?: string }>("create-company", { name: "Nobody Co" }, { companyId: CO, agentId: "agent-1", runId: "run-1" } as never);
    // Guard level: no verifiable person, refused. The handler's own null-userId refusal under a linked decision is a second line
    // the harness cannot reach (the guard refuses first); it is read-checked in worker.ts createCompany.
    expect(out.error).toMatch(/Access refused/);
    expect(snap(rows as any)).toBe(before);
  });

  it("7: the canary flag is refused on create, on his own company's dedupe hit and on update-company; the owner may still set it", async () => {
    const { act, tool, store: rows } = await world("enforce");
    const flags = [{ custom: { canary: true } }, { custom: { canary: false } }, { tags: ["Canary"] }];
    // On update, a key inside `custom` that is a column overwrites the column: the check runs on the built patch.
    const updateOnly = [...flags, { custom: { tags: ["Canary"] } }];
    const before = snap(rows as any);
    for (const flag of flags) {
      await expect(act("crm.create-company", { name: "Flag Co", ...flag })).rejects.toThrow(CANARY);
      await expect(act("crm.create-company", { name: "Acme Plumbing", ...flag })).rejects.toThrow(CANARY);
    }
    for (const flag of updateOnly) {
      await expect(act("crm.update-company", { companyRecordId: "acme", ...flag })).rejects.toThrow(CANARY);
      expect((await tool("update-company", { companyRecordId: "acme", ...flag })).error).toBe(CANARY);
    }
    expect(snap(rows as any)).toBe(before);
    const ok = await act("crm.create-company", { name: "Owner Flag Co", custom: { canary: true } }, OWNER);
    expect(row(rows as any, ok.id).custom.canary).toBe(true);
  });

  it("7b: the canary custom key is refused on his own deal and contact, on the action and the tool", async () => {
    const { act, tool, store: rows } = await world("enforce");
    const before = snap(rows as any) + JSON.stringify([(rows as any).deals, (rows as any).contacts]);
    for (const custom of [{ canary: true }, { canary: false }]) {
      await expect(act("crm.update-deal", { dealId: "d-acme", custom })).rejects.toThrow(CANARY);
      await expect(act("crm.update-contact", { contactId: "ada", custom })).rejects.toThrow(CANARY);
      expect((await tool("update-deal", { dealId: "d-acme", custom })).error).toBe(CANARY);
      expect((await tool("update-contact", { contactId: "ada", custom })).error).toBe(CANARY);
    }
    expect(snap(rows as any) + JSON.stringify([(rows as any).deals, (rows as any).contacts])).toBe(before);
    expect((await act("crm.update-deal", { dealId: "d-acme", custom: { note: "x" } })).id).toBe("d-acme");
  });

  it("8: owner on enforce keeps today's match on any company", async () => {
    const { act } = await world("enforce");
    const out = await act("crm.create-company", { name: "Globex" }, OWNER);
    expect(out.matched).toBe(true);
    expect(out.id).toBe("globex");
  });

  it.each([null, "off", "report"] as const)("8: switch %s: today's answer, a match on another's company still matches", async (mode) => {
    const { act } = await world(mode);
    const out = await act("crm.create-company", { name: "Globex" }, OWNER);
    expect(out.matched).toBe(true);
  });
});
