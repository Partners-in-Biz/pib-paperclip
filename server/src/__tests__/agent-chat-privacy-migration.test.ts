import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { canActorReadIssuePrivacy, type AuthorizationActor } from "../services/authorization.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12830 (chat privacy CP-5, PAR-12774 plan 4.6, stage 2): migration 0457 makes every existing chat
 * with an agent private, in all companies, without touching updated_at. AC-P10, plus the undo from the PR.
 */

const support = await getEmbeddedPostgresTestSupport();
const migrationUrl = new URL("../../../packages/db/src/migrations/0457_agent_chats_private.sql", import.meta.url);
const UNDO = "UPDATE issues SET visibility = 'open', privacy_root_issue_id = NULL WHERE conversation_agent_id IS NOT NULL";

describe("agent chat privacy migration database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("agent chat privacy migration (0457)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let migration = "";
  const old = new Date("2026-01-02T03:04:05.000Z");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-chat-privacy-migration-");
    db = createDb(tempDb.connectionString);
    migration = await readFile(migrationUrl, "utf8");
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  /** A (operator, has the chat with X), B (operator). The chat is open, as every chat made before CP-2b. */
  async function seed() {
    const A = `a-${randomUUID()}`, B = `b-${randomUUID()}`;
    const prefix = `M${randomUUID().slice(0, 5).toUpperCase()}`;
    const [company] = await db.insert(companies).values({ name: "Chat migration", issuePrefix: prefix }).returning();
    const companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values([A, B].map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const principalId of [A, B]) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole: "operator" });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole: "operator", grantedByUserId: null });
    }
    const [X] = await db.insert(agents).values({ companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "process" }).returning();
    const chatId = randomUUID();
    await db.insert(issues).values({
      id: chatId, companyId, title: "A's chat with X", status: "in_progress", issueNumber: 1, identifier: `${prefix}-1`,
      conversationAgentId: X!.id, conversationUserId: A, conversationState: "waiting", assigneeAgentId: X!.id,
      visibility: "open", privacyRootIssueId: null, createdByUserId: A, responsibleUserId: A, createdAt: old, updatedAt: old,
    });
    const [task] = await db.insert(issues).values({
      companyId, title: "Task from the chat", status: "todo", issueNumber: 2, identifier: `${prefix}-2`,
      visibility: "open", privacyParentIssueId: chatId, createdByUserId: A, createdAt: old, updatedAt: old,
    }).returning();
    return { companyId, A, B, chatId, taskId: task!.id };
  }

  const row = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const runMigration = () => db.execute(sql.raw(migration));
  const actor = (userId: string): AuthorizationActor => ({ type: "board", userId, source: "session", ignoreInstanceAdmin: true });
  const privacyAllows = async (userId: string, id: string) => canActorReadIssuePrivacy(db, actor(userId), await row(id));
  const appFor = (companyId: string, userId: string) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
        memberships: [{ companyId, membershipRole: "operator", status: "active", restricted: false, restrictionMode: "off" }],
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  };

  it("AC-P10: an open task whose privacy parent is an open chat; after the migration the chat is private, updated_at unchanged, B reads the task, not the chat, A opens the chat", async () => {
    const f = await seed();
    // Before: the visibility flag lets B through; only the chat rule (CP-2a-2) keeps B out.
    expect(await privacyAllows(f.B, f.chatId)).toBe(true);

    await runMigration();

    const chat = await row(f.chatId);
    expect(chat).toMatchObject({ visibility: "private", privacyRootIssueId: f.chatId });
    expect(chat.updatedAt.toISOString()).toBe(old.toISOString());
    const task = await row(f.taskId);
    expect(task).toMatchObject({ visibility: "open", privacyParentIssueId: f.chatId, privacyRootIssueId: null });
    expect(task.updatedAt.toISOString()).toBe(old.toISOString());

    // The flag itself now keeps B out of the chat, and still lets B read the task.
    expect(await privacyAllows(f.B, f.chatId)).toBe(false);
    expect(await privacyAllows(f.B, f.taskId)).toBe(true);
    expect(await privacyAllows(f.A, f.chatId)).toBe(true);

    const asB = appFor(f.companyId, f.B);
    expect((await request(asB).get(`/api/issues/${f.taskId}`)).status).toBe(200);
    expect((await request(asB).get(`/api/issues/${f.chatId}`)).status).toBe(404);
    expect((await request(asB).get(`/api/issues/${f.chatId}/comments`)).status).toBe(404);
    const asA = appFor(f.companyId, f.A);
    const opened = await request(asA).get(`/api/issues/${f.chatId}`);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body).toMatchObject({ id: f.chatId, visibility: "private" });
    expect((await request(asA).get(`/api/issues/${f.chatId}/comments`)).status).toBe(200);
  });

  it("covers every company, skips chats already private and leaves non-chat issues alone; a second run changes nothing", async () => {
    const first = await seed(), second = await seed();
    // A chat made private by CP-2b keeps its row as it is (its updated_at too).
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: second.chatId, updatedAt: old }).where(eq(issues.id, second.chatId));
    const [plain] = await db.insert(issues).values({
      companyId: first.companyId, title: "Plain open task", status: "todo", createdByUserId: first.A, createdAt: old, updatedAt: old,
    }).returning();

    await runMigration();
    const after = await Promise.all([first.chatId, second.chatId, plain!.id].map(row));
    expect(after[0]).toMatchObject({ visibility: "private", privacyRootIssueId: first.chatId });
    expect(after[1]).toMatchObject({ visibility: "private", privacyRootIssueId: second.chatId });
    expect(after[2]).toMatchObject({ visibility: "open", privacyRootIssueId: null });
    for (const issue of after) expect(issue.updatedAt.toISOString()).toBe(old.toISOString());

    await runMigration();
    expect(await Promise.all([first.chatId, second.chatId, plain!.id].map(row))).toEqual(after);
    const [{ open }] = (await db.execute(sql`SELECT count(*)::int AS open FROM issues
      WHERE conversation_agent_id IS NOT NULL AND visibility <> 'private'`)) as unknown as Array<{ open: number }>;
    expect(open).toBe(0);
  });

  it("the undo in the PR puts every chat back to open with no privacy root, and the task stays as it was", async () => {
    const f = await seed();
    await runMigration();
    await db.execute(sql.raw(UNDO));
    expect(await row(f.chatId)).toMatchObject({ visibility: "open", privacyRootIssueId: null });
    expect(await row(f.taskId)).toMatchObject({ visibility: "open", privacyParentIssueId: f.chatId, privacyRootIssueId: null });
    expect(await privacyAllows(f.B, f.chatId)).toBe(true);
    // The chat rule still keeps B out after the undo.
    expect((await request(appFor(f.companyId, f.B)).get(`/api/issues/${f.chatId}`)).status).toBe(404);
  });
});
