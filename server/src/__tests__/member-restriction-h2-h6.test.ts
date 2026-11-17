import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issues,
  routines,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { routineRoutes } from "../routes/routines.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// PAR-12713 (C2-3): H2 (a task names only its creator as responsible person)
// and H6 for routines (create, change and run only one's own), with the
// kill-switch (AC-F8) and failing-read (AC-X1) tests for both consumers.
// O = owner, U = unflagged operator, R = flagged operator.

const support = await getEmbeddedPostgresTestSupport();

describe("H2 and H6 database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Mode = "off" | "report" | "enforce";
type Actor = Express.Request["actor"];

(support.supported ? describe : describe.skip)("H2 and H6", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-restriction-h2-h6-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_MEMBER_RESTRICTION;
  });

  async function fixture(mode: Mode = "enforce") {
    const [company] = await db.insert(companies).values({
      name: "H2", issuePrefix: `H${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: mode,
      requireBoardApprovalForNewAgents: false,
    }).returning();
    const companyId = company!.id;
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
    ]);
    const [agent] = await db.insert(agents).values({
      companyId, name: "X", role: "engineer", adapterType: "codex_local", status: "active",
    }).returning();
    return { companyId, agentId: agent!.id, users };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function board(userId: string): Promise<Actor> {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return {
      type: "board", userId, source: "session", isInstanceAdmin: false,
      companyIds: memberships.map((m) => m.companyId), memberships,
    };
  }

  function agentFor(f: Fixture, personId: string, memberships: Actor["memberships"]): Actor {
    return {
      type: "agent", companyId: f.companyId, agentId: f.agentId, source: "agent_key",
      onBehalfOfUserId: personId, onBehalfOfMemberships: memberships,
    };
  }

  function app(actor: Actor) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { req.actor = actor; next(); });
    server.use("/api", issueRoutes(db, {} as never));
    server.use("/api", routineRoutes(db));
    server.use(errorHandler);
    return server;
  }

  async function denials(companyId: string, ruleId: string) {
    const rows = await db.select({ details: activityLog.details }).from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "member_restriction.denied")));
    return rows.filter((row) => (row.details as { ruleId?: string }).ruleId === ruleId);
  }

  async function issueCount(companyId: string) {
    return (await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId))).length;
  }

  const createTask = (f: Fixture, actor: Actor, body: Record<string, unknown>) =>
    request(app(actor)).post(`/api/companies/${f.companyId}/issues`).send({ title: `Task ${randomUUID().slice(0, 8)}`, ...body });

  async function routineOf(f: Fixture, personId: string) {
    const created = await request(app(await board(f.users.O)))
      .post(`/api/companies/${f.companyId}/routines`)
      .send({ title: "Weekly", assigneeAgentId: f.agentId, status: "paused" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await db.update(routines).set({ responsibleUserId: personId }).where(eq(routines.id, created.body.id));
    return created.body.id as string;
  }

  describe("AC-H2: a task names only its creator", () => {
    it("refuses U naming O (422) and records it; left out, U is responsible", async () => {
      const f = await fixture();
      const named = await createTask(f, await board(f.users.U), { responsibleUserId: f.users.O });
      expect(named.status, JSON.stringify(named.body)).toBe(422);
      expect(named.body.code).toBe("RESPONSIBLE_PERSON_NOT_SELF");
      expect(await issueCount(f.companyId)).toBe(0);
      expect(await denials(f.companyId, "H2")).toHaveLength(1);

      const self = await createTask(f, await board(f.users.U), { responsibleUserId: f.users.U });
      expect(self.status, JSON.stringify(self.body)).toBe(201);
      expect(self.body.responsibleUserId).toBe(f.users.U);

      const parent = await createTask(f, await board(f.users.O), {});
      expect(parent.body.responsibleUserId).toBe(f.users.O);
      const leftOut = await createTask(f, await board(f.users.U), { parentId: parent.body.id });
      expect(leftOut.status, JSON.stringify(leftOut.body)).toBe(201);
      expect(leftOut.body.responsibleUserId).toBe(f.users.U);
    });

    it("refuses U naming O on the children and plan-decomposition routes", async () => {
      const f = await fixture();
      const parent = await createTask(f, await board(f.users.O), {});
      const child = await request(app(await board(f.users.U)))
        .post(`/api/issues/${parent.body.id}/children`)
        .send({ title: "Child", responsibleUserId: f.users.O });
      expect(child.status, JSON.stringify(child.body)).toBe(422);
      const decomposed = await request(app(await board(f.users.U)))
        .post(`/api/issues/${parent.body.id}/accepted-plan-decompositions`)
        .send({ acceptedPlanRevisionId: randomUUID(), children: [{ title: "Step", responsibleUserId: f.users.O }] });
      expect(decomposed.status, JSON.stringify(decomposed.body)).toBe(422);
      expect(decomposed.body.code).toBe("RESPONSIBLE_PERSON_NOT_SELF");
    });

    it("lets O (owner) name U as today", async () => {
      const f = await fixture();
      const res = await createTask(f, await board(f.users.O), { responsibleUserId: f.users.U });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.responsibleUserId).toBe(f.users.U);
      expect(await denials(f.companyId, "H2")).toHaveLength(0);
    });

    it("in report, accepts U naming O and records one entry", async () => {
      const f = await fixture("report");
      const res = await createTask(f, await board(f.users.U), { responsibleUserId: f.users.O });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.responsibleUserId).toBe(f.users.O);
      expect(await denials(f.companyId, "H2")).toHaveLength(1);
    });

    it("an update carrying responsibleUserId changes nothing", async () => {
      const f = await fixture();
      const created = await createTask(f, await board(f.users.U), {});
      const patched = await request(app(await board(f.users.U)))
        .patch(`/api/issues/${created.body.id}`)
        .send({ title: "Renamed", responsibleUserId: f.users.O });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      const [row] = await db.select({ responsibleUserId: issues.responsibleUserId, title: issues.title })
        .from(issues).where(eq(issues.id, created.body.id));
      expect(row).toEqual({ responsibleUserId: f.users.U, title: "Renamed" });
    });
  });

  describe("AC-H7: routines work only for their own person", () => {
    it("refuses U creating a routine for O (422); left out, U is responsible", async () => {
      const f = await fixture();
      const named = await request(app(await board(f.users.U)))
        .post(`/api/companies/${f.companyId}/routines`)
        .send({ title: "Mine", assigneeAgentId: f.agentId, status: "paused", responsibleUserId: f.users.O });
      expect(named.status, JSON.stringify(named.body)).toBe(422);
      expect(named.body.code).toBe("RESPONSIBLE_PERSON_NOT_SELF");

      const leftOut = await request(app(await board(f.users.U)))
        .post(`/api/companies/${f.companyId}/routines`)
        .send({ title: "Mine", assigneeAgentId: f.agentId, status: "paused" });
      expect(leftOut.status, JSON.stringify(leftOut.body)).toBe(201);
      expect(leftOut.body.responsibleUserId).toBe(f.users.U);
    });

    it("refuses (403) U changing, re-pointing or running O's routine; O does it as today", async () => {
      const f = await fixture();
      const routineId = await routineOf(f, f.users.O);
      const asU = app(await board(f.users.U));
      for (const call of [
        request(asU).patch(`/api/routines/${routineId}`).send({ description: "new instruction" }),
        request(asU).patch(`/api/routines/${routineId}`).send({ responsibleUserId: f.users.U }),
        request(asU).post(`/api/routines/${routineId}/triggers`).send({ kind: "schedule", cronExpression: "0 9 * * 1" }),
        request(asU).post(`/api/routines/${routineId}/run`).send({}),
      ]) {
        const res = await call;
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.code).toBe("ROUTINE_NOT_OWN");
      }
      expect(await denials(f.companyId, "H6")).toHaveLength(1);

      const asO = await request(app(await board(f.users.O)))
        .patch(`/api/routines/${routineId}`).send({ description: "new instruction" });
      expect(asO.status, JSON.stringify(asO.body)).toBe(200);
    });

    it("refuses (403) U on each trigger route and on a revision restore of O's routine", async () => {
      const f = await fixture();
      const routineId = await routineOf(f, f.users.O);
      const asO = app(await board(f.users.O));
      const trigger = await request(asO).post(`/api/routines/${routineId}/triggers`)
        .send({ kind: "webhook" });
      expect(trigger.status, JSON.stringify(trigger.body)).toBe(201);
      const triggerId = (trigger.body.trigger ?? trigger.body).id as string;
      const [stored] = await db.select({ latestRevisionId: routines.latestRevisionId }).from(routines)
        .where(eq(routines.id, routineId));
      const asU = app(await board(f.users.U));
      for (const call of [
        request(asU).patch(`/api/routine-triggers/${triggerId}`).send({ enabled: false }),
        request(asU).post(`/api/routine-triggers/${triggerId}/rotate-secret`).send({}),
        request(asU).delete(`/api/routine-triggers/${triggerId}`),
        request(asU).post(`/api/routines/${routineId}/revisions/${stored!.latestRevisionId}/restore`).send({}),
      ]) {
        const res = await call;
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.code).toBe("ROUTINE_NOT_OWN");
      }
      const deleted = await request(asO).delete(`/api/routine-triggers/${triggerId}`);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
    });

    it("refuses U handing his own routine to O", async () => {
      const f = await fixture();
      const routineId = await routineOf(f, f.users.U);
      const asU = app(await board(f.users.U));
      const ok = await request(asU).patch(`/api/routines/${routineId}`).send({ description: "mine" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const away = await request(asU).patch(`/api/routines/${routineId}`).send({ responsibleUserId: f.users.O });
      expect(away.status, JSON.stringify(away.body)).toBe(403);
    });

    it("binds an agent working for U the same way", async () => {
      const f = await fixture();
      const routineId = await routineOf(f, f.users.O);
      const memberships = await loadActorMemberships(db, { userId: f.users.U, activeOnly: true });
      const res = await request(app(agentFor(f, f.users.U, memberships)))
        .patch(`/api/routines/${routineId}`).send({ description: "new instruction" });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    });

    it("in report, lets U change O's routine and records one entry", async () => {
      const f = await fixture("report");
      const routineId = await routineOf(f, f.users.O);
      const res = await request(app(await board(f.users.U)))
        .patch(`/api/routines/${routineId}`).send({ description: "new instruction" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await denials(f.companyId, "H6")).toHaveLength(1);
    });
  });

  describe("AC-F8: kill switch", () => {
    it("behaves as mode off for H2 and H6 with the variable off and the column on enforce", async () => {
      process.env.PAPERCLIP_MEMBER_RESTRICTION = "off";
      const f = await fixture();
      const task = await createTask(f, await board(f.users.U), { responsibleUserId: f.users.O });
      expect(task.status, JSON.stringify(task.body)).toBe(201);
      expect(task.body.responsibleUserId).toBe(f.users.O);
      const routineId = await routineOf(f, f.users.O);
      const routine = await request(app(await board(f.users.U)))
        .patch(`/api/routines/${routineId}`).send({ description: "new instruction" });
      expect(routine.status, JSON.stringify(routine.body)).toBe(200);
      expect(await denials(f.companyId, "H2")).toHaveLength(0);
      expect(await denials(f.companyId, "H6")).toHaveLength(0);
    });

    it("keeps enforcing when the variable is not exactly off", async () => {
      process.env.PAPERCLIP_MEMBER_RESTRICTION = "OFF ";
      const f = await fixture();
      const task = await createTask(f, await board(f.users.U), { responsibleUserId: f.users.O });
      expect(task.status).toBe(422);
    });
  });

  describe("AC-X1: a failed read refuses", () => {
    it("answers 503 MEMBER_RESTRICTION_UNAVAILABLE on H2 and H6 for R, with nothing written", async () => {
      const f = await fixture();
      const routineId = await routineOf(f, f.users.O);
      const actor = await board(f.users.R);
      // A malformed stored list makes the resolver throw on R's row.
      await db.update(companyMemberships).set({ restrictedPluginKeys: [1] as never })
        .where(eq(companyMemberships.principalId, f.users.R));
      const task = await createTask(f, actor, {});
      expect(task.status, JSON.stringify(task.body)).toBe(503);
      expect(task.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
      expect(task.body).not.toHaveProperty("id");
      expect(await issueCount(f.companyId)).toBe(0);
      const routine = await request(app(actor))
        .patch(`/api/routines/${routineId}`).send({ description: "new instruction" });
      expect(routine.status, JSON.stringify(routine.body)).toBe(503);
      expect(routine.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
      const [row] = await db.select({ description: routines.description }).from(routines).where(eq(routines.id, routineId));
      expect(row?.description ?? null).not.toBe("new instruction");
    });
  });
});
