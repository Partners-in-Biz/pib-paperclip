import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  assets,
  companies,
  companyMemberships,
  createDb,
  documentMemberships,
  documents,
  instanceUserRoles,
  issueAttachments,
  issueDocuments,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import { companySearchQuerySchema } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { issueReadSqlCondition, type AuthorizationActor } from "../services/authorization.js";
import { companySearchService } from "../services/company-search.js";
import type { StorageService } from "../storage/types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12824 (chat privacy CP-3a, PAR-12774 plan 4.4 row 4): company search
 * (artifact part: `countArtifacts`, `fetchArtifactRows`) and
 * `GET /companies/:id/artifacts` take the task read condition. AC-P3: B, O, D
 * and I get neither A's chat nor a file in it; A gets both. The addition
 * (plan section 8): a private task's artifacts are listed for its readers only.
 */

const support = await getEmbeddedPostgresTestSupport();

describe("agent chat privacy artifacts database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("agent chat privacy: artifact search and artifact list", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-chat-privacy-artifacts-");
    db = createDb(tempDb.connectionString);
  }, 120_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  /**
   * A (operator, chats with agent X), B (operator), O (owner), D (admin),
   * I (owner and instance admin). Each task holds one agent document, one agent
   * file and one work product, all named "Brief": `chat` (A's legacy open chat),
   * `secret` (O's private task, not a chat), `task` (an open task) and `child`
   * (open work started from the chat, so its parent is the chat).
   */
  async function seed() {
    const companyId = randomUUID();
    const A = `a-${randomUUID()}`, B = `b-${randomUUID()}`, O = `o-${randomUUID()}`;
    const D = `d-${randomUUID()}`, I = `i-${randomUUID()}`;
    const roles = { [A]: "operator", [B]: "operator", [O]: "owner", [D]: "admin", [I]: "owner" };
    await db.insert(companies).values({ id: companyId, name: "Artifacts", issuePrefix: `R${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(companyMemberships).values(Object.entries(roles).map(([principalId, membershipRole]) =>
      ({ companyId, principalType: "user", principalId, status: "active", membershipRole })));
    await db.insert(instanceUserRoles).values({ userId: I, role: "instance_admin" });
    const [X] = await db.insert(agents).values({ companyId, name: "Writer", status: "idle", adapterType: "process" }).returning();
    const chatId = randomUUID();
    const rows: (typeof issues.$inferInsert)[] = [
      { id: chatId, companyId, title: "Chat with Writer", status: "in_progress", visibility: "open", conversationAgentId: X!.id,
        conversationUserId: A, conversationState: "waiting", assigneeAgentId: X!.id, createdByUserId: A, responsibleUserId: A },
      { id: randomUUID(), companyId, title: "Lawyers", status: "todo", visibility: "private", createdByUserId: O },
      { id: randomUUID(), companyId, title: "Launch", status: "todo", createdByUserId: O },
      { id: randomUUID(), companyId, title: "Started from chat", status: "todo", parentId: chatId, createdByUserId: A },
    ];
    await db.insert(issues).values(rows);
    const [chat, secret, task, child] = rows.map(row => row.id!);
    const ids = { chat: chat!, secret: secret!, task: task!, child: child! };
    for (const [name, issueId] of Object.entries(ids)) {
      const [doc] = await db.insert(documents).values({ companyId, title: `Brief ${name} notes`, latestBody: "Brief body", createdByAgentId: X!.id }).returning();
      await db.insert(issueDocuments).values({ companyId, issueId, documentId: doc!.id, key: `brief-${name}` });
      const [asset] = await db.insert(assets).values({ companyId, provider: "local_disk", objectKey: `brief-${name}.png`, contentType: "image/png",
        byteSize: 10, sha256: `sha-${name}-${randomUUID()}`, originalFilename: `brief-${name}.png`, createdByAgentId: X!.id }).returning();
      await db.insert(issueAttachments).values({ companyId, issueId, assetId: asset!.id });
      await db.insert(issueWorkProducts).values({ companyId, issueId, type: "artifact", provider: "paperclip", title: `Brief ${name} cut`, status: "ready" });
    }
    // A uploads a file in his chat: a document he wrote and an image. A person's
    // upload shows in the artifact list only as a starred document; B's star is
    // seeded as if it predates the chat rule.
    const [upload] = await db.insert(documents).values({ companyId, title: "Upload from A", latestBody: "A's file", createdByUserId: A }).returning();
    await db.insert(issueDocuments).values({ companyId, issueId: chat!, documentId: upload!.id, key: "upload-from-a" });
    await db.insert(documentMemberships).values([A, B].map(userId => ({ companyId, documentId: upload!.id, userId, starredAt: new Date() })));
    const [image] = await db.insert(assets).values({ companyId, provider: "local_disk", objectKey: "upload-from-a.png", contentType: "image/png",
      byteSize: 10, sha256: `sha-upload-${randomUUID()}`, originalFilename: "upload-from-a.png", createdByUserId: A }).returning();
    await db.insert(issueAttachments).values({ companyId, issueId: chat!, assetId: image!.id });
    const user = (userId: string, extra: Partial<AuthorizationActor> = {}): AuthorizationActor => ({
      type: "board", userId, source: "session", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: false, restrictionMode: "off" }],
      ...extra,
    } as AuthorizationActor);
    /** The task names the artifacts come from; each task gives three. */
    const names = (issueIds: string[]) => {
      const byId = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
      return [...new Set(issueIds.map(id => byId.get(id) ?? id))].sort();
    };
    const search = async (actor: AuthorizationActor) => {
      const result = await companySearchService(db).search(companyId, companySearchQuerySchema.parse({ q: "Brief", limit: 50 }), {
        issueReadCondition: await issueReadSqlCondition(db, actor),
      });
      const artifacts = result.results.filter(row => row.type === "artifact");
      return { tasks: names(artifacts.map(row => row.artifact!.issueId)), count: result.countsByType.artifact, shown: artifacts.length };
    };
    const app = (actor: AuthorizationActor) => {
      const server = express();
      server.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
      server.use("/api/companies", companyRoutes(db, {} as StorageService));
      server.use(errorHandler);
      return server;
    };
    const list = async (actor: AuthorizationActor, query = "limit=100") => {
      const res = await request(app(actor)).get(`/api/companies/${companyId}/artifacts?${query}`);
      expect(res.status).toBe(200);
      return res.body as { artifacts: { issue: { id: string } }[]; groups?: { issue: { id: string; title: string } }[]; selectedGroup?: unknown };
    };
    const listed = async (actor: AuthorizationActor) => names((await list(actor)).artifacts.map(row => row.issue.id));
    return { companyId, A, B, O, D, I, ids, user, search, list, listed };
  }

  it("AC-P3: A gets his chat's files from company search and from the artifact list", async () => {
    const f = await seed();
    expect(await f.search(f.user(f.A))).toEqual({ tasks: ["chat", "child", "task"], count: 9, shown: 9 });
    expect(await f.listed(f.user(f.A))).toEqual(["chat", "child", "task"]);
    expect((await f.list(f.user(f.A), "starred=true")).artifacts.map(row => row.issue.id)).toEqual([f.ids.chat]);
    const found = await companySearchService(db).search(f.companyId, companySearchQuerySchema.parse({ q: "upload from A" }), {
      issueReadCondition: await issueReadSqlCondition(db, f.user(f.A)),
    });
    expect(found.results.map(row => row.issue?.id ?? row.id)).toContain(f.ids.chat);
  });

  it("AC-P3: B, O, D and I get no file of A's chat from company search or the artifact list", async () => {
    const f = await seed();
    for (const actor of [f.user(f.B), f.user(f.D)]) {
      expect(await f.search(actor)).toEqual({ tasks: ["child", "task"], count: 6, shown: 6 });
      expect(await f.listed(actor)).toEqual(["child", "task"]);
    }
    // B's old star on A's upload does not bring it back.
    expect(await f.list(f.user(f.B), "starred=true")).toEqual({ artifacts: [], nextCursor: null });
    for (const actor of [f.user(f.B), f.user(f.O), f.user(f.I)]) {
      const result = await companySearchService(db).search(f.companyId, companySearchQuerySchema.parse({ q: "upload from A" }), {
        issueReadCondition: await issueReadSqlCondition(db, actor),
      });
      expect(result.results).toEqual([]);
    }
    // O reads his private task; I is owner and instance admin: no chat either way.
    for (const actor of [f.user(f.O), f.user(f.I), f.user(f.I, { isInstanceAdmin: true })]) {
      expect(await f.search(actor)).toEqual({ tasks: ["child", "secret", "task"], count: 9, shown: 9 });
      expect(await f.listed(actor)).toEqual(["child", "secret", "task"]);
    }
  });

  it("the artifact groups do not name the chat for B: no root group, no selected group", async () => {
    const f = await seed();
    const groups = async (actor: AuthorizationActor) =>
      ((await f.list(actor, "groupBy=parent_task&limit=100")).groups ?? []).map(group => group.issue.id).sort();
    expect(await groups(f.user(f.A))).toEqual([f.ids.chat, f.ids.task].sort());
    expect(await groups(f.user(f.B))).toEqual([f.ids.child, f.ids.task].sort());
    const selected = await f.list(f.user(f.B), `groupBy=task&groupIssueId=${f.ids.chat}`);
    expect(selected).toEqual({ artifacts: [], selectedGroup: null, nextCursor: null });
    expect((await f.list(f.user(f.A), `groupBy=task&groupIssueId=${f.ids.chat}`)).artifacts).toHaveLength(3);
  });

  it("addition: a private task that is not a chat lists its files for its readers only", async () => {
    const f = await seed();
    expect((await f.search(f.user(f.B))).tasks).not.toContain("secret");
    expect(await f.listed(f.user(f.B))).not.toContain("secret");
    expect(await f.listed(f.user(f.A))).not.toContain("secret");
    expect((await f.search(f.user(f.O))).tasks).toContain("secret");
    expect(await f.listed(f.user(f.O))).toContain("secret");
  });
});
