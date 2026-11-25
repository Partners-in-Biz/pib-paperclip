/**
 * The SQL behind the Campaigns canvas card (PAR-14423) against a real Postgres with every migration: the card's text
 * search (new) and the client-filtered list `related` uses, each scoped to its company.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { listCampaigns, searchCampaigns } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const CO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe.skipIf(!available)("campaigns canvas card SQL (postgres)", () => {
  let h: PgHarness;
  let ctx: PluginContext;

  beforeAll(async () => {
    h = await startPg();
    ctx = h.ctx;
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  const campaign = (id: string, name: string, status: string, over: { company?: string; kind?: string | null; ref?: string | null; at?: string } = {}) =>
    h.client.query(
      `INSERT INTO ${NAMESPACE}.campaigns (id, company_id, name, status, client_kind, client_ref, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
      [id, over.company ?? CO, name, status, over.kind ?? null, over.ref ?? null, over.at ?? "2026-09-01T00:00:00Z"],
    );

  beforeEach(async () => {
    await h.reset();
    await campaign("a", "Spring newsletter", "active", { at: "2026-09-03T00:00:00Z" });
    await campaign("b", "Autumn NEWS", "draft", { at: "2026-09-02T00:00:00Z" });
    await campaign("c", "100% off_sale", "paused", { at: "2026-09-01T00:00:00Z" });
    await campaign("d", "Acme onboarding", "active", { kind: "company", ref: "acme" });
    await campaign("e", "Ada follow-up", "draft", { kind: "contact", ref: "ada" });
    await campaign("f", "Other news", "active", { company: OTHER });
  });

  it("search matches name or status case-insensitively, newest first, own campaigns of this company only", async () => {
    expect((await searchCampaigns(ctx, CO, "news", 10)).map((c) => c.id)).toEqual(["a", "b"]);
    expect((await searchCampaigns(ctx, CO, "  NEWS ", 10)).map((c) => c.id)).toEqual(["a", "b"]);
    expect((await searchCampaigns(ctx, CO, "draft", 10)).map((c) => c.id)).toEqual(["b"]);
    expect((await searchCampaigns(ctx, CO, "", 10)).map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect((await searchCampaigns(ctx, CO, "", 2)).map((c) => c.id)).toEqual(["a", "b"]);
    expect(await searchCampaigns(ctx, CO, "acme", 10)).toEqual([]);
    expect((await searchCampaigns(ctx, OTHER, "news", 10)).map((c) => c.id)).toEqual(["f"]);
  });

  it("search reads % and _ as plain characters", async () => {
    expect((await searchCampaigns(ctx, CO, "%", 10)).map((c) => c.id)).toEqual(["c"]);
    expect((await searchCampaigns(ctx, CO, "off_s", 10)).map((c) => c.id)).toEqual(["c"]);
    expect(await searchCampaigns(ctx, CO, "off.s", 10)).toEqual([]);
  });

  it("the list for one CRM client (what related returns) holds that client's campaigns only", async () => {
    expect((await listCampaigns(ctx, CO, { kind: "company", id: "acme" })).map((c) => c.id)).toEqual(["d"]);
    expect((await listCampaigns(ctx, CO, { kind: "contact", id: "ada" })).map((c) => c.id)).toEqual(["e"]);
    expect(await listCampaigns(ctx, OTHER, { kind: "company", id: "acme" })).toEqual([]);
  });
});
