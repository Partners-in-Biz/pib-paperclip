import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, authUsers, companies, companyMemberships, createDb, documents as documentRows, heartbeatRuns,
  issueAttachments, issueDocuments, issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { documentAnnotationService, documentService, issueService, workProductService } from "../services/index.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { MEMBER_RESTRICTION_ROUTE_TABLE } from "../services/member-restriction/route-table.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12732 (C4b-2): the document, annotation, work-product and attachment
 * rows of the route table. Spec PAR-12608 rev 3, 4.6. AC-G3: for every `open`
 * row, R (restricted in Y) asks for O's object through that route and gets
 * "not found"; a control call with the kill switch on reaches the object, so
 * the answer is the restriction. Scope callers (section 8): R as owner of X,
 * and an instance admin who is not a member of Y, get today's answer. This
 * area has no `run`, no `by-company` and no `closed` rows.
 * PAR-12943 (C4j-2): document lock, unlock, delete and attachment upload are
 * open now that their handlers read the task first (PAR-12942). The app runs
 * the route-table middleware above the routes, as `app.ts` does.
 */

/** `on`: every restriction read fails (AC-X1). */
const resolverFails = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  const fail = () => Promise.reject(new actual.MemberRestrictionReadError("fixture: restriction unreadable"));
  return {
    ...actual,
    memberRestrictionFor: (...args: Parameters<typeof actual.memberRestrictionFor>) =>
      resolverFails.on ? fail() : actual.memberRestrictionFor(...args),
    memberRestrictionEnforcedCompanyIds: (...args: Parameters<typeof actual.memberRestrictionEnforcedCompanyIds>) =>
      resolverFails.on ? fail() : actual.memberRestrictionEnforcedCompanyIds(...args),
    memberRestrictionResolver: (db: Parameters<typeof actual.memberRestrictionResolver>[0]) =>
      (personId: string, companyId: string) => resolverFails.on ? fail() : actual.memberRestrictionFor(db, personId, companyId),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const THIS_FILE = "server/src/__tests__/member-restriction-route-table-documents.test.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

describe("document, work-product and attachment route rows database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Res = request.Response;
type Ids = {
  companyId: string; issueId: string; key: string; firstRevisionId: string; latestRevisionId: string;
  threadId: string; workProductId: string; attachmentId: string;
};

/** One request per row; every row answers R with "Issue not found". */
type Case = {
  row: string;
  send: (client: request.SuperTest<request.Test>, ids: Ids) => request.Test;
};

const KEY = "plan";
const BODY = "Owner wrote this document.";
const doc = ({ issueId }: Ids) => `/api/issues/${issueId}/documents/${KEY}`;
/** The four rows C4j-2 opens (PAR-12943). `pathCompanyId` is the upload's path company; it defaults to the task's. */
const WRITES = {
  lock: (c: request.SuperTest<request.Test>, ids: Ids) => c.post(`${doc(ids)}/lock`),
  unlock: (c: request.SuperTest<request.Test>, ids: Ids) => c.post(`${doc(ids)}/unlock`),
  delete: (c: request.SuperTest<request.Test>, ids: Ids) => c.delete(doc(ids)),
  upload: (c: request.SuperTest<request.Test>, ids: Ids, pathCompanyId = ids.companyId) =>
    c.post(`/api/companies/${pathCompanyId}/issues/${ids.issueId}/attachments`).attach("file", Buffer.from("R's file"), "r.txt"),
};
type Write = keyof typeof WRITES;
const WRITE_NAMES = Object.keys(WRITES) as Write[];

const CASES: Case[] = [
  { row: "GET /api/issues/:id/documents", send: (c, { issueId }) => c.get(`/api/issues/${issueId}/documents`) },
  { row: "GET /api/issues/:id/documents/:key", send: (c, ids) => c.get(doc(ids)) },
  { row: "PUT /api/issues/:id/documents/:key",
    send: (c, ids) => c.put(doc(ids)).send({ format: "markdown", body: `${BODY} Edited.`, baseRevisionId: ids.latestRevisionId }) },
  { row: "GET /api/issues/:id/documents/:key/revisions", send: (c, ids) => c.get(`${doc(ids)}/revisions`) },
  { row: "GET /api/issues/:id/documents/:key/revisions/:revisionId",
    send: (c, ids) => c.get(`${doc(ids)}/revisions/${ids.firstRevisionId}`) },
  { row: "POST /api/issues/:id/documents/:key/revisions/:revisionId/restore",
    send: (c, ids) => c.post(`${doc(ids)}/revisions/${ids.firstRevisionId}/restore`).send({}) },
  { row: "GET /api/issues/:id/documents/:key/annotations", send: (c, ids) => c.get(`${doc(ids)}/annotations`) },
  { row: "POST /api/issues/:id/documents/:key/annotations",
    send: (c, ids) => c.post(`${doc(ids)}/annotations`).send({
      baseRevisionId: ids.latestRevisionId, baseRevisionNumber: 2, body: "A note",
      selector: {
        quote: { exact: "Owner", prefix: "", suffix: " wrote" },
        position: { normalizedStart: 0, normalizedEnd: 5, markdownStart: 0, markdownEnd: 5 },
      },
    }) },
  { row: "GET /api/issues/:id/documents/:key/annotations/:threadId",
    send: (c, ids) => c.get(`${doc(ids)}/annotations/${ids.threadId}`) },
  { row: "PATCH /api/issues/:id/documents/:key/annotations/:threadId",
    send: (c, ids) => c.patch(`${doc(ids)}/annotations/${ids.threadId}`).send({ status: "resolved" }) },
  { row: "POST /api/issues/:id/documents/:key/annotations/:threadId/comments",
    send: (c, ids) => c.post(`${doc(ids)}/annotations/${ids.threadId}/comments`).send({ body: "A reply" }) },
  { row: "GET /api/issues/:id/work-products", send: (c, { issueId }) => c.get(`/api/issues/${issueId}/work-products`) },
  { row: "POST /api/issues/:id/work-products",
    send: (c, { issueId }) => c.post(`/api/issues/${issueId}/work-products`)
      .send({ type: "preview_url", provider: "custom", title: "Preview", url: "https://example.test/preview" }) },
  { row: "POST /api/issues/:id/work-products/:workProductId/review-document",
    send: (c, { issueId, workProductId }) => c.post(`/api/issues/${issueId}/work-products/${workProductId}/review-document`).send({}) },
  { row: "PATCH /api/work-products/:id",
    send: (c, { workProductId }) => c.patch(`/api/work-products/${workProductId}`).send({ title: "Renamed" }) },
  { row: "DELETE /api/work-products/:id", send: (c, { workProductId }) => c.delete(`/api/work-products/${workProductId}`) },
  { row: "GET /api/issues/:id/attachments", send: (c, { issueId }) => c.get(`/api/issues/${issueId}/attachments`) },
  { row: "GET /api/attachments/:attachmentId/content",
    send: (c, { attachmentId }) => c.get(`/api/attachments/${attachmentId}/content`) },
  { row: "DELETE /api/attachments/:attachmentId", send: (c, { attachmentId }) => c.delete(`/api/attachments/${attachmentId}`) },
  { row: "POST /api/issues/:id/documents/:key/lock", send: WRITES.lock },
  { row: "POST /api/issues/:id/documents/:key/unlock", send: WRITES.unlock },
  { row: "DELETE /api/issues/:id/documents/:key", send: WRITES.delete },
  { row: "POST /api/companies/:companyId/issues/:issueId/attachments", send: (c, ids) => WRITES.upload(c, ids) },
];

it("every open row of this file has exactly one case, and each case is an open row", () => {
  const rows = MEMBER_RESTRICTION_ROUTE_TABLE
    .filter((entry) => entry.test === THIS_FILE)
    .map((entry) => `${entry.method} ${entry.path}`);
  expect(CASES.map((entry) => entry.row).sort()).toEqual([...rows].sort());
  for (const entry of CASES) {
    expect(MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === entry.row)!.class, entry.row).toBe("open");
  }
});

(support.supported ? describe : describe.skip)("document, work-product and attachment rows of the route table (PAR-12608 4.6, AC-G3)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let root = "";
  let storage: ReturnType<typeof createStorageService>;
  let app: express.Express;
  let actor: Actor;

  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const ADMIN = `instance-admin-${randomUUID()}`;
  let Y = "";
  let X = "";
  /** D: R is no member. Z: R is restricted, the company's mode is `off`. */
  let D = "";
  let Z = "";

  const as = (who: Actor) => {
    actor = who;
    return request(app);
  };
  const boardFor = async (userId: string, isInstanceAdmin = false): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return {
      type: "board", userId, source: "session", isInstanceAdmin, memberships,
      companyIds: memberships.map((row: { companyId: string }) => row.companyId),
    } as Actor;
  };
  /** Fresh objects per request, so a write that goes through cannot change the next case. */
  const ids = async (companyId: string, owner: string): Promise<Ids> => {
    const [task] = await db.insert(issues).values({
      companyId, title: `Task ${randomUUID().slice(0, 8)}`, status: "todo", createdByUserId: owner, responsibleUserId: owner,
    }).returning();
    const issueId = task!.id;
    const documents = documentService(db);
    const first = await documents.upsertIssueDocument({ issueId, key: KEY, format: "markdown", body: "Owner wrote this.", createdByUserId: owner });
    const latest = await documents.upsertIssueDocument({
      issueId, key: KEY, format: "markdown", body: BODY, baseRevisionId: first.document.latestRevisionId, createdByUserId: owner,
    });
    const thread = await documentAnnotationService(db).createThread(issueId, KEY, {
      baseRevisionId: latest.document.latestRevisionId!, baseRevisionNumber: 2, body: "Owner's note",
      selector: {
        quote: { exact: "Owner", prefix: "", suffix: " wrote" },
        position: { normalizedStart: 0, normalizedEnd: 5, markdownStart: 0, markdownEnd: 5 },
      },
    }, { actorType: "user", actorId: owner, userId: owner });
    const stored = await storage.putFile({
      companyId, namespace: `issues/${issueId}`, originalFilename: "owner.md", contentType: "text/markdown", body: Buffer.from("# Owner"),
    });
    const attachment = await issueService(db).createAttachment({ issueId, issueCommentId: null, ...stored, createdByUserId: owner });
    // An attachment-backed artifact, so `review-document` has something to build from.
    const contentPath = `/api/attachments/${attachment.id}/content`;
    const workProduct = await workProductService(db).createForIssue(issueId, companyId, {
      type: "artifact", provider: "paperclip", title: "Owner's report", status: "active",
      metadata: {
        attachmentId: attachment.id, contentType: "text/markdown", byteSize: stored.byteSize, contentPath,
        openPath: contentPath, downloadPath: `${contentPath}?download=1`, originalFilename: "owner.md",
      },
    });
    return {
      companyId, issueId, key: KEY, firstRevisionId: first.document.latestRevisionId!, latestRevisionId: latest.document.latestRevisionId!,
      threadId: thread.id, workProductId: workProduct!.id, attachmentId: attachment.id,
    };
  };
  /** The same request with the kill switch on: today's answer. */
  const today = async <T,>(send: () => Promise<T>): Promise<T> => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    try {
      return await send();
    } finally {
      vi.unstubAllEnvs();
    }
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-route-table-documents-");
    db = createDb(tempDb.connectionString);
    root = await mkdtemp(path.join(tmpdir(), "restriction-route-table-documents-"));
    storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "storage")));
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", memberRestrictionRouteGuard(db));
    app.use("/api", issueRoutes(db, storage));
    app.use(errorHandler);

    const [y, x, d, z] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "D", issuePrefix: `D${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "Z", issuePrefix: `Z${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "off" },
    ]).returning();
    Y = y!.id;
    X = x!.id;
    D = d!.id;
    Z = z!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R, ADMIN].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
      { companyId: X, principalType: "user", principalId: R, status: "active", membershipRole: "owner" },
      { companyId: D, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Z, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Z, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  describe.each(CASES)("$row", (entry) => {
    it("AC-G3: R (restricted in Y) asking for O's object gets \"not found\"", async () => {
      const send = async () => entry.send(as(await boardFor(R)), await ids(Y, O));
      const enforced = await send();
      expect(enforced.status, JSON.stringify(enforced.body)).toBe(404);
      expect(enforced.body).toEqual({ error: "Issue not found" });
      // Control: with the kill switch on the same call reaches O's object, so
      // the answer above is the restriction and not a broken request.
      const open = await today(send);
      expect(open.status, JSON.stringify(open.body)).toBeLessThan(300);
    });

    it("scope callers: R as owner of X, and an instance admin who is no member of Y, get today's answer", async () => {
      // Set-up first, then the caller sets the actor.
      const callAs = async (who: () => Promise<Actor>, target: Promise<Ids>) => {
        const ready = await target;
        return entry.send(as(await who()), ready);
      };
      const ownX = () => callAs(() => boardFor(R), ids(X, R));
      const ownXNow = await ownX();
      expect(ownXNow.status, JSON.stringify(ownXNow.body)).toBe((await today(ownX)).status);
      expect(ownXNow.status, JSON.stringify(ownXNow.body)).toBeLessThan(300);

      const admin = () => callAs(() => boardFor(ADMIN, true), ids(Y, O));
      const adminNow = await admin();
      expect(adminNow.status, JSON.stringify(adminNow.body)).toBe((await today(admin)).status);
    });
  });

  describe("C4j-2 (PAR-12943): lock, unlock, delete and upload (AC-G3, AC-G12, AC-F8, AC-X1)", () => {
    const NOT_FOUND = { error: "Issue not found" };
    /** The document, its lock and its latest revision. */
    const docState = async ({ issueId }: Ids) => (await db
      .select({ id: documentRows.id, lockedAt: documentRows.lockedAt, lockedByUserId: documentRows.lockedByUserId,
        latestRevisionId: documentRows.latestRevisionId })
      .from(issueDocuments).innerJoin(documentRows, eq(documentRows.id, issueDocuments.documentId))
      .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, KEY))))[0] ?? null;
    const attachmentsOf = async ({ issueId }: Ids) =>
      (await db.select({ id: issueAttachments.id }).from(issueAttachments).where(eq(issueAttachments.issueId, issueId))).length;
    const documentActivity = async ({ issueId }: Ids) => (await db.select({ id: activityLog.id }).from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), inArray(activityLog.action,
        ["issue.document_locked", "issue.document_unlocked", "issue.document_deleted"])))).length;
    /** What a refused write must leave: the document, its lock, its activity and the attachment rows as they were. */
    const snapshot = async (ids: Ids) =>
      ({ doc: await docState(ids), attachments: await attachmentsOf(ids), activity: await documentActivity(ids) });
    const expectNotFound = (res: Res) => {
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    };
    /** Today's answer of each write for a caller who can read the task and may write. */
    const SUCCESS: Record<Write, number> = { lock: 200, unlock: 200, delete: 200, upload: 201 };

    /** A run on R's task working for R, as `auth.ts` builds its actor. */
    const runForR = async (issueId: string): Promise<Actor> => {
      const [agent] = await db.insert(agents).values({ companyId: Y, name: `Agent ${randomUUID().slice(0, 6)}`,
        role: "engineer", status: "idle", adapterType: "process",
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }).returning();
      await db.insert(companyMemberships).values({ companyId: Y, principalType: "agent", principalId: agent!.id,
        status: "active", membershipRole: "member" });
      const [run] = await db.insert(heartbeatRuns).values({ companyId: Y, agentId: agent!.id, issueId, scopeKind: "issue",
        status: "running", responsibleUserId: R }).returning();
      return { type: "agent", agentId: agent!.id, companyId: Y, runId: run!.id, source: "agent_jwt", onBehalfOfUserId: R,
        onBehalfOfMemberships: await loadActorMemberships(db, { userId: R, companyId: Y, activeOnly: true }) } as Actor;
    };

    it("AC-G3: R on his own task: lock 200, unlock 200, delete 200, upload 201", async () => {
      const mine = await ids(Y, R);
      const lock = await WRITES.lock(as(await boardFor(R)), mine);
      expect(lock.status, JSON.stringify(lock.body)).toBe(200);
      expect((await docState(mine))!.lockedByUserId).toBe(R);
      const unlock = await WRITES.unlock(as(await boardFor(R)), mine);
      expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);
      expect((await docState(mine))!.lockedAt).toBeNull();
      const removed = await WRITES.delete(as(await boardFor(R)), mine);
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(await docState(mine)).toBeNull();
      const before = await attachmentsOf(mine);
      const upload = await WRITES.upload(as(await boardFor(R)), mine);
      expect(upload.status, JSON.stringify(upload.body)).toBe(201);
      expect(await attachmentsOf(mine)).toBe(before + 1);
    });

    for (const op of ["lock", "unlock", "delete"] as const) {
      it(`AC-G3: R ${op} on a task of Y he cannot read and on a task of D he is not in: 404, nothing written`, async () => {
        for (const target of [await ids(Y, O), await ids(D, O)]) {
          const before = await snapshot(target);
          expectNotFound(await WRITES[op](as(await boardFor(R)), target));
          expect(await snapshot(target)).toEqual(before);
        }
      });
    }

    it("AC-G3: upload naming Y with a task of Y he cannot read, or with a task of D: 404 and no attachment row", async () => {
      for (const target of [await ids(Y, O), await ids(D, O)]) {
        const before = await snapshot(target);
        expectNotFound(await WRITES.upload(as(await boardFor(R)), target, Y));
        expect(await snapshot(target)).toEqual(before);
      }
    });

    it("AC-G3: upload naming D, a company he is not in: 403 from the company check, nothing written", async () => {
      const target = await ids(D, O);
      const before = await snapshot(target);
      const res = await WRITES.upload(as(await boardFor(R)), target, D);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("User does not have access to this company");
      expect(await snapshot(target)).toEqual(before);
    });

    it("a run working for R: upload on his task 201; lock on his task 403 (board only); lock on a task he cannot read 404", async () => {
      const mine = await ids(Y, R);
      const run = await runForR(mine.issueId);
      const upload = await WRITES.upload(as(run), mine);
      expect(upload.status, JSON.stringify(upload.body)).toBe(201);
      const before = await snapshot(mine);
      const lock = await WRITES.lock(as(run), mine);
      expect(lock.status, JSON.stringify(lock.body)).toBe(403);
      expect(lock.body).toEqual({ error: "Board authentication required" });
      expect(await snapshot(mine)).toEqual(before);
      const owners = await ids(Y, O);
      const ownersBefore = await snapshot(owners);
      expectNotFound(await WRITES.lock(as(run), owners));
      expect(await snapshot(owners)).toEqual(ownersBefore);
    });

    it("AC-F8: in a company whose mode is `off`, and with the kill switch `off` where the mode is `enforce`, today's answers", async () => {
      for (const op of WRITE_NAMES) {
        // Z's mode is `off`: R, restricted there, writes on O's task as today.
        const inZ = await WRITES[op](as(await boardFor(R)), await ids(Z, O));
        expect(inZ.status, `${op} in Z: ${JSON.stringify(inZ.body)}`).toBe(SUCCESS[op]);
        // Variable `off`, column `enforce`: Y behaves as mode `off`.
        const target = await ids(Y, O);
        const killed = await today(async () => WRITES[op](as(await boardFor(R)), target));
        expect(killed.status, `${op} kill switch: ${JSON.stringify(killed.body)}`).toBe(SUCCESS[op]);
      }
    });

    it("AC-X1: the restriction cannot be read: 503 MEMBER_RESTRICTION_UNAVAILABLE and nothing written, on lock and on upload", async () => {
      for (const op of ["lock", "upload"] as const) {
        const mine = await ids(Y, R);
        const caller = await boardFor(R);
        const before = await snapshot(mine);
        resolverFails.on = true;
        const res = await WRITES[op](as(caller), mine);
        resolverFails.on = false;
        expect(res.status, `${op}: ${JSON.stringify(res.body)}`).toBe(503);
        expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
        expect(JSON.stringify(res.body)).not.toContain(mine.attachmentId);
        expect(await snapshot(mine)).toEqual(before);
      }
    });
  });
});
