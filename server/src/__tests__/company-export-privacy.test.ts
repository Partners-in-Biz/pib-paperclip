import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, issueComments, issues, projects } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { companyRoutes } from "../routes/companies.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-14320: a company export holds only the tasks and projects the caller can
 * read. A member does not export another person's private task, chat, their
 * comments, or a private project he is not in; each person gets his own.
 */

const support = await getEmbeddedPostgresTestSupport();

describe("company export privacy database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("company export privacy", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const prefix = `X${companyId.slice(0, 5).toUpperCase()}`;
  const A = `a-${randomUUID()}`;
  const B = `b-${randomUUID()}`;
  const ids = { open: randomUUID(), aPrivate: randomUUID(), bPrivate: randomUUID(), bChat: randomUUID(), inPrivateProject: randomUUID() };
  const identifier = (n: number) => `${prefix}-${n}`;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-export-privacy-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Export privacy", issuePrefix: prefix });
    await db.insert(companyMemberships).values([A, B].map((principalId) => ({
      companyId, principalType: "user", principalId, status: "active", membershipRole: "operator",
    })));
    const [agent] = await db.insert(agents).values({ companyId, name: "Writer", status: "idle", adapterType: "process" }).returning();
    const [privateProject] = await db.insert(projects)
      .values({ companyId, name: "Hidden roadmap project", visibility: "private" }).returning();
    await db.insert(issues).values([
      { id: ids.open, identifier: identifier(1), issueNumber: 1, companyId, title: "Open team task", createdByUserId: B },
      { id: ids.aPrivate, identifier: identifier(2), issueNumber: 2, companyId, title: "A private notes", visibility: "private", createdByUserId: A },
      { id: ids.bPrivate, identifier: identifier(3), issueNumber: 3, companyId, title: "B private salary thread", visibility: "private", createdByUserId: B },
      {
        id: ids.bChat, identifier: identifier(4), issueNumber: 4, companyId, title: "B chat with Writer", status: "in_progress",
        conversationAgentId: agent!.id, conversationUserId: B, conversationState: "waiting", assigneeAgentId: agent!.id,
        visibility: "private", privacyRootIssueId: ids.bChat, responsibleUserId: B, createdByUserId: B,
      },
      { id: ids.inPrivateProject, identifier: identifier(5), issueNumber: 5, companyId, title: "Task in hidden project", projectId: privateProject!.id, createdByUserId: B },
    ]);
    await db.insert(issueComments).values({ companyId, issueId: ids.bPrivate, authorUserId: B, body: "B confidential comment body" });
  }, 120_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const app = (userId: string) => {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = {
        type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false,
        memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      };
      next();
    });
    server.use("/api/companies", companyRoutes(db));
    server.use(errorHandler);
    return server;
  };
  const allTasks = { include: { company: true, agents: false, projects: true, issues: true } };
  const exportAs = async (userId: string, path: string, body: Record<string, unknown> = allTasks) => {
    const res = await request(app(userId)).post(`/api/companies/${companyId}/${path}`).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return JSON.stringify(res.body);
  };
  const others = ["B private salary thread", "B chat with Writer", "B confidential comment body", "Hidden roadmap project", "Task in hidden project", identifier(3), identifier(4), identifier(5)];

  it.each(["export", "exports", "exports/preview"])("a member's %s holds no private task, chat or project of another person", async (path) => {
    const bundle = await exportAs(A, path);
    for (const text of others) expect(bundle).not.toContain(text);
    expect(bundle).toContain("Open team task");
    expect(bundle).toContain("A private notes");
  });

  it("the creator exports his own private task and its comments", async () => {
    const bundle = await exportAs(B, "export");
    for (const text of ["B private salary thread", "B confidential comment body", "Open team task"]) {
      expect(bundle).toContain(text);
    }
    expect(bundle).not.toContain("A private notes");
  });

  it("a task named by identifier or id passes the read scope too", async () => {
    const bundle = await exportAs(A, "export", { include: { company: true, agents: false }, issues: [identifier(3), ids.bChat, identifier(1)] });
    expect(bundle).not.toContain("B private salary thread");
    expect(bundle).not.toContain("B chat with Writer");
    expect(bundle).toContain("Open team task");
    expect(bundle).toContain(`Issue selector \\"${identifier(3)}\\" was not found`);
  });
});
