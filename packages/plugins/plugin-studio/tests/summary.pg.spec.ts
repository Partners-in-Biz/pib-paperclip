import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { currentPeriod, setCap } from "../src/ledger.js";
import { clientSummaries } from "../src/summary.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER_CO = "22222222-2222-4222-8222-222222222222";
const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

describe.skipIf(!available)("client summaries against real Postgres", () => {
  const T = (name: string) => `${pg.db.namespace}.${name}`;
  const ctx = () => ({ db: pg.db }) as unknown as PluginContext;

  async function asset(id: string, client: string | null, status: string, company = CO, at = "2026-11-01T10:00:00Z") {
    await pg.client.query(
      `INSERT INTO ${T("assets")} (id, company_id, client_kind, client_ref, name, kind, status, source, created_at) VALUES ($1, $2, $3, $4, $5, 'image', $6, 'generated', $7)`,
      [id, company, client ? "company" : null, client, `name-${id}`, status, at],
    );
  }
  async function spend(gen: string, client: string, credits: number, period = currentPeriod()) {
    await pg.client.query(
      `INSERT INTO ${T("generations")} (id, group_id, company_id, provider, model, prompt, period, estimated_credits) VALUES ($1, $1, $2, 'higgsfield', 'm', 'p', $3, $4)`,
      [gen, CO, period, credits],
    );
    await pg.client.query(`INSERT INTO ${T("credit_ledger")} (generation_id, kind, company_id, client_kind, client_ref, period, credits) VALUES ($1, 'reserve', $2, 'company', $3, $4, $5)`, [gen, CO, client, period, credits]);
  }

  beforeEach(async () => {
    await pg.reset();
    for (const [id, name] of [["acme", "Acme Ltd"], ["globex", "Globex Inc"]] as const) {
      await pg.client.query(`INSERT INTO ${T("crm_companies")} (id, company_id, name, updated_at) VALUES ($1, $2, $3, now())`, [id, CO, name]);
    }
  });

  it("gives each client its own counts, use, cap and newest three approved assets", async () => {
    await asset("a1", "acme", "approved", CO, "2026-11-01T10:00:00Z");
    await asset("a2", "acme", "approved", CO, "2026-11-02T10:00:00Z");
    await asset("a3", "acme", "approved", CO, "2026-11-03T10:00:00Z");
    await asset("a4", "acme", "approved", CO, "2026-11-04T10:00:00Z");
    await asset("a5", "acme", "draft");
    await asset("a6", "acme", "rejected");
    await asset("g1", "globex", "draft");
    await asset("g2", "globex", "draft");
    await asset("o1", null, "approved");
    await asset("x1", "acme", "approved", OTHER_CO);
    await spend("s1", "acme", 3);
    await spend("s2", "acme", 1.5, "2020-01");
    await spend("s3", "globex", 2);
    await setCap(ctx(), CO, "company:acme", 20, "owner-1");
    await setCap(ctx(), CO, "company", 100, "owner-1");

    const out = await clientSummaries(ctx(), CO);
    const acme = out.clients.find((c) => c.scopeKey === "company:acme")!;
    const globex = out.clients.find((c) => c.scopeKey === "company:globex")!;
    expect(acme.counts).toEqual({ draft: 1, approved: 4, rejected: 1 });
    expect(acme.used).toBe(3);
    expect(acme.monthlyCap).toBe(20);
    expect(acme.capSource).toBe("client");
    expect(acme.recentApproved.map((a) => a.id)).toEqual(["a4", "a3", "a2"]);
    expect(globex.counts).toEqual({ draft: 2, approved: 0, rejected: 0 });
    expect(globex.used).toBe(2);
    expect(globex.monthlyCap).toBe(100);
    expect(globex.capSource).toBe("company");
    expect(globex.recentApproved).toEqual([]);
  });
});
