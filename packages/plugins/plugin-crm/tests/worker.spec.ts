import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { CRM_MUTATIONS } from "../src/sync.js";

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

const CO = "co-1";
const OWNER = { type: "user" as const, userId: "local-board" };

/**
 * A small in-memory stand-in for the CRM namespace. It understands the
 * statement shapes the worker issues: by-id lookups, per-company lists,
 * generic INSERT (column list) and UPDATE (SET col = $n) statements.
 */
function fakeDb(store: Store) {
  const tableOf = (sql: string) => new RegExp(`(?:FROM|INTO|UPDATE)\\s+${NAMESPACE}\\.(\\w+)`).exec(sql)?.[1] ?? "";
  const rowsOf = (name: string) => (store[name] ??= []);
  return {
    namespace: NAMESPACE,
    async query(sql: string, params: unknown[] = []) {
      if (/\bUNION\b/.test(sql)) {
        const ids = new Set([...rowsOf("companies"), ...rowsOf("contacts")].map((row) => row.company_id));
        return [...ids].map((company_id) => ({ company_id }));
      }
      const name = tableOf(sql);
      const rows = rowsOf(name);
      if (/WHERE id = \$1/.test(sql)) return rows.filter((row) => row.id === params[0]);
      if (name === "record_grants") return [];
      if (name === "pipeline_stages") {
        return rows.filter((row) => row.pipeline_id === params[0]).sort((a, b) => Number(a.position) - Number(b.position));
      }
      if (name === "activities") {
        return rows.filter((row) => row.record_type === params[0] && row.record_id === params[1]);
      }
      const inCompany = rows.filter((row) => row.company_id === params[0]);
      if (name === "contacts" && /LEFT JOIN/.test(sql)) {
        return inCompany.map((row) => ({
          ...row,
          account_ids: rowsOf("contact_companies").filter((link) => link.contact_id === row.id).map((link) => link.account_id),
        }));
      }
      return inCompany;
    },
    async execute(sql: string, params: unknown[] = []) {
      const name = tableOf(sql);
      if (/^\s*INSERT/.test(sql)) {
        const columns = /\(([^)]+)\)\s*VALUES/.exec(sql)![1]!.split(",").map((column) => column.trim());
        rowsOf(name).push(Object.fromEntries(columns.map((column, index) => [column, params[index]])));
        return { rowCount: 1 };
      }
      if (/^\s*UPDATE/.test(sql) && /WHERE id = \$1/.test(sql)) {
        const row = rowsOf(name).find((item) => item.id === params[0]);
        if (!row) return { rowCount: 0 };
        const set = /SET\s+([\s\S]+?)\s+WHERE/.exec(sql)![1]!;
        for (const part of set.split(",")) {
          const bound = /(\w+)\s*=\s*\$(\d+)/.exec(part);
          if (bound) row[bound[1]!] = params[Number(bound[2]) - 1];
          else if (/(\w+)\s*=\s*now\(\)/.test(part)) row[/(\w+)/.exec(part)![1]!] = new Date().toISOString();
        }
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    },
  };
}

function seedStore(): Store {
  const company = (id: string, name: string, extra: Row = {}): Row => ({
    id,
    company_id: CO,
    name,
    domain: null,
    lifecycle: "lead",
    currency: "ZAR",
    custom: {},
    human_owned_fields: [],
    owner_user_id: null,
    assignee_agent_id: null,
    tags: [],
    updated_at: "2026-09-26T05:00:00Z",
    ...extra,
  });
  const contact = (id: string, name: string, extra: Row = {}): Row => ({
    id,
    company_id: CO,
    name,
    emails: [],
    phones: [],
    lifecycle: "lead",
    custom: {},
    human_owned_fields: [],
    owner_user_id: null,
    assignee_agent_id: null,
    tags: [],
    next_action_kind: null,
    next_action_due_at: null,
    updated_at: "2026-09-26T05:00:00Z",
    ...extra,
  });
  const deal = (id: string, title: string, extra: Row): Row => ({
    id,
    company_id: CO,
    pipeline_id: "pipe-1",
    stage_id: "stage-open",
    account_id: null,
    contact_id: null,
    title,
    amount_minor: 1000,
    currency: "ZAR",
    owner_user_id: null,
    assignee_agent_id: null,
    tags: [],
    next_action_kind: null,
    next_action_due_at: null,
    custom: {},
    human_owned_fields: [],
    ...extra,
  });
  return {
    companies: [
      company("acme", "Acme", { domain: "acme.test", lifecycle: "customer" }),
      company("globex", "Globex"),
      // Another Paperclip company's record: never visible here.
      { ...company("foreign", "Foreign Co"), company_id: "co-2" },
    ],
    contacts: [
      contact("ada", "Ada Lovelace", { emails: ["ada@acme.test"] }),
      contact("grace", "Grace Hopper"),
      contact("solo", "Sole Trader", { emails: ["solo@trader.test"], lifecycle: "customer" }),
    ],
    contact_companies: [
      { id: "l1", company_id: CO, contact_id: "ada", account_id: "acme", role_label: "buyer" },
      { id: "l2", company_id: CO, contact_id: "grace", account_id: "acme", role_label: "staff" },
      { id: "l3", company_id: CO, contact_id: "ada", account_id: "globex", role_label: "advisor" },
    ],
    pipelines: [{ id: "pipe-1", company_id: CO, name: "Sales" }],
    pipeline_stages: [
      { id: "stage-open", company_id: CO, pipeline_id: "pipe-1", name: "Lead", kind: "open", position: 1 },
      { id: "stage-won", company_id: CO, pipeline_id: "pipe-1", name: "Won", kind: "won", position: 2 },
    ],
    deals: [
      deal("d-acme", "Acme retainer", { account_id: "acme", stage_id: "stage-won" }),
      deal("d-ada", "Ada side project", { contact_id: "ada" }),
      deal("d-solo", "Solo website", { contact_id: "solo" }),
      deal("d-globex", "Globex audit", { account_id: "globex", contact_id: "ada" }),
    ],
    sequences: [{ id: "seq-1", company_id: CO, name: "Intro", completion_mode: "manual" }],
    activities: [
      { id: "a1", company_id: CO, record_type: "company", record_id: "acme", kind: "note", body: "Kickoff booked", issue_id: null, created_at: "2026-09-25T10:00:00Z" },
      { id: "a2", company_id: CO, record_type: "contact", record_id: "solo", kind: "call", body: "Wants a quote", issue_id: null, created_at: "2026-09-25T11:00:00Z" },
    ],
    facts: [],
    record_grants: [],
  };
}

