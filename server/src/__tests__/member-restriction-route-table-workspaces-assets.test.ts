import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assets, authUsers, companies, companyLogos, companyMemberships, createDb, executionWorkspaces, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { accessRoutes } from "../routes/access.js";
import { assetRoutes } from "../routes/assets.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { MEMBER_RESTRICTION_ROUTE_TABLE, createRouteClassifier } from "../services/member-restriction/route-table.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12734 (C4e-2): user directory, assets and execution workspaces. Spec
 * PAR-12608 rev 3, 4.6. AC-G3: for every `open` row, R (restricted in Y) asks
 * for O's object and gets "not found" (the directory: only id and name); with
 * the kill switch `off` the same call reaches it (AC-F8: column `enforce`
 * behaves as `off`). Scope callers (section 8): R as owner of X, and an
 * instance admin who is no member of Y, get today's answer. AC-X1: a failed
 * restriction read answers 503 and no data. AC-G1: the closed rows and the
 * admin pages (no row) classify as closed. No `run` or `by-company` rows.
 */

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
  };
});

const support = await getEmbeddedPostgresTestSupport();
const THIS_FILE = "server/src/__tests__/member-restriction-route-table-workspaces-assets.test.ts";
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

describe("workspace and asset route rows database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Ids = { companyId: string; ownerId: string; issueId: string; assetId: string; workspaceId: string };
type Case = {
  row: string;
  send: (client: request.SuperTest<request.Test>, ids: Ids) => request.Test;
  /** R's answer for O's object under `enforce`. */
  refused: (res: request.Response, ids: Ids) => void;
};

const notFound = (error: string) => (res: request.Response) => {
  expect(res.status, JSON.stringify(res.body)).toBe(404);
  expect(res.body).toEqual({ error });
};

const CASES: Case[] = [
  { row: "GET /api/companies/:companyId/user-directory",
    send: (c, { companyId }) => c.get(`/api/companies/${companyId}/user-directory`),
    refused: (res, { ownerId }) => {
      expect(res.status).toBe(200);
      const entry = res.body.users.find((row: { principalId: string }) => row.principalId === ownerId);
      expect(entry).toEqual({ principalId: ownerId, status: "active", membershipRole: null, user: { id: ownerId, name: ownerId, email: null, image: null } });
      expect(JSON.stringify(res.body)).not.toContain("@example.test");
    } },
  { row: "POST /api/companies/:companyId/assets/images",
    send: (c, { companyId, issueId }) => c.post(`/api/companies/${companyId}/assets/images`)
      .field("namespace", `issues/${issueId}`).attach("file", PNG, { filename: "shot.png", contentType: "image/png" }),
    refused: notFound("Issue not found") },
  { row: "GET /api/assets/:assetId/content", send: (c, { assetId }) => c.get(`/api/assets/${assetId}/content`),
    refused: notFound("Asset not found") },
  { row: "GET /api/execution-workspaces/:id", send: (c, { workspaceId }) => c.get(`/api/execution-workspaces/${workspaceId}`),
    refused: notFound("Execution workspace not found") },
  { row: "GET /api/execution-workspaces/:id/close-readiness",
    send: (c, { workspaceId }) => c.get(`/api/execution-workspaces/${workspaceId}/close-readiness`),
    refused: notFound("Execution workspace not found") },
  { row: "GET /api/execution-workspaces/:id/workspace-operations",
    send: (c, { workspaceId }) => c.get(`/api/execution-workspaces/${workspaceId}/workspace-operations`),
    refused: notFound("Execution workspace not found") },
];

/** Closed rows of this file, and the admin pages of this area that have no row (AC-G1). */
const CLOSED: Array<[string, string]> = [
  ...MEMBER_RESTRICTION_ROUTE_TABLE.filter((entry) => entry.class === "closed"
    && /\/(logo|execution-workspaces|workspace-overview)(\/|$)/.test(entry.path)).map((entry) => [entry.method, entry.path] as [string, string]),
  ["GET", "/api/companies/:companyId/dashboard"], ["GET", "/api/companies/:companyId/costs/summary"],
  ["GET", "/api/companies/:companyId/secrets"], ["POST", "/api/companies/:companyId/secrets"],
  ["GET", "/api/companies/:companyId/skills"], ["GET", "/api/plugins"],
  ["GET", "/api/plugins/:pluginId/config"], ["GET", "/api/plugins/:pluginId/logs"], ["GET", "/api/plugins/:pluginId/jobs"],
];

it("every open row of this file has exactly one case, and each case is an open row", () => {
  const rows = MEMBER_RESTRICTION_ROUTE_TABLE.filter((entry) => entry.test === THIS_FILE).map((entry) => `${entry.method} ${entry.path}`);
  expect(CASES.map((entry) => entry.row).sort()).toEqual([...rows].sort());
  for (const entry of CASES) {
    expect(MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === entry.row)!.class, entry.row).toBe("open");
  }
});

