import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authUsers, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { documentAnnotationService, documentService, issueService, workProductService } from "../services/index.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import {
  MEMBER_RESTRICTION_ROUTE_TABLE,
  createRouteClassifier,
} from "../services/member-restriction/route-table.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12732 (C4b-2): the document, annotation, work-product and attachment
 * rows of the route table. Spec PAR-12608 rev 3, 4.6. AC-G3: for every `open`
 * row, R (restricted in Y) asks for O's object through that route and gets
 * "not found"; a control call with the kill switch on reaches the object, so
 * the answer is the restriction. Scope callers (section 8): R as owner of X,
 * and an instance admin who is not a member of Y, get today's answer. AC-G1
 * for the closed rows is the classifier's answer; the 403 body is the
 * middleware's (AC-G2). This area has no `run` and no `by-company` rows.
 */

const support = await getEmbeddedPostgresTestSupport();
const THIS_FILE = "server/src/__tests__/member-restriction-route-table-documents.test.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("document, work-product and attachment route rows database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Res = request.Response;
type Ids = {
  issueId: string; key: string; firstRevisionId: string; latestRevisionId: string;
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
];

/** The closed rows this ticket wrote (AC-G1). */
const CLOSED_ROWS = [
  "POST /api/issues/:id/documents/:key/lock",
  "POST /api/issues/:id/documents/:key/unlock",
  "DELETE /api/issues/:id/documents/:key",
  "POST /api/companies/:companyId/issues/:issueId/attachments",
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

it("AC-G1: the closed document and attachment rows classify as closed for their real paths", async () => {
  const classify = createRouteClassifier();
  for (const row of CLOSED_ROWS) {
    const entry = MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === row);
    expect(entry?.class, row).toBe("closed");
    const sample = entry!.path.replace(/:[A-Za-z]+/g, () => randomUUID());
    const result = await classify(entry!.method, sample);
    expect(result.kind === "matched" ? result.entry.class : result.kind, `${entry!.method} ${sample}`).toBe("closed");
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
      issueId, key: KEY, firstRevisionId: first.document.latestRevisionId!, latestRevisionId: latest.document.latestRevisionId!,
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
    app.use("/api", issueRoutes(db, storage));
    app.use(errorHandler);

    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    Y = y!.id;
    X = x!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R, ADMIN].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
      { companyId: X, principalType: "user", principalId: R, status: "active", membershipRole: "owner" },
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
});
