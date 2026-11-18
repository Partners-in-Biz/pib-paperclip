import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  documents,
  issueAttachments,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12942 (access C4j-1, PAR-12608 4.6 and AC-G3): document lock, unlock and
 * delete, the attachment upload and the chat comment post ask `issue:read`
 * before any other answer. A caller who cannot read the task gets 404 "Issue
 * not found" and nothing is written; a caller who can read gets today's answer.
 */

const support = await getEmbeddedPostgresTestSupport();

describe("issue document and upload read guard database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("read the task first on document lock, unlock, delete, upload and chat post", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let storageDir = "";

  // O owns company C (a session, not the local board); U is a member of C.
  const O = `o-${randomUUID()}`, U = `u-${randomUUID()}`;
  const roles: Record<string, string> = { [O]: "owner", [U]: "operator" };
  let companyId = "", otherCompanyId = "", X = "", Z = "", chatId = "", privateId = "", foreignTaskId = "";
  const NOT_FOUND = { error: "Issue not found" };

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: false, restrictionMode: "off" }],
  });
  const agent = (agentId: string): RequestActor => ({ type: "agent", agentId, companyId, source: "agent_key" });
  const appFor = (actor: RequestActor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, createStorageService(createLocalDiskStorageProvider(storageDir))));
    app.use(errorHandler);
    return app;
  };
  const docPath = (issueId: string) => `/api/issues/${issueId}/documents/notes`;
  const writes = {
    lock: (actor: RequestActor, issueId: string) => request(appFor(actor)).post(`${docPath(issueId)}/lock`),
    unlock: (actor: RequestActor, issueId: string) => request(appFor(actor)).post(`${docPath(issueId)}/unlock`),
    delete: (actor: RequestActor, issueId: string) => request(appFor(actor)).delete(docPath(issueId)),
  };
  const upload = (actor: RequestActor, issueId: string, pathCompanyId = companyId) =>
    request(appFor(actor)).post(`/api/companies/${pathCompanyId}/issues/${issueId}/attachments`)
      .attach("file", Buffer.from("read guard upload"), "note.txt");
  const notesDoc = async (issueId: string) => (await db
    .select({ id: documents.id, lockedAt: documents.lockedAt, lockedByUserId: documents.lockedByUserId })
    .from(issueDocuments).innerJoin(documents, eq(documents.id, issueDocuments.documentId))
    .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, "notes"))))[0] ?? null;
  const storedFiles = async () => (await readdir(storageDir, { recursive: true, withFileTypes: true })).filter(e => e.isFile()).length;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-read-guard-");
    db = createDb(tempDb.connectionString);
    storageDir = await mkdtemp(path.join(tmpdir(), "issue-read-guard-storage-"));
    const prefix = `G${randomUUID().slice(0, 5).toUpperCase()}`;
    const [c, d] = await db.insert(companies).values([
      { name: "Read guard", issuePrefix: prefix, requireBoardApprovalForNewAgents: false },
      { name: "Other company", issuePrefix: `${prefix}D`, requireBoardApprovalForNewAgents: false },
    ]).returning();
    companyId = c!.id; otherCompanyId = d!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, U].map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole: membershipRole as "owner", grantedByUserId: null });
    }
    const noWake = { heartbeat: { enabled: false, wakeOnDemand: false } };
    const [x, z] = await db.insert(agents).values([
      { companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: noWake },
      { companyId, name: "Editor", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: noWake },
    ]).returning();
    X = x!.id; Z = z!.id;
    await db.insert(companyMemberships).values([X, Z].map(principalId =>
      ({ companyId, principalType: "agent", principalId, status: "active", membershipRole: "member" })));
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });

    // O's chat with X through the real chat route, so it is created private (PAR-12823).
    const chat = await request(appFor(user(O))).post(`/api/companies/${companyId}/chats/${X}`);
    expect(chat.status, JSON.stringify(chat.body)).toBe(200);
    expect(chat.body).toMatchObject({ visibility: "private", conversationUserId: O });
    chatId = chat.body.id;
    privateId = (await issueService(db).create(companyId, {
      title: "O's private plan", status: "todo", visibility: "private", createdByUserId: O, responsibleUserId: O,
    })).id;
    const [foreign] = await db.insert(issues).values({ companyId: otherCompanyId, title: "D's task", status: "todo" }).returning();
    foreignTaskId = foreign!.id;

    for (const issueId of [chatId, privateId]) {
      const put = await request(appFor(user(O))).put(docPath(issueId)).send({ title: "Notes", format: "markdown", body: "Notes" });
      expect(put.status, JSON.stringify(put.body)).toBe(201);
      // O locks his own document: today's answer for a caller who can read.
      expect((await writes.lock(user(O), issueId)).status).toBe(200);
    }
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  for (const op of ["lock", "unlock", "delete"] as const) {
    it(`AC-G3: U ${op} on O's chat and O's private task answers 404 and writes nothing`, async () => {
      for (const issueId of [chatId, privateId]) {
        // A locked document refuses any delete, so the delete case runs on an unlocked one.
        if (op === "delete") expect((await writes.unlock(user(O), issueId)).status).toBe(200);
        const before = await notesDoc(issueId);
        const res = await writes[op](user(U), issueId);
        expect(res.status, `${op} ${issueId}: ${JSON.stringify(res.body)}`).toBe(404);
        expect(res.body).toEqual(NOT_FOUND);
        const after = await notesDoc(issueId);
        expect(after, "the document is still there").not.toBeNull();
        expect(after).toEqual(before);
        expect(after!.lockedByUserId).toBe(op === "delete" ? null : O);
      }
      const rows = await db.select().from(activityLog).where(and(eq(activityLog.actorId, U), inArray(activityLog.action,
        ["issue.document_locked", "issue.document_unlocked", "issue.document_deleted"])));
      expect(rows).toEqual([]);
    });
  }

  it("AC-G3: U uploads to O's chat: 404, no attachment row, no stored file", async () => {
    const files = await storedFiles();
    const res = await upload(user(U), chatId);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, chatId))).toEqual([]);
    expect(await storedFiles()).toBe(files);
  });

  it("AC-G3: U posts a message on O's chat: 404, no comment row", async () => {
    for (const body of ["Hello", "/new"]) {
      const res = await request(appFor(user(U))).post(`/api/issues/${chatId}/comments`).send({ body, clientRequestId: randomUUID() });
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, chatId))).toEqual([]);
  });

  it("an agent of C that is not the chat's agent gets 404 on lock (was 403)", async () => {
    const before = await notesDoc(chatId);
    const res = await writes.lock(agent(Z), chatId);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
    expect(await notesDoc(chatId)).toEqual(before);
  });

  it("an upload naming company C and a task of company D answers 404 like a missing task (was 422)", async () => {
    const res = await upload(user(O), foreignTaskId);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, foreignTaskId))).toEqual([]);
  });

  it("O on his own chat and private task gets today's answers: unlock, lock, upload, comment, delete", async () => {
    for (const issueId of [chatId, privateId]) {
      expect((await writes.unlock(user(O), issueId)).status).toBe(200);
      expect((await notesDoc(issueId))!.lockedAt).toBeNull();
      expect((await writes.lock(user(O), issueId)).status).toBe(200);
      const uploaded = await upload(user(O), issueId);
      expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
      const comment = await request(appFor(user(O))).post(`/api/issues/${issueId}/comments`)
        .send({ body: "Hello Writer", clientRequestId: randomUUID() });
      expect(comment.status, JSON.stringify(comment.body)).toBe(201);
      expect((await writes.unlock(user(O), issueId)).status).toBe(200);
      const removed = await writes.delete(user(O), issueId);
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(await notesDoc(issueId)).toBeNull();
    }
  });
});