async function boot() {
  const store = seedStore();
  const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg" } });
  harness.seed({ companies: [{ id: CO, issuePrefix: "PIB", name: "PiB" } as never] });
  (harness.ctx as unknown as { db: ReturnType<typeof fakeDb> }).db = fakeDb(store);
  await plugin.definition.setup(harness.ctx);
  const emit = vi.spyOn(harness.ctx.events, "emit");
  return { harness, store, emit };
}

describe("client workspace actions", () => {
  it("counts the new update actions as CRM mutations", () => {
    expect(CRM_MUTATIONS.has("crm.update-company")).toBe(true);
    expect(CRM_MUTATIONS.has("crm.update-contact")).toBe(true);
  });

  it("crm.update-company saves the patch, records facts, and emits the change", async () => {
    const { harness, store, emit } = await boot();
    const result = await harness.performAction<{ name: string; domain: string | null; lifecycle: string; tags: string[]; refused: string[] }>(
      "crm.update-company",
      { companyRecordId: "globex", name: " Globex Corp ", domain: "globex.test", lifecycle: "prospect", tags: ["priority"] },
      { companyId: CO, actor: OWNER },
    );
    expect(result).toMatchObject({ name: "Globex Corp", domain: "globex.test", lifecycle: "prospect", tags: ["priority"], refused: [] });
    const row = store.companies!.find((item) => item.id === "globex")!;
    expect(row.name).toBe("Globex Corp");
    expect(row.lifecycle).toBe("prospect");
    expect(store.facts!.map((fact) => fact.field_key).sort()).toEqual(["domain", "lifecycle", "name", "tags"]);
    expect(store.facts!.every((fact) => fact.source === "human")).toBe(true);
    expect(emit).toHaveBeenCalledWith("company.upserted", CO, expect.objectContaining({ id: "globex", name: "Globex Corp", lifecycle: "prospect" }));
  });

  it("crm.update-company clears an emptied domain and rejects a bad lifecycle", async () => {
    const { harness, store } = await boot();
    await harness.performAction("crm.update-company", { companyRecordId: "acme", domain: "" }, { companyId: CO, actor: OWNER });
    expect(store.companies!.find((item) => item.id === "acme")!.domain).toBeNull();
    await expect(
      harness.performAction("crm.update-company", { companyRecordId: "acme", lifecycle: "vip" }, { companyId: CO, actor: OWNER }),
    ).rejects.toThrow(/Lifecycle/);
  });

  it("crm.update-contact saves emails, lifecycle and next action, and emits with company links", async () => {
    const { harness, store, emit } = await boot();
    const result = await harness.performAction<{ emails: string[]; lifecycle: string; nextActionKind: string | null }>(
      "crm.update-contact",
      { contactId: "ada", emails: ["ada@acme.test", "ada@home.test"], lifecycle: "customer", nextActionKind: "call", nextActionDueAt: "2026-10-01" },
      { companyId: CO, actor: OWNER },
    );
    expect(result).toMatchObject({ emails: ["ada@acme.test", "ada@home.test"], lifecycle: "customer", nextActionKind: "call" });
    const row = store.contacts!.find((item) => item.id === "ada")!;
    expect(JSON.parse(String(row.emails))).toEqual(["ada@acme.test", "ada@home.test"]);
    expect(emit).toHaveBeenCalledWith(
      "contact.upserted",
      CO,
      expect.objectContaining({ id: "ada", lifecycle: "customer", accountIds: ["acme", "globex"] }),
    );
  });

  it("crm.update-contact refuses an empty name", async () => {
    const { harness } = await boot();
    await expect(
      harness.performAction("crm.update-contact", { contactId: "ada", name: "  " }, { companyId: CO, actor: OWNER }),
    ).rejects.toThrow(/name is required/);
  });

  it("crm.client-workspace loads a company with its people, deals and activity", async () => {
    const { harness } = await boot();
    const ws = await harness.performAction<Record<string, any>>("crm.client-workspace", { kind: "company", id: "acme" }, { companyId: CO, actor: OWNER });
    expect(ws.found).toBe(true);
    expect(ws.kind).toBe("company");
    expect(ws.company).toMatchObject({ id: "acme", name: "Acme", domain: "acme.test", lifecycle: "customer" });
    expect(ws.contact).toBeNull();
    expect(ws.contacts).toEqual([
      { id: "ada", name: "Ada Lovelace", emails: ["ada@acme.test"], lifecycle: "lead", roleLabel: "buyer" },
      { id: "grace", name: "Grace Hopper", emails: [], lifecycle: "lead", roleLabel: "staff" },
    ]);
    expect(ws.companies).toEqual([]);
    // Its own deal, plus a linked person's deal with no company set; not Globex's deal with Ada.
    expect(ws.deals.map((deal: { id: string }) => deal.id).sort()).toEqual(["d-acme", "d-ada"]);
    expect(ws.deals.find((deal: { id: string }) => deal.id === "d-acme")).toMatchObject({ stageName: "Won", stageKind: "won" });
    expect(ws.activities.map((item: { body: string }) => item.body)).toEqual(["Kickoff booked"]);
    expect(ws.stages.map((stage: { id: string }) => stage.id)).toEqual(["stage-open", "stage-won"]);
    expect(ws.sequences).toEqual([{ id: "seq-1", name: "Intro", completionMode: "manual" }]);
    expect(ws.options.companies.map((row: { id: string }) => row.id)).toEqual(["acme", "globex"]);
    expect(ws.options.contacts).toHaveLength(3);
  });

  it("crm.client-workspace loads a contact with its companies and deals", async () => {
    const { harness } = await boot();
    const ada = await harness.performAction<Record<string, any>>("crm.client-workspace", { client: "contact:ada" }, { companyId: CO, actor: OWNER });
    expect(ada.found).toBe(true);
    expect(ada.contact).toMatchObject({ id: "ada", name: "Ada Lovelace" });
    expect(ada.company).toBeNull();
    expect(ada.companies).toEqual([
      { id: "acme", name: "Acme", domain: "acme.test", lifecycle: "customer", roleLabel: "buyer" },
      { id: "globex", name: "Globex", domain: null, lifecycle: "lead", roleLabel: "advisor" },
    ]);
    expect(ada.deals.map((deal: { id: string }) => deal.id).sort()).toEqual(["d-ada", "d-globex"]);

    const solo = await harness.performAction<Record<string, any>>("crm.client-workspace", { client: { kind: "contact", id: "solo" } }, { companyId: CO, actor: OWNER });
    expect(solo.companies).toEqual([]);
    expect(solo.deals.map((deal: { id: string }) => deal.id)).toEqual(["d-solo"]);
    expect(solo.activities.map((item: { kind: string }) => item.kind)).toEqual(["call"]);
  });

  it("crm.client-workspace returns found: false for an unknown or foreign id", async () => {
    const { harness } = await boot();
    await expect(
      harness.performAction("crm.client-workspace", { kind: "company", id: "nope" }, { companyId: CO, actor: OWNER }),
    ).resolves.toEqual({ kind: "company", id: "nope", found: false });
    await expect(
      harness.performAction("crm.client-workspace", { kind: "company", id: "foreign" }, { companyId: CO, actor: OWNER }),
    ).resolves.toMatchObject({ found: false });
    // A company id asked for as a contact is not found either.
    await expect(
      harness.performAction("crm.client-workspace", { kind: "contact", id: "acme" }, { companyId: CO, actor: OWNER }),
    ).resolves.toMatchObject({ found: false });
  });

  it("crm.client-workspace needs a kind and an id", async () => {
    const { harness } = await boot();
    await expect(
      harness.performAction("crm.client-workspace", { kind: "deal", id: "d-acme" }, { companyId: CO, actor: OWNER }),
    ).rejects.toThrow(/kind \(company or contact\) and id are required/);
    await expect(
      harness.performAction("crm.client-workspace", {}, { companyId: CO, actor: OWNER }),
    ).rejects.toThrow(/required/);
  });
});
