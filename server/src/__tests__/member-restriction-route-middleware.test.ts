import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, authUsers, companies, companyMemberships, createDb } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { createMcpApiDispatch } from "../services/public-mcp/capabilities.js";
import type { McpPrincipal } from "../services/public-mcp/oauth.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { MEMBER_RESTRICTION_DENIED_ACTION } from "../services/member-restriction/admin.js";
import { companyIdInPath, memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import type { MemberRestrictionRouteEntry } from "../services/member-restriction/route-table.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// PAR-12922 (C4a-2): the route-table middleware above the avatar router.
// AC-G2 (an unlisted route: 403 for R, normal for O and U, also through the
// assistant-connection `inject` dispatch), report mode, the kill switch
// (AC-F8), the failing read (AC-X1) and a membership without fields (AC-X3).
// O = owner, U = unflagged operator, R = flagged operator.

const support = await getEmbeddedPostgresTestSupport();
const REFUSED = { error: "Not available for your access level", code: "MEMBER_RESTRICTED" };

describe("route middleware database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

describe("companyIdInPath", () => {
  it("reads a UUID company segment, case-normalised, and nothing else", () => {
    const id = randomUUID();
    expect(companyIdInPath(`/api/companies/${id.toUpperCase()}/issues`)).toBe(id);
    expect(companyIdInPath(`/API/Companies/${id}`)).toBe(id);
    expect(companyIdInPath("/api/companies/PAR/issues")).toBeNull();
    expect(companyIdInPath("/api/companies")).toBeNull();
    expect(companyIdInPath(`/api/issues/${id}`)).toBeNull();
  });
});

(support.supported ? describe : describe.skip)("member-restriction route middleware", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-restriction-route-mw-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  async function fixture(mode: "off" | "report" | "enforce" = "enforce") {
    const [company] = await db.insert(companies).values({
      name: "Route MW", issuePrefix: `M${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: mode,
    }).returning();
    const [other] = await db.insert(companies).values({
      name: "Other", issuePrefix: `N${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    const companyId = company!.id;
    const otherId = other!.id;
    const users = { O: `o-${randomUUID()}`, U: `u-${randomUUID()}`, R: `r-${randomUUID()}` };
    for (const id of Object.values(users)) {
      await db.insert(authUsers).values({
        id, name: id, email: `${id}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      });
    }
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: users.O, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: users.U, status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: users.R, status: "active", membershipRole: "operator", restricted: true },
      // R is an unrestricted operator in the other company (AC-G9 shape).
      { companyId: otherId, principalType: "user", principalId: users.R, status: "active", membershipRole: "operator" },
    ]);
    return { companyId, otherId, users };
  }

  /** A session actor exactly as the session loader builds it. */
  async function session(userId: string): Promise<Express.Request["actor"]> {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return { type: "board", source: "session", userId, companyIds: memberships.map((m) => m.companyId), memberships };
  }

  async function agentFor(userId: string, companyId: string): Promise<Express.Request["actor"]> {
    const onBehalfOfMemberships = await loadActorMemberships(db, { userId, companyId, activeOnly: true });
    return { type: "agent", source: "agent_jwt", agentId: randomUUID(), companyId, runId: randomUUID(), onBehalfOfUserId: userId, onBehalfOfMemberships };
  }

  function testApi(options: Parameters<typeof memberRestrictionRouteGuard>[1] = {}) {
    const api = Router();
    api.use(memberRestrictionRouteGuard(db, options));
    api.get("/companies/:companyId/test-unlisted", (_req, res) => { res.json({ ok: true }); });
    api.get("/test-no-company", (req, res) => {
      res.json({ ok: true, byCompany: req.actor.memberRestrictionByCompany ?? false, set: req.actor.memberRestrictedCompanyIds ?? null });
    });
    return api;
  }

  function appAs(actor: Express.Request["actor"], api = testApi()) {
    const app = express();
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", api);
    app.use(errorHandler);
    return app;
  }

  async function denials(companyId: string, personId: string) {
    return db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION),
      eq(activityLog.responsibleUserId, personId),
    ));
  }

  it("AC-G2: an unlisted route is 403 for R and normal for O and U; the same through inject", async () => {
    const { companyId, users } = await fixture();
    const path = `/api/companies/${companyId}/test-unlisted`;
    for (const who of ["O", "U"] as const) {
      await request(appAs(await session(users[who]))).get(path).expect(200, { ok: true });
      await request(appAs(await session(users[who]))).get("/api/test-no-company").expect(200);
    }
    await request(appAs(await session(users.R))).get(path).expect(403, REFUSED);
    await request(appAs(await session(users.R))).get(path.replace(companyId, companyId.toUpperCase())).expect(403, REFUSED);
    await request(appAs(await session(users.R))).get("/api/test-no-company").expect(403, REFUSED);
    await request(appAs(await agentFor(users.R, companyId))).get(path).expect(403, REFUSED);
    expect(await denials(companyId, users.R)).toHaveLength(1);

    const dispatch = createMcpApiDispatch(testApi());
    const as = async (userId: string) => ({ actor: await session(userId) }) as unknown as McpPrincipal;
    await expect(dispatch(await as(users.O), "GET", `/companies/${companyId}/test-unlisted`, undefined)).resolves.toEqual({ ok: true });
    await expect(dispatch(await as(users.R), "GET", `/companies/${companyId}/test-unlisted`, undefined))
      .rejects.toMatchObject({ status: 403, details: { code: "MEMBER_RESTRICTED" } });
  });

  it("lets the table class decide: open, run, plugin, by-company; unsafe paths are refused", async () => {
    const { companyId, otherId, users } = await fixture();
    const entry = (cls: MemberRestrictionRouteEntry["class"], path: string): MemberRestrictionRouteEntry => ({ method: "GET", path, class: cls });
    const unlisted = `/api/companies/${companyId}/test-unlisted`;
    const api = (cls: MemberRestrictionRouteEntry["class"]) => testApi({
      entries: [entry(cls, "/api/companies/:companyId/test-unlisted"), entry(cls, "/api/test-no-company")],
    });
    const R = await session(users.R);
    await request(appAs(R, api("open"))).get(unlisted).expect(200);
    await request(appAs(R, api("plugin"))).get(unlisted).expect(200);
    await request(appAs(R, api("run"))).get(unlisted).expect(403, REFUSED);
    await request(appAs(await agentFor(users.R, companyId), api("run"))).get(unlisted).expect(200);
    await request(appAs(R, api("closed"))).get(unlisted).expect(403, REFUSED);
    const marked = await request(appAs(R, api("by-company"))).get("/api/test-no-company").expect(200);
    expect(marked.body).toEqual({ ok: true, byCompany: true, set: [companyId] });
    // Not restricted in the company the path names: passes whatever the class.
    await request(appAs(R)).get(`/api/companies/${otherId}/test-unlisted`).expect(200);
    // An unsafe path is refused for R even on an open row, never for O.
    await request(appAs(R, api("open"))).get(`/api/companies/${companyId}%2Ftest-unlisted`).expect(403, REFUSED);
    await request(appAs(await session(users.O), api("open"))).get(unlisted.replace("/test", "//test")).expect(404);
  });

  it("report: records a would-refuse once a day and passes", async () => {
    const { companyId, users } = await fixture("report");
    const R = await session(users.R);
    await request(appAs(R)).get(`/api/companies/${companyId}/test-unlisted`).expect(200, { ok: true });
    await request(appAs(R)).get(`/api/companies/${companyId}/test-unlisted`).expect(200, { ok: true });
    const rows = await denials(companyId, users.R);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ ruleId: "R-route", mode: "report", target: `GET /api/companies/${companyId}/test-unlisted` });
  });

  it("AC-F8: the kill switch `off` passes R untouched; any other value does not", async () => {
    const { companyId, users } = await fixture();
    const path = `/api/companies/${companyId}/test-unlisted`;
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    await request(appAs(await session(users.R))).get(path).expect(200, { ok: true });
    expect(await denials(companyId, users.R)).toHaveLength(0);
    for (const value of ["false", "OFF "]) {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", value);
      await request(appAs(await session(users.R))).get(path).expect(403, REFUSED);
    }
  });

  it("AC-X1 and AC-X3: a membership without fields is read from the database; a failed read is 503 with no data", async () => {
    const { companyId, users } = await fixture();
    const path = `/api/companies/${companyId}/test-unlisted`;
    const bare: Express.Request["actor"] = {
      type: "board", source: "session", userId: users.R, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" } as never],
    };
    await request(appAs(bare)).get(path).expect(403, REFUSED);
    const failing = testApi({ resolve: async () => { throw new Error("database down"); } });
    const res = await request(appAs(bare, failing)).get(path).expect(503);
    expect(res.body).toMatchObject({ code: "MEMBER_RESTRICTION_UNAVAILABLE" });
    expect(res.body).not.toHaveProperty("ok");
  });

  it("leaves the local board, an instance admin and an agent with no person untouched", async () => {
    const { companyId, users } = await fixture();
    const path = `/api/companies/${companyId}/test-unlisted`;
    const failing = testApi({ resolve: async () => { throw new Error("must not be read"); } });
    await request(appAs({ type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true }, failing)).get(path).expect(200);
    await request(appAs({ ...(await session(users.R)), isInstanceAdmin: true }, failing)).get(path).expect(200);
    await request(appAs({ type: "agent", source: "agent_key", agentId: randomUUID(), companyId }, failing)).get(path).expect(200);
  });
});