it("AC-G1: the closed workspace rows and the dashboard, costs, secrets, skills and plugin pages classify as closed", async () => {
  const classify = createRouteClassifier();
  expect(CLOSED.length).toBe(17);
  for (const [method, pattern] of CLOSED) {
    const sample = pattern.replace(/:[A-Za-z]+/g, () => randomUUID());
    const result = await classify(method, sample);
    expect(result.kind === "matched" ? result.entry.class : result.kind, `${method} ${sample}`).toMatch(/^(closed|unlisted)$/);
  }
});

(support.supported ? describe : describe.skip)("workspace and asset rows of the route table (PAR-12608 4.6, AC-G3)", () => {
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
  /** A task of `ownerId` (R is assignee when `assignR`), an asset filed under it, and its workspace. */
  const ids = async (companyId: string, ownerId: string, assignR = false): Promise<Ids> => {
    const [task] = await db.insert(issues).values({
      companyId, title: `Task ${randomUUID().slice(0, 8)}`, status: "todo", createdByUserId: ownerId, responsibleUserId: ownerId,
      assigneeUserId: assignR ? R : null,
    }).returning();
    const stored = await storage.putFile({
      companyId, namespace: `assets/issues/${task!.id}`, originalFilename: "shot.png", contentType: "image/png", body: PNG,
    });
    const [asset] = await db.insert(assets).values({ companyId, ...stored, createdByUserId: ownerId }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId, sourceIssueId: task!.id, name: "Task files", cwd: path.join(root, task!.id), mode: "isolated_workspace", strategyType: "git_worktree",
    }).returning();
    return { companyId, ownerId, issueId: task!.id, assetId: asset!.id, workspaceId: workspace!.id };
  };
  const today = async <T,>(send: () => Promise<T>): Promise<T> => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    try {
      return await send();
    } finally {
      vi.unstubAllEnvs();
    }
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-route-table-workspaces-");
    db = createDb(tempDb.connectionString);
    root = await mkdtemp(path.join(tmpdir(), "restriction-route-table-workspaces-"));
    storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "storage")));
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", accessRoutes(db, {
      deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [],
    }), assetRoutes(db, storage), executionWorkspaceRoutes(db));
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
    it("AC-G3 and AC-F8: R (restricted in Y) gets \"not found\" for O's object; with the kill switch `off`, today's answer", async () => {
      const target = await ids(Y, O);
      const send = async () => entry.send(as(await boardFor(R)), target);
      entry.refused(await send(), target);
      const open = await today(send);
      expect(open.status, JSON.stringify(open.body)).toBeLessThan(300);
      if (entry.row.includes("user-directory")) expect(JSON.stringify(open.body)).toContain(`${O}@example.test`);
    });

    it("scope callers: R as owner of X, and an instance admin who is no member of Y, get today's answer", async () => {
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

  it("R in Y reads his own task's workspace and asset, files an image under it, and reads the company logo", async () => {
    const own = await ids(Y, O, true);
    const client = async () => as(await boardFor(R));
    for (const url of [`/api/execution-workspaces/${own.workspaceId}`, `/api/execution-workspaces/${own.workspaceId}/workspace-operations`,
      `/api/assets/${own.assetId}/content`]) {
      const res = await (await client()).get(url);
      expect(res.status, `${url} ${JSON.stringify(res.body)}`).toBe(200);
    }
    const upload = await (await client()).post(`/api/companies/${Y}/assets/images`)
      .field("namespace", `issues/${own.issueId}`).attach("file", PNG, { filename: "mine.png", contentType: "image/png" });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const stored = await storage.putFile({ companyId: Y, namespace: "assets/companies", originalFilename: "logo.png", contentType: "image/png", body: PNG });
    const [logo] = await db.insert(assets).values({ companyId: Y, ...stored, createdByUserId: O }).returning();
    await db.insert(companyLogos).values({ companyId: Y, assetId: logo!.id });
    expect((await (await client()).get(`/api/assets/${logo!.id}/content`)).status).toBe(200);
  });

  it("a workspace with no source task is \"not found\" for R", async () => {
    const [orphan] = await db.insert(executionWorkspaces).values({
      companyId: Y, name: "No task", cwd: path.join(root, "orphan"), mode: "isolated_workspace", strategyType: "git_worktree",
    }).returning();
    notFound("Execution workspace not found")(await as(await boardFor(R)).get(`/api/execution-workspaces/${orphan!.id}`));
  });

  it.each(CASES.filter((entry) => !entry.row.includes("/assets/:assetId/")).map((entry) => [entry.row, entry] as const))(
    "AC-X1: %s answers 503 MEMBER_RESTRICTION_UNAVAILABLE and no data when the restriction cannot be read",
    async (_row, entry) => {
      const target = await ids(Y, O);
      const caller = await boardFor(R);
      resolverFails.on = true;
      const res = await entry.send(as(caller), target);
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
      expect(JSON.stringify(res.body)).not.toContain(O);
    },
  );
});
