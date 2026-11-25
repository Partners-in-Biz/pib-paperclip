import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authUsers, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// PAR-14413 (Canvas P3 C1, plan PAR-14389 Fact 21): the issue card's subtask list reads
// `GET /companies/:id/issues?parentIds=`. As a restricted member under `enforce` it must hold
// only the children that person may read.

const support = await getEmbeddedPostgresTestSupport();

describe("parentIds list database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];

(support.supported ? describe : describe.skip)("GET /companies/:id/issues?parentIds= as a restricted member", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const O = `o-${randomUUID()}`;
  const R = `r-${randomUUID()}`;
  let companyId = "";
  let parentId = "";
  let ownChildId = "";
  let othersChildId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-parent-ids-restricted-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({
      name: "Parent ids", issuePrefix: `P${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
      requireBoardApprovalForNewAgents: false,
    }).returning();
    companyId = company!.id;
    for (const id of [O, R]) {
      await db.insert(authUsers).values({
        id, name: id, email: `${id}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      });
    }
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
    ]);
    const [parent] = await db.insert(issues).values({
      companyId, title: "Parent", status: "todo", createdByUserId: O,
    }).returning();
    parentId = parent!.id;
    const children = await db.insert(issues).values([
      { companyId, parentId, title: "R's child", status: "todo", createdByUserId: R },
      { companyId, parentId, title: "O's child", status: "todo", createdByUserId: O },
    ]).returning();
    ownChildId = children[0]!.id;
    othersChildId = children[1]!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function childrenSeenBy(userId: string) {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    const actor: Actor = {
      type: "board", userId, source: "session", isInstanceAdmin: false,
      companyIds: memberships.map((m) => m.companyId), memberships,
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ parentIds: parentId, view: "rows" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body as Array<{ id: string }>).map((row) => row.id).sort();
  }

  it("a restricted member gets only the children they can read", async () => {
    expect(await childrenSeenBy(R)).toEqual([ownChildId]);
  });

  it("an unrestricted owner gets both children", async () => {
    expect(await childrenSeenBy(O)).toEqual([ownChildId, othersChildId].sort());
  });
});
