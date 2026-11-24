import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueAccessGrants,
  issues,
  projects,
} from "@paperclipai/db";
import {
  canActorReadIssuePrivacy,
  issueReadSqlCondition,
  type AuthorizationActor,
} from "../services/authorization.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

/**
 * PAR-12821 (chat privacy CP-1): the cut. A chat with an agent is private, but
 * work started from it stays open (PAR-12774 plan 4.3 and 4.7): AC-P9 (with F1),
 * AC-P11 and the stage C strict climb. Chats are seeded `private` directly;
 * CP-2b makes creation private later.
 */

const support = await getEmbeddedPostgresTestSupport();

describe("agent chat privacy cut database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("agent chat privacy cut", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-chat-privacy-cut-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false, enableAgentChat: true });
    await import("../routes/issues.js");
  }, 120_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const user = (userId: string): AuthorizationActor => ({ type: "board", userId, source: "session", ignoreInstanceAdmin: true });

  /** A (operator, has the chat), B (operator), O (owner); X (chat agent), Y (another agent). */
  async function seed(options: { chatOwner?: string; restricted?: boolean } = {}) {
    const companyId = randomUUID(), chatId = randomUUID();
    const A = options.chatOwner ?? `a-${randomUUID()}`, B = `b-${randomUUID()}`, O = `o-${randomUUID()}`;
    await db.insert(companies).values({
      id: companyId, name: "Chat cut", issuePrefix: `K${companyId.slice(0, 6).toUpperCase()}`,
      memberRestrictionMode: options.restricted ? "enforce" : "off",
    });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: A, status: "active", membershipRole: "operator", restricted: options.restricted ?? false },
      { companyId, principalType: "user", principalId: B, status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
    ]);
    const [X, Y] = await db.insert(agents).values([
      { companyId, name: "Writer", status: "idle", adapterType: "process" },
      { companyId, name: "Editor", status: "idle", adapterType: "process" },
    ]).returning();
    const [openProject] = await db.insert(projects).values({ companyId, name: "Open project", visibility: "open" }).returning();
    await db.insert(issues).values({
      id: chatId, companyId, title: "A's chat with X", status: "in_progress",
      conversationAgentId: X!.id, conversationUserId: A, conversationState: "waiting", assigneeAgentId: X!.id,
      visibility: "private", privacyRootIssueId: chatId, responsibleUserId: A, createdByUserId: A,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: X!.id, status: "running", responsibleUserId: A,
      nativeIssueId: chatId, contextSnapshot: { issueId: chatId, conversationSessionGeneration: 0 } });
    const readers: Record<string, AuthorizationActor> = {
      B: user(B), O: user(O), Y: { type: "agent", agentId: Y!.id, companyId, source: "agent_key" }, plugin: { type: "none" },
    };
    const row = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
    const readableBy = async (id: string) => {
      const issue = await row(id);
      return Object.fromEntries(await Promise.all(Object.entries(readers)
        .map(async ([name, actor]) => [name, await canActorReadIssuePrivacy(db, actor, issue)] as const)));
    };
    return { companyId, chatId, A, B, O, X: X!, Y: Y!, openProjectId: openProject!.id, runId, row, readableBy };
  }
  const everyone = { B: true, O: true, Y: true, plugin: true };
  const noOne = { B: false, O: false, Y: false, plugin: false };

  it("AC-P9: X, in a run on A's private chat, creates an open task in an open project that B, O, Y and a plugin read", async () => {
    const f = await seed();
    const task = await issueService(db).create(f.companyId, {
      title: "Write the launch post", projectId: f.openProjectId, createdByAgentId: f.X.id, actorRunId: f.runId,
    });
    expect(await f.row(task.id)).toMatchObject({
      parentId: null, visibility: "open", privacyParentIssueId: f.chatId, privacyRootIssueId: null, projectId: f.openProjectId,
    });
    expect(await f.readableBy(task.id)).toEqual(everyone);
    // The chat itself stays private.
    expect(await f.readableBy(f.chatId)).toEqual(noOne);
  });

  it("AC-P9: a task accepted through the chat hand-off is open and readable by B, O, Y and a plugin", async () => {
    const f = await seed({ chatOwner: "local-board" });
    const scope = { id: f.chatId, companyId: f.companyId, projectId: null, goalId: null };
    const service = issueThreadInteractionService(db);
    const suggestion = await service.create(scope, { kind: "suggest_tasks", payload: { version: 1, tasks: [
      { clientKey: "post", title: "Write the launch post" },
    ] } }, { userId: f.A });
    const accepted = await service.acceptSuggestedTasks(scope, suggestion.id, {}, { userId: f.A });
    const taskId = accepted.createdIssues[0]!.id;
    expect(await f.row(taskId)).toMatchObject({ visibility: "open", privacyParentIssueId: f.chatId, privacyRootIssueId: null });
    expect(await f.readableBy(taskId)).toEqual(everyone);
  });

  it("AC-P9 (F1b): an update whose move is flattened past a chat keeps the chat as privacy parent and stays open", async () => {
    const f = await seed();
    // A legacy chat under a task: the flatten plan places the move beside it.
    const [holder] = await db.insert(issues).values({ companyId: f.companyId, title: "Holder", status: "todo" }).returning();
    await db.update(issues).set({ parentId: holder!.id }).where(eq(issues.id, f.chatId));
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: "Loose task", status: "todo" }).returning();
    const updated = await issueService(db).update(task!.id, { parentId: f.chatId, expectedParentId: holder!.id });
    expect(updated?.parentAdjusted).toMatchObject({ applied: true, requestedParent: { id: f.chatId } });
    expect(await f.row(task!.id)).toMatchObject({
      parentId: holder!.id, visibility: "open", privacyParentIssueId: f.chatId, privacyRootIssueId: null,
    });
    expect(await f.readableBy(task!.id)).toEqual(everyone);
  });

  it("F1: a chat cannot be a structural parent, on create or update (422)", async () => {
    const f = await seed();
    await expect(issueService(db).create(f.companyId, { title: "Chat child", parentId: f.chatId }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining("Conversations cannot have new subtasks") });
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: "Loose task", status: "todo" }).returning();
    await expect(issueService(db).update(task!.id, { parentId: f.chatId }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining("Conversations cannot have new subtasks") });
    expect(await f.row(task!.id)).toMatchObject({ parentId: null, visibility: "open", privacyParentIssueId: null });
  });

  it("the read climb stops at a chat: an existing open task from a now-private chat stays readable", async () => {
    const f = await seed();
    const [legacy] = await db.insert(issues).values({
      companyId: f.companyId, title: "Task from the chat before the cut", status: "todo", privacyParentIssueId: f.chatId,
    }).returning();
    expect(await f.readableBy(legacy!.id)).toEqual(everyone);
  });

  it("making a chat private does not sweep the tasks started from it", async () => {
    const f = await seed();
    await db.update(issues).set({ visibility: "open", privacyRootIssueId: null }).where(eq(issues.id, f.chatId));
    const [fromChat] = await db.insert(issues).values({
      companyId: f.companyId, title: "Task from the open chat", status: "todo", privacyParentIssueId: f.chatId,
    }).returning();
    await issueService(db).update(f.chatId, { visibility: "private" });
    expect(await f.row(f.chatId)).toMatchObject({ visibility: "private", privacyRootIssueId: f.chatId });
    expect(await f.row(fromChat!.id)).toMatchObject({ visibility: "open", privacyRootIssueId: null, privacyParentIssueId: f.chatId });
    expect(await f.readableBy(fromChat!.id)).toEqual(everyone);
  });

  it("AC-P11: a task whose privacy parent is a private task is still private to B", async () => {
    const f = await seed();
    const parent = await issueService(db).create(f.companyId, { title: "A's private task", visibility: "private", createdByUserId: f.A, responsibleUserId: f.A });
    await db.insert(issueAccessGrants).values({ issueId: parent.id, subjectType: "user", subjectId: f.O, source: "explicit" });
    const child = await issueService(db).create(f.companyId, { title: "Work under it", parentId: parent.id, createdByAgentId: f.X.id });
    expect(await f.row(child.id)).toMatchObject({ visibility: "private", privacyParentIssueId: parent.id, privacyRootIssueId: parent.id });
    // O holds a grant on the parent; it flows down. B, Y and a plugin do not read it.
    expect(await f.readableBy(child.id)).toEqual({ B: false, O: true, Y: false, plugin: false });
    expect(await canActorReadIssuePrivacy(db, user(f.A), await f.row(child.id))).toBe(true);
  });

  it("AC-P11: the access-grants list inherits from a private task parent, not from a chat", async () => {
    const f = await seed();
    const G = `g-${randomUUID()}`;
    const parent = await issueService(db).create(f.companyId, { title: "A's private task", visibility: "private", createdByUserId: f.A, responsibleUserId: f.A });
    const child = await issueService(db).create(f.companyId, { title: "Work under it", parentId: parent.id });
    const fromChat = await issueService(db).create(f.companyId, { title: "Work from the chat", createdByAgentId: f.X.id, actorRunId: f.runId });
    await db.insert(issueAccessGrants).values([
      { issueId: parent.id, subjectType: "user", subjectId: G, source: "explicit" },
      { issueId: f.chatId, subjectType: "user", subjectId: G, source: "explicit" },
    ]);
    const { issueRoutes } = await import("../routes/issues.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", companyIds: [f.companyId], source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
    const grants = async (id: string) => {
      const res = await request(app).get(`/api/issues/${id}/access-grants`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return (res.body as Array<{ issueId: string; subjectId: string; inherited: boolean }>)
        .map((grant) => `${grant.issueId === parent.id ? "parent" : grant.issueId === f.chatId ? "chat" : "self"}:${grant.subjectId}:${grant.inherited}`).sort();
    };
    // The parent's explicit grant and its owner are inherited, as before the cut.
    expect(await grants(child.id)).toEqual(expect.arrayContaining([`parent:${G}:true`, `parent:${f.A}:true`]));
    // Neither the chat's grant nor its owner reaches work started from the chat.
    const fromChatGrants = await grants(fromChat.id);
    expect(fromChatGrants.filter((grant) => grant.startsWith("chat:") || grant.includes(G))).toEqual([]);
  });

  it("plan 4.7: a restricted member reads the task his agent created from his own chat; the private climb stops at the chat", async () => {
    const f = await seed({ restricted: true });
    const task = await issueService(db).create(f.companyId, {
      title: "Work for A", projectId: f.openProjectId, createdByAgentId: f.X.id, actorRunId: f.runId,
    });
    const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Not A's", status: "todo", projectId: f.openProjectId }).returning();
    expect(await f.row(task.id)).toMatchObject({ visibility: "open", privacyParentIssueId: f.chatId, privacyRootIssueId: null, responsibleUserId: f.A });
    const listFor = async (actor: AuthorizationActor) => (await db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, f.companyId), await issueReadSqlCondition(db, actor)))).map((r) => r.id);
    // The strict climb: A is restricted, still reads his agent's task (and his chat), not another task.
    const forA = await listFor({ type: "board", userId: f.A, authorizingUserId: f.A });
    expect(forA).toEqual(expect.arrayContaining([task.id, f.chatId]));
    expect(forA).not.toContain(other!.id);
    // The private climb stops at the chat: B reads the task, not the chat.
    const forB = await listFor({ type: "board", userId: f.B, authorizingUserId: f.B });
    expect(forB).toContain(task.id);
    expect(forB).not.toContain(f.chatId);
  });
});
