import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships, createDb, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { pluginRoutes } from "../routes/plugins.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12742 (C5-3): the Apps menu, spec PAR-12608 rev 3, 4.8 (AC-K4), and the
 * route-table row `GET /api/plugins/ui-contributions`, class `plugin`
 * (PAR-13261). The filter is a new caller of the resolver: kill-switch and
 * failing-read tests below (AC-F8, AC-X1).
 */

const failRead = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  return {
    ...actual,
    memberRestrictionResolver: (db: Db) => {
      const real = actual.memberRestrictionResolver(db);
      return (personId: string, companyId: string) => {
        if (failRead.on) return Promise.reject(new Error("restriction store down"));
        return real(personId, companyId);
      };
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describe("ui-contributions filter database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

function manifest(key: string): PaperclipPluginManifestV1 {
  return {
    id: key, apiVersion: 1, version: "1.0.0", displayName: key, description: "apps menu fixture", author: "Paperclip",
    categories: ["ui"], capabilities: ["ui.page.register"], entrypoints: { worker: "dist/worker.js", ui: "dist/ui" },
    ui: { slots: [{ type: "page", id: "home", displayName: key, exportName: "Page", routePath: key.replace(/\W/g, "-") }] },
  } as PaperclipPluginManifestV1;
}

describeDb("Apps menu: ui-contributions lists only his open plugins (PAR-12608 4.8)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  const O = `owner-${randomUUID()}`;
  const U = `operator-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const CRM = `partnersinbiz.crm-${randomUUID().slice(0, 8)}`;
  const WIKI = `paperclip.llm-wiki-${randomUUID().slice(0, 8)}`;
  const id: Record<string, string> = {};
  let actor: Record<string, unknown> = { type: "none" };

  /** The plugin routes alone, and behind the real route-table middleware as `app.ts` mounts it. */
  const bare = express();
  const guarded = express();

  const boardFor = async (userId: string) => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return { type: "board", userId, source: "session", memberships, companyIds: memberships.map((row) => row.companyId) };
  };
  const setList = (companyId: string, pluginKeys: string[]) => db.update(companyMemberships)
    .set({ restrictedPluginKeys: pluginKeys })
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, R)));
  const setMode = (mode: "off" | "report" | "enforce") =>
    db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, id.Y!));
  const listed = async (app = bare) => {
    const res = await request(app).get("/api/plugins/ui-contributions");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body as Array<{ pluginKey: string }>).map((row) => row.pluginKey).sort();
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-ui-contributions-");
    db = createDb(tempDb.connectionString);
    const [x, y] = await db.insert(companies).values([
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    id.X = x!.id;
    id.Y = y!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, U, R].map((user) => ({
      id: user, name: user, email: `${user}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: id.Y, principalType: "user", principalId: O, membershipRole: "owner", status: "active" },
      { companyId: id.Y, principalType: "user", principalId: U, membershipRole: "operator", status: "active" },
      { companyId: id.Y, principalType: "user", principalId: R, membershipRole: "operator", status: "active", restricted: true },
    ]);
    await db.insert(plugins).values([CRM, WIKI].map((key) => ({
      pluginKey: key, packageName: key, version: "1.0.0", manifestJson: manifest(key), status: "ready" as const,
    })));
    for (const app of [bare, guarded]) {
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = actor as never; next(); });
    }
    const routes = () => pluginRoutes(db, {} as never, undefined, undefined, undefined, undefined);
    bare.use("/api", routes());
    bare.use(errorHandler);
    const api = Router();
    api.use(memberRestrictionRouteGuard(db));
    api.use(routes());
    guarded.use("/api", api);
    guarded.use(errorHandler);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    failRead.on = false;
    await setList(id.Y!, []);
    await setMode("enforce");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("AC-K4: R at enforce sees no plugin with an empty list and only the CRM once it is listed; O and U see both", async () => {
    actor = await boardFor(R);
    expect(await listed()).toEqual([]);
    await setList(id.Y!, [CRM]);
    actor = await boardFor(R);
    expect(await listed()).toEqual([CRM]);
    for (const person of [O, U]) {
      actor = await boardFor(person);
      expect(await listed()).toEqual([CRM, WIKI].sort());
    }
  });

  it("route-table row: R at enforce through the real middleware gets 200 and only his open plugins", async () => {
    await setList(id.Y!, [WIKI]);
    actor = await boardFor(R);
    expect(await listed(guarded)).toEqual([WIKI]);
    actor = await boardFor(O);
    expect(await listed(guarded)).toEqual([CRM, WIKI].sort());
  });

  it("owner in X and restricted in Y: Y's list applies in X too (no company in the path, S14)", async () => {
    await db.insert(companyMemberships).values(
      { companyId: id.X!, principalType: "user", principalId: R, membershipRole: "owner", status: "active" });
    try {
      await setList(id.Y!, [CRM]);
      actor = await boardFor(R);
      expect(await listed(guarded)).toEqual([CRM]);
    } finally {
      await db.delete(companyMemberships).where(and(eq(companyMemberships.companyId, id.X!), eq(companyMemberships.principalId, R)));
    }
  });

  it.each(["report", "off"] as const)("mode %s filters nothing", async (mode) => {
    await setMode(mode);
    actor = await boardFor(R);
    expect(await listed(guarded)).toEqual([CRM, WIKI].sort());
  });

  it("kill switch (AC-F8): variable `off` with the column on `enforce` behaves as mode `off`", async () => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    actor = await boardFor(R);
    expect(await listed()).toEqual([CRM, WIKI].sort());
  });

  it("failing read (AC-X1): 503 MEMBER_RESTRICTION_UNAVAILABLE and no plugin", async () => {
    // A flagged membership reads his list through the resolver.
    actor = await boardFor(R);
    failRead.on = true;
    const res = await request(bare).get("/api/plugins/ui-contributions");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "MEMBER_RESTRICTION_UNAVAILABLE" });
    expect(Array.isArray(res.body)).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(CRM);
  });
});
