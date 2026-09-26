import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { COCKPIT_ROUTE, trackJob, type CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { cockpitSnapshot } from "../src/cockpit.js";

const CO = "co-1";

type Link = { id: string; company_a_id: string; company_b_id: string; accepted_a: boolean; accepted_b: boolean; status: string; created_at: string };
type Grant = { id: string; record_type: string; record_id: string; source_company_id: string; grantee_company_id: string; status: string; created_at: string };

function fakeDb(links: Link[], grants: Grant[], options: { failGrants?: boolean } = {}) {
  const mine = (l: Link) => l.company_a_id === CO || l.company_b_id === CO;
  return {
    namespace: NAMESPACE,
    async query(sql: string, params: unknown[] = []) {
      if (options.failGrants && sql.includes(`${NAMESPACE}.grants`)) throw new Error("boom");
      if (sql.includes("AS links") && sql.includes("AS grants")) {
        return [{
          links: String(links.filter((l) => l.status === "active" && mine(l)).length),
          grants: String(grants.filter((g) => g.status === "active" && (g.source_company_id === CO || g.grantee_company_id === CO)).length),
        }];
      }
      if (sql.includes(`${NAMESPACE}.links`) && sql.includes("status = 'pending'")) {
        return links.filter((l) => l.status === "pending" && ((l.company_a_id === params[0] && !l.accepted_a) || (l.company_b_id === params[0] && !l.accepted_b)));
      }
      if (sql.includes(`${NAMESPACE}.grants`) && sql.includes("status = 'proposed'")) {
        return grants.filter((g) => g.status === "proposed" && g.source_company_id === params[0]);
      }
      if (sql.includes(`${NAMESPACE}.links`) && sql.includes("ORDER BY created_at DESC")) return links.filter(mine);
      if (sql.includes(`${NAMESPACE}.grants`) && sql.includes("ORDER BY created_at DESC")) return grants.filter((g) => g.source_company_id === params[0]);
      if (sql.includes(`${NAMESPACE}.links`)) return links.map((l) => ({ company_a_id: l.company_a_id, company_b_id: l.company_b_id }));
      return [];
    },
    async execute() {
      return { rowCount: 0 };
    },
  };
}

async function boot(options: { config?: Record<string, unknown>; links?: Link[]; grants?: Grant[]; failGrants?: boolean } = {}) {
  const harness = createTestHarness({ manifest, config: options.config ?? { requireOwnerForGrants: true } });
  (harness.ctx as unknown as { db: ReturnType<typeof fakeDb> }).db = fakeDb(options.links ?? [], options.grants ?? [], options);
  await plugin.definition.setup(harness.ctx);
  const emit = vi.spyOn(harness.ctx.events, "emit");
  return { harness, emit };
}

const links: Link[] = [
  { id: "l1", company_a_id: CO, company_b_id: "co-2", accepted_a: true, accepted_b: true, status: "active", created_at: "2026-09-01T10:00:00Z" },
  { id: "l2", company_a_id: "co-0", company_b_id: CO, accepted_a: true, accepted_b: false, status: "pending", created_at: "2026-09-20T10:00:00Z" },
];
const grants: Grant[] = [
  { id: "g1", record_type: "contact", record_id: "c1", source_company_id: CO, grantee_company_id: "co-2", status: "active", created_at: "2026-09-02T10:00:00Z" },
  { id: "g2", record_type: "deal", record_id: "d1", source_company_id: CO, grantee_company_id: "co-2", status: "proposed", created_at: "2026-09-21T10:00:00Z" },
];

describe("Partners cockpit", () => {
  it("declares the cockpit route", () => {
    expect(manifest.apiRoutes).toContainEqual(expect.objectContaining({ routeKey: COCKPIT_ROUTE.routeKey, path: "/cockpit" }));
  });

  it("empty company: zero KPIs, nothing waiting, job not run yet", async () => {
    const { harness } = await boot();
    const snap = await cockpitSnapshot(harness.ctx, CO);
    expect(snap).toMatchObject({ plugin: "partnersinbiz.partners", title: "Partners", waiting: [], activity: [] });
    expect(snap.kpis.map((k) => [k.key, k.raw])).toEqual([["partner_links", 0], ["partner_grants", 0]]);
    expect(snap.health).toEqual([expect.objectContaining({ key: "job:setup-status", status: "ok", detail: "Has not run yet." })]);
  });

  it("counts active links and grants, lists pending proposals as waiting, and recent activity", async () => {
    const { harness } = await boot({ links, grants });
    const snap = await cockpitSnapshot(harness.ctx, CO);
    expect(snap.kpis.find((k) => k.key === "partner_links")?.raw).toBe(1);
    expect(snap.kpis.find((k) => k.key === "partner_grants")?.raw).toBe(1);
    expect(snap.waiting.map((w) => w.key)).toEqual(["partners:link:l2", "partners:grant:g2"]);
    expect(snap.waiting.every((w) => w.kind === "grant" && w.why.length > 0)).toBe(true);
    expect(snap.activity[0]?.text).toBe("Proposed sharing deal d1 with co-2");
    expect(snap.activity.length).toBe(4);
  });

  it("one failing query does not break the snapshot", async () => {
    const { harness } = await boot({ links, grants, failGrants: true });
    const snap = await cockpitSnapshot(harness.ctx, CO);
    expect(snap.kpis).toEqual([]);
    expect(snap.waiting).toEqual([]);
    expect(snap.health.length).toBe(1);
  });

  it("job health turns bad after repeated failures", async () => {
    const { harness } = await boot();
    for (let i = 0; i < 3; i += 1) await trackJob(harness.ctx, "setup-status", async () => { throw new Error("down"); }).catch(() => undefined);
    const snap = await cockpitSnapshot(harness.ctx, CO);
    expect(snap.health[0]).toMatchObject({ status: "bad", detail: "Last error: down" });
  });

  it("serves GET /cockpit and pushes the snapshot hourly for saved companies", async () => {
    const { harness, emit } = await boot({ links, grants });
    const response = await plugin.definition.onApiRequest!({
      routeKey: "cockpit", method: "GET", path: "/cockpit", params: {}, query: { companyId: CO }, body: null,
      actor: { actorType: "user", actorId: "local-board", userId: "local-board" }, companyId: CO, headers: {},
    });
    expect(response.status).toBe(200);
    expect((response.body as CockpitSnapshot).plugin).toBe("partnersinbiz.partners");
    await harness.runJob("setup-status");
    expect(emit).toHaveBeenCalledWith("cockpit.snapshot", CO, expect.objectContaining({ plugin: "partnersinbiz.partners" }));
  });

  it("skips the push when settings were never saved", async () => {
    const { harness, emit } = await boot({ config: {}, links, grants });
    await harness.runJob("setup-status");
    expect(emit).not.toHaveBeenCalledWith("cockpit.snapshot", expect.anything(), expect.anything());
  });
});
