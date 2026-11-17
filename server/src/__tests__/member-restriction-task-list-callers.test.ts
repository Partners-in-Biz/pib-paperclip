import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, issues, type Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12718 (stage C3-2a-1): the task list functions take a required read
 * scope. Spec PAR-12608 rev 3, section 4.3 (C28) and 7 (X5): for each route
 * caller this ticket changed, a filter test, a kill-switch test (AC-F8) and a
 * failing-read test (AC-X1). The board-chat caller is covered in
 * board-chat-route-feature-flag.test.ts; AC-L14 in
 * services/issue-list-read-scope.test.ts.
 */

type Actor = Express.Request["actor"];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agent inbox routes when the restriction cannot be read (AC-X1)", () => {
  const failingDb = {
    select: () => {
      throw new Error("connection reset");
    },
  } as unknown as Db;
  const actor: Actor = {
    type: "agent", agentId: "agent-1", companyId: "company-1", runId: "run-1", source: "agent_key",
    onBehalfOfUserId: "user-r", authorizingUserId: "user-r",
  };

  it.each([
    ["/api/agents/me/inbox-lite"],
    ["/api/agents/me/inbox/mine?userId=user-o"],
  ])("%s answers 503 MEMBER_RESTRICTION_UNAVAILABLE and returns no tasks", async (path) => {
    const app = express();
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", agentRoutes(failingDb));
    app.use(errorHandler);

    const res = await request(app).get(path);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
    expect(Array.isArray(res.body)).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();

describe("task list callers database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("agent inbox routes pass the run's read condition", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  let companyId = "";
  let agentId = "";
  let tasksOfR: string[] = [];
  let tasksOfO: string[] = [];

  const runFor = (personId: string): Actor => ({
    type: "agent", agentId, companyId, runId: randomUUID(), source: "agent_key",
    onBehalfOfUserId: personId, authorizingUserId: personId,
  });
  const listed = async (path: string, actor: Actor) => {
    const app = express();
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    return (res.body as Array<{ id: string }>).map((row) => row.id).sort();
  };
  const sorted = (...lists: string[][]) => lists.flat().sort();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-list-callers-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({
      name: "Restricted co", issuePrefix: `L${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    companyId = company!.id;
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
    ]);
    const [agent] = await db.insert(agents).values({ companyId, name: "Shared agent", adapterType: "process", status: "active" }).returning();
    agentId = agent!.id;
    const rows = await db.insert(issues).values([
      { companyId, title: "R's task", status: "todo", createdByUserId: R, assigneeAgentId: agentId },
      { companyId, title: "O's open task", status: "todo", createdByUserId: O, assigneeAgentId: agentId },
    ]).returning();
    tasksOfR = [rows[0]!.id];
    tasksOfO = [rows[1]!.id];
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  describe("GET /agents/me/inbox-lite", () => {
    const path = "/api/agents/me/inbox-lite";

    it("a run for R lists only R's tasks; a run for O lists both", async () => {
      expect(await listed(path, runFor(R))).toEqual(tasksOfR);
      expect(await listed(path, runFor(O))).toEqual(sorted(tasksOfR, tasksOfO));
    });

    it("AC-F8: with the kill switch `off` a run for R lists as in mode off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      expect(await listed(path, runFor(R))).toEqual(sorted(tasksOfR, tasksOfO));
    });
  });

  describe("GET /agents/me/inbox/mine", () => {
    const path = (userId: string) => `/api/agents/me/inbox/mine?userId=${encodeURIComponent(userId)}`;

    it("a run for R does not list O's task from O's inbox; a run for O does", async () => {
      expect(await listed(path(O), runFor(R))).toEqual([]);
      expect(await listed(path(O), runFor(O))).toEqual(tasksOfO);
    });

    it("AC-F8: with the kill switch `off` a run for R lists as in mode off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      expect(await listed(path(O), runFor(R))).toEqual(tasksOfO);
    });
  });
});
