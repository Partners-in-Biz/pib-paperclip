/** Migration 014 (client_projects.kind) and link-client-project / list-client-projects with a kind, on a real Postgres. */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { insertAccount } from "../src/db.js";
import { CrmError, createAccount, type Viewer } from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";
import { CLIENT_PROJECT_KINDS, linkClientProject, listClientProjectsTool } from "../src/sites.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const CO = "co-1";
const viewer: Viewer = { companyId: CO, userId: "u1", agentId: null, role: "owner" };
const PROJECTS = ["p1", "p2", "p3"].map((id) => ({ id, companyId: CO, name: `Project ${id}` }));
const sql014 = () => readFileSync(new URL("../migrations/014_crm.sql", import.meta.url), "utf8");
const available = await embeddedAvailable();

describe.skipIf(!available)("migration 014: client_projects.kind", () => {
  it("applies on a fresh database and on a populated one, leaving existing rows with a null kind, and twice is harmless", async () => {
    const old = await startPg({ upTo: 13 });
    try {
      await old.client.query(`INSERT INTO ${NAMESPACE}.client_projects (id, company_id, client_kind, client_ref, project_id) VALUES ('l1', '${CO}', 'company', 'acme', 'p1'), ('l2', '${CO}', 'company', 'acme', 'p2')`);
      await old.client.query(sql014());
      await expect(old.client.query(sql014())).resolves.toBeDefined();
      expect((await old.client.query(`SELECT kind FROM ${NAMESPACE}.client_projects`)).rows).toEqual([{ kind: null }, { kind: null }]);
    } finally {
      await old.stop();
    }
    const fresh = await startPg();
    try {
      const column = await fresh.client.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = '${NAMESPACE}' AND table_name = 'client_projects' AND column_name = 'kind'`);
      expect(column.rows).toEqual([{ data_type: "text", is_nullable: "YES" }]);
      const index = (await fresh.client.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = '${NAMESPACE}' AND indexname = 'client_projects_client_kind_partial'`)).rows as Array<{ indexdef: string }>;
      expect(index[0]?.indexdef).toMatch(/UNIQUE.*\(company_id, client_kind, client_ref, kind\) WHERE \(kind IS NOT NULL\)/);
    } finally {
      await fresh.stop();
    }
  }, 120_000);
});

describe.skipIf(!available)("link-client-project and list-client-projects with a kind", () => {
  let pg: PgHarness;
  let ctx: PluginContext;
  let acme: string;
  let globex: string;
  beforeAll(async () => {
    pg = await startPg();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(async () => {
    await pg.reset();
    ctx = { ...pg.ctx, projects: { get: async (id: string) => PROJECTS.find((p) => p.id === id) ?? null, list: async () => PROJECTS } } as unknown as PluginContext;
    const accounts = [createAccount({ companyId: CO, name: "Acme" }), createAccount({ companyId: CO, name: "Globex" })];
    for (const account of accounts) await insertAccount(ctx, account);
    [acme, globex] = accounts.map((account) => `company:${account.id}`);
  });

  const link = (project: string, extra: Record<string, unknown> = {}, client = acme) => linkClientProject(ctx, viewer, { client, projectId: project, ...extra });
  const kinds = async (client = acme) => Object.fromEntries((await listClientProjectsTool(ctx, viewer, { client })).projects.map((p: { projectId: string; kind: string | null }) => [p.projectId, p.kind]));

  it("accepts every kind in the code list and rejects an unknown one without writing", async () => {
    expect(CLIENT_PROJECT_KINDS).toEqual(["seo", "website", "app", "social", "ads", "campaigns", "book", "platform", "ops"]);
    for (const kind of CLIENT_PROJECT_KINDS) {
      await link("p1", { kind });
      expect((await kinds()).p1).toBe(kind);
    }
    await link("p1", { kind: null });
    for (const bad of ["blog", 5, ""]) await expect(link("p1", { kind: bad })).rejects.toThrow(/Unknown kind .*Use one of: seo, website/);
    expect((await kinds()).p1).toBeNull();
  });

  it("refuses a second project of the same client and kind with a clear conflict, but not for another client", async () => {
    await link("p1", { kind: "seo" });
    const clash = link("p2", { kind: "seo" });
    await expect(clash).rejects.toBeInstanceOf(CrmError);
    await expect(clash).rejects.toThrow(/already has a seo project \(Project p1\)/);
    expect(await kinds()).toEqual({ p1: "seo" });
    await expect(link("p2", { kind: "seo" }, globex)).resolves.toMatchObject({ linked: true, kind: "seo" });
    // A project already linked elsewhere is still refused.
    await expect(link("p1", { kind: "website" }, globex)).rejects.toThrow(/already belongs to/);
  });

  it("allows any number of links without a kind", async () => {
    await link("p1");
    await link("p2", { kind: null });
    await link("p3");
    expect(await kinds()).toEqual({ p1: null, p2: null, p3: null });
  });

  it("changes or clears the kind when the same project is linked again, and frees the old kind", async () => {
    await link("p1", { kind: "seo" });
    expect(await link("p1", { kind: "website" })).toMatchObject({ linked: true, kind: "website", kindChanged: true, previousKind: "seo" });
    expect(await link("p1", { kind: "website" })).toMatchObject({ alreadyLinked: true, kind: "website" });
    await link("p2", { kind: "seo" });
    expect(await kinds()).toEqual({ p1: "website", p2: "seo" });
    expect(await link("p2", { kind: null })).toMatchObject({ kind: null, kindChanged: true, previousKind: "seo" });
    await expect(link("p2", { kind: "website" })).rejects.toThrow(/already has a website project \(Project p1\)/);
    await link("p1", { kind: null });
    expect(await link("p2", { kind: "website" })).toMatchObject({ linked: true });
  });

  it("works as before without a kind: new link has none, a repeat link leaves the kind alone", async () => {
    expect(await link("p1")).toEqual({ projectId: "p1", name: "Project p1", client: acme, linked: true, kind: null });
    expect(await link("p1")).toMatchObject({ alreadyLinked: true, kind: null });
    await link("p1", { kind: "seo" });
    expect(await link("p1")).toMatchObject({ alreadyLinked: true, kind: "seo" });
    expect(await kinds()).toEqual({ p1: "seo" });
  });

  it("lets only one of two racing requests take a kind, and the other gets the conflict, not a database error", async () => {
    const results = await Promise.allSettled([link("p1", { kind: "seo" }), link("p2", { kind: "seo" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(lost?.reason).toBeInstanceOf(CrmError);
    expect(String(lost?.reason.message)).toMatch(/already has a seo project/);
  });
});
