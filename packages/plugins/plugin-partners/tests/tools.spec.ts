import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { PARTNER_SHARE_SKILL, SKILLS } from "../src/skills.js";
import { PARTNER_TOOLS } from "../src/tools.js";
import { createFakeDb, type Route, type Row, type Store } from "./helpers/fake-db.js";

const CO = "co-1";
type Schema = { description?: string; enum?: unknown[]; properties?: Record<string, Schema> };

/** The two OR reads the generic fake db leaves to a route. */
const newestFirst = (a: Row, b: Row) => (String(a.created_at) < String(b.created_at) ? 1 : -1);
const ROUTES: Route[] = [
  [/FROM \S+\.links\s+WHERE company_a_id = \$1 OR company_b_id = \$1/, (p, s) => (s.links ?? []).filter((l) => l.company_a_id === p[0] || l.company_b_id === p[0]).sort(newestFirst)],
  [/FROM \S+\.grants\s+WHERE source_company_id = \$1 OR grantee_company_id = \$1/, (p, s) => (s.grants ?? []).filter((g) => g.source_company_id === p[0] || g.grantee_company_id === p[0]).sort(newestFirst)],
];

async function boot(store: Store) {
  const harness = createTestHarness({ manifest, config: { requireOwnerForGrants: true } });
  harness.seed({ companies: [{ id: CO, name: "Partners in Biz" } as never, { id: "co-2", name: "Saaiman Stays" } as never, { id: "co-3", name: "Acme" } as never] });
  (harness.ctx as unknown as { db: unknown }).db = createFakeDb(store, { namespace: NAMESPACE, routes: ROUTES });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

function store(): Store {
  return {
    links: [
      { id: "l-active", company_a_id: CO, company_b_id: "co-2", accepted_a: true, accepted_b: true, status: "active", created_at: "2026-09-01T10:00:00Z" },
      { id: "l-mine", company_a_id: CO, company_b_id: "co-3", accepted_a: true, accepted_b: false, status: "pending", created_at: "2026-09-10T10:00:00Z" },
      { id: "l-theirs", company_a_id: "co-0", company_b_id: CO, accepted_a: true, accepted_b: false, status: "pending", created_at: "2026-09-20T10:00:00Z" },
      { id: "l-other", company_a_id: "co-8", company_b_id: "co-9", accepted_a: true, accepted_b: true, status: "active", created_at: "2026-09-20T10:00:00Z" },
    ],
    grants: [
      { id: "g-out", link_id: "l-active", record_type: "company", record_id: "crm-1", source_company_id: CO, grantee_company_id: "co-2", status: "active", created_at: "2026-09-02T10:00:00Z" },
      { id: "g-in", link_id: "l-active", record_type: "invoice", record_id: "inv-9", source_company_id: "co-2", grantee_company_id: CO, status: "proposed", created_at: "2026-09-03T10:00:00Z" },
      { id: "g-gone", link_id: "l-active", record_type: "deal", record_id: "deal-1", source_company_id: CO, grantee_company_id: "co-2", status: "revoked", created_at: "2026-09-04T10:00:00Z" },
    ],
  };
}

const run = { companyId: CO, agentId: "agent-am" };

describe("Partners tool surface", () => {
  it("describes every parameter and uses enums where values are fixed", () => {
    const missing: string[] = [];
    for (const tool of PARTNER_TOOLS) {
      for (const [name, schema] of Object.entries((tool.parametersSchema as Schema).properties ?? {})) if (!schema.description?.trim()) missing.push(`${tool.name}.${name}`);
    }
    expect(missing).toEqual([]);
    const props = (name: string) => (PARTNER_TOOLS.find((t) => t.name === name)!.parametersSchema as Schema).properties!;
    expect(props("propose-grant").recordType!.enum).toEqual(["contact", "company", "deal", "invoice"]);
    expect(props("list-grants").direction!.enum).toEqual(["outgoing", "incoming"]);
    expect(props("list-grants").status!.enum).toEqual(["proposed", "active", "revoked"]);
    expect(props("list-links").status!.enum).toEqual(["pending", "active"]);
    expect(PARTNER_TOOLS.map((t) => t.name)).toEqual(["list-links", "list-grants", "propose-link", "propose-grant", "revoke-grant"]);
  });

  it("the skill names every tool and the approval rule", () => {
    for (const tool of PARTNER_TOOLS) expect(PARTNER_SHARE_SKILL, tool.name).toContain(`\`${tool.name}\``);
    expect(PARTNER_SHARE_SKILL).toMatch(/A person at our company accepts the grant/);
    expect(PARTNER_SHARE_SKILL).toMatch(/Never share the whole book/);
    expect(SKILLS[0]!.markdown).toContain("## Asking a person");
  });
});

describe("list-links", () => {
  it("lists this company's links with the other company's name and who still has to accept", async () => {
    const harness = await boot(store());
    const result = await harness.executeTool<{ data: { links: Array<Record<string, unknown>> } }>("list-links", {}, run);
    expect(result.data.links.map((l) => l.linkId)).toEqual(["l-theirs", "l-mine", "l-active"]);
    expect(result.data.links.find((l) => l.linkId === "l-active")).toMatchObject({ otherCompanyId: "co-2", status: "active", next: expect.stringMatching(/propose-grant/) });
    expect(result.data.links.find((l) => l.linkId === "l-mine")).toMatchObject({ acceptedByUs: true, acceptedByThem: false, next: "Waiting for the other company to accept." });
    expect(result.data.links.find((l) => l.linkId === "l-theirs")).toMatchObject({ acceptedByUs: false, next: expect.stringMatching(/A person here accepts it/) });
    const active = await harness.executeTool<{ data: { links: unknown[] } }>("list-links", { status: "active" }, run);
    expect(active.data.links).toHaveLength(1);
    const bad = await harness.executeTool<{ error?: string }>("list-links", { status: "maybe" }, run);
    expect(bad.error).toMatch(/status must be pending or active/);
  });
});

describe("list-grants", () => {
  it("splits outgoing and incoming grants and filters by status and type", async () => {
    const harness = await boot(store());
    const all = await harness.executeTool<{ data: { grants: Array<Record<string, unknown>> } }>("list-grants", {}, run);
    expect(all.data.grants.map((g) => [g.grantId, g.direction, g.status])).toEqual([
      ["g-gone", "outgoing", "revoked"],
      ["g-in", "incoming", "proposed"],
      ["g-out", "outgoing", "active"],
    ]);
    expect(all.data.grants.find((g) => g.grantId === "g-out")).toMatchObject({ record: "company:crm-1", otherCompanyId: "co-2", next: expect.stringMatching(/revoke-grant/) });
    expect(all.data.grants.find((g) => g.grantId === "g-in")).toMatchObject({ record: null, next: "Waiting for the owner company to accept." });
    const incoming = await harness.executeTool<{ data: { grants: unknown[] } }>("list-grants", { direction: "incoming" }, run);
    expect(incoming.data.grants).toHaveLength(1);
    const deals = await harness.executeTool<{ data: { grants: unknown[] } }>("list-grants", { recordType: "deal", status: "revoked" }, run);
    expect(deals.data.grants).toHaveLength(1);
  });
});

describe("propose-grant", () => {
  it("returns the real grant: a revoked record is proposed again, an active one says so", async () => {
    const s = store();
    const harness = await boot(s);
    const again = await harness.executeTool<{ data: Record<string, unknown> }>("propose-grant", { linkId: "l-active", recordType: "deal", recordId: "deal-1", granteeCompanyId: "co-2" }, run);
    expect(again.data).toMatchObject({ grantId: "g-gone", status: "proposed", next: expect.stringMatching(/A person at this company accepts it/) });
    expect(s.grants!.find((g) => g.id === "g-gone")!.status).toBe("proposed");
    const active = await harness.executeTool<{ data: Record<string, unknown>; content: string }>("propose-grant", { linkId: "l-active", recordType: "company", recordId: "crm-1", granteeCompanyId: "co-2" }, run);
    expect(active.content).toBe("Already shared");
    expect(active.data).toMatchObject({ grantId: "g-out", status: "active" });
    const fresh = await harness.executeTool<{ data: Record<string, unknown> }>("propose-grant", { linkId: "l-active", recordType: "contact", recordId: "ct-7", granteeCompanyId: "co-2" }, run);
    expect(fresh.data).toMatchObject({ recordType: "contact", status: "proposed", copiedRecord: null });
    expect(s.grants).toHaveLength(4);
    const pending = await harness.executeTool<{ error?: string }>("propose-grant", { linkId: "l-mine", recordType: "contact", recordId: "ct-7", granteeCompanyId: "co-3" }, run);
    expect(pending.error).toMatch(/Both companies must accept the link/);
  });
});

describe("partners.load (the page)", () => {
  it("returns ISO times and the name of every company on a link or grant, even ones the person is not a member of", async () => {
    const s = store();
    s.links!.push({ id: "l-pg", company_a_id: CO, company_b_id: "co-4", accepted_a: true, accepted_b: false, status: "pending", created_at: "2026-09-25 17:09:53.964502+02" });
    const harness = await boot(s);
    const page = await harness.performAction<{ links: Array<Record<string, unknown>>; grants: Array<Record<string, unknown>>; companies: Array<{ id: string; name: string }> }>(
      "partners.load", {}, { companyId: CO, actor: { type: "user", userId: "u-1" } },
    );
    expect(page.links.find((l) => l.id === "l-pg")!.created_at).toBe("2026-09-25T15:09:53.964Z");
    expect(page.grants.every((g) => typeof g.created_at === "string" && String(g.created_at).endsWith("Z"))).toBe(true);
    // co-0 and co-4 are unknown to the host: the page falls back to "Partner company", never an id.
    expect(page.companies.map((c) => [c.id, c.name]).sort()).toEqual([["co-1", "Partners in Biz"], ["co-2", "Saaiman Stays"], ["co-3", "Acme"]]);
  });
});
