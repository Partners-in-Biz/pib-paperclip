import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issueReferenceMentions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

/**
 * PAR-12726 (stage C3-4): identifier-only stubs for tasks a restricted member
 * cannot read. Spec PAR-12608 rev 3, section 4.3 "Stubs": AC-L5, AC-L5a, plus
 * this consumer's kill-switch (AC-F8) and failing-read (AC-X1) tests.
 *
 * The code point is `server/src/routes/issues.ts`: `readableIssueEdgeIds` and
 * `lockedIssueStub`, used by `redactIssueRelationEdges` (blockers, blocked
 * tasks), `redactIssueReferenceEdges` (links and mentions, including comments),
 * `redactIssueRelationEdgesOnRows` (list rows) and `redactIssueAncestry`
 * (parent and ancestors, sampled terminal blocker). The stub is chosen by
 * `issue:read` for this caller, never by `visibility = 'private'`.
 */

const support = await getEmbeddedPostgresTestSupport();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("stub database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Db = ReturnType<typeof createDb>;

async function createApp(db: Db, userId: string, companyId: string) {
  const { issueRoutes } = await import("../routes/issues.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId, companyIds: [companyId], source: "session", isInstanceAdmin: false };
    next();
  });
  app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
  app.use(errorHandler);
  return app;
}

(support.supported ? describe : describe.skip)("member restriction stubs (AC-L5, AC-L5a)", { concurrent: false }, () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;

  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  let companyId = "";
  let prefix = "";
  const t: Record<string, { id: string; identifier: string }> = {};
  const SECRETS = ["Owner parent secret", "Owner sibling secret", "Owner blocker secret", "Owner blocked secret"];

  const stub = (name: string) => ({ id: t[name]!.id, identifier: t[name]!.identifier, locked: true });
  const get = async (userId: string, path: string) => request(await createApp(db, userId, companyId)).get(path);
  const setMode = (mode: "off" | "report" | "enforce") =>
    db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, companyId));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-stubs-");
    db = createDb(tempDb.connectionString);
    prefix = `S${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    const [company] = await db.insert(companies).values({
      name: "Stub co", issuePrefix: prefix, memberRestrictionMode: "enforce", requireBoardApprovalForNewAgents: false,
    }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R].map((id) => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
    ]);
    let n = 0;
    const insertTask = async (name: string, title: string, values: Partial<typeof issues.$inferInsert> = {}) => {
      n += 1;
      const identifier = `${prefix}-${n}`;
      const [row] = await db.insert(issues).values({
        companyId, identifier, issueNumber: n, title, createdByUserId: O, status: "todo", priority: "medium", ...values,
      }).returning();
      t[name] = { id: row!.id, identifier };
    };
    // An open parent of O's; O assigns R the child T (AC-L5).
    await insertTask("parent", "Owner parent secret");
    await insertTask("task", "R's assigned task", { parentId: t.parent!.id, assigneeUserId: R, status: "blocked" });
    await insertTask("sibling", "Owner sibling secret", { parentId: t.parent!.id });
    await insertTask("child", "Child of R's task", { parentId: t.task!.id });
    // AC-L5a: a blocker R cannot read, one he can, and a task his task blocks.
    await insertTask("blocker", "Owner blocker secret");
    await insertTask("ownBlocker", "R's own blocker", { createdByUserId: R });
    await insertTask("blocked", "Owner blocked secret");
    await db.insert(issueRelations).values([
      { companyId, issueId: t.blocker!.id, relatedIssueId: t.task!.id, type: "blocks" },
      { companyId, issueId: t.ownBlocker!.id, relatedIssueId: t.task!.id, type: "blocks" },
      { companyId, issueId: t.task!.id, relatedIssueId: t.blocked!.id, type: "blocks" },
    ]);
    // A comment on R's task that mentions O's task.
    const [comment] = await db.insert(issueComments).values({
      companyId, issueId: t.task!.id, authorUserId: O, body: `See ${t.blocker!.identifier}`,
    }).returning();
    await db.insert(issueReferenceMentions).values({
      companyId, sourceIssueId: t.task!.id, targetIssueId: t.blocker!.id, sourceKind: "comment",
      sourceRecordId: comment!.id, documentKey: null, matchedText: t.blocker!.identifier,
    });
    await import("../routes/issues.js");
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  function expectNoSecrets(body: unknown) {
    const text = JSON.stringify(body);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  }

  it("AC-L5: R reads T and its child, not T's parent or sibling; the parent is an identifier-only stub", async () => {
    const detail = await get(R, `/api/issues/${t.task!.id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.ancestors).toEqual([stub("parent")]);
    expectNoSecrets(detail.body);

    const context = await get(R, `/api/issues/${t.task!.id}/heartbeat-context`);
    expect(context.status, JSON.stringify(context.body)).toBe(200);
    expect(context.body.ancestors).toEqual([stub("parent")]);
    expectNoSecrets(context.body);

    expect((await get(R, `/api/issues/${t.child!.id}`)).status).toBe(200);
    expect((await get(R, `/api/issues/${t.parent!.id}`)).status).toBe(404);
    expect((await get(R, `/api/issues/${t.sibling!.id}`)).status).toBe(404);
  }, 30_000);

  it("AC-L5a: an unreadable blocker, blocked task and comment mention are the same stub; readable ones stay full", async () => {
    const detail = await get(R, `/api/issues/${t.task!.id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.blockedBy).toEqual(expect.arrayContaining([
      stub("blocker"),
      expect.objectContaining({ id: t.ownBlocker!.id, title: "R's own blocker" }),
    ]));
    expect(detail.body.blocks).toEqual([stub("blocked")]);
    const mention = detail.body.relatedWork.outbound.find((item: { issue: { id: string } }) => item.issue.id === t.blocker!.id);
    expect(mention.issue).toEqual(stub("blocker"));
    expect(detail.body.blockerAttention?.terminalBlocker?.id).not.toBe(t.blocker!.id);
    expectNoSecrets(detail.body);

    const context = await get(R, `/api/issues/${t.task!.id}/heartbeat-context`);
    expect(context.body.issue.blockedBy).toEqual(expect.arrayContaining([stub("blocker")]));
    expectNoSecrets(context.body);

    const list = await get(R, `/api/companies/${companyId}/issues?includeBlockedBy=true`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const row = list.body.find((item: { id: string }) => item.id === t.task!.id);
    expect(row.blockedBy).toEqual(expect.arrayContaining([stub("blocker")]));
    expectNoSecrets(list.body);
  }, 30_000);

  it("the owner and R in mode off see the full edges (the stub follows readability, not a flag)", async () => {
    const owner = await get(O, `/api/issues/${t.task!.id}`);
    expect(owner.body.ancestors[0]).toMatchObject({ id: t.parent!.id, title: "Owner parent secret" });
    expect(owner.body.blockedBy).toEqual(expect.arrayContaining([expect.objectContaining({ id: t.blocker!.id, title: "Owner blocker secret" })]));
    await setMode("off");
    try {
      const off = await get(R, `/api/issues/${t.task!.id}`);
      expect(off.body.ancestors[0]).toMatchObject({ id: t.parent!.id, title: "Owner parent secret" });
      expect(off.body.blocks).toEqual([expect.objectContaining({ id: t.blocked!.id, title: "Owner blocked secret" })]);
    } finally {
      await setMode("enforce");
    }
  }, 30_000);

  describe("kill switch (AC-F8)", () => {
    it("with the variable exactly `off` and the column on enforce, the edges are full as in mode off", async () => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      const detail = await get(R, `/api/issues/${t.task!.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.ancestors[0]).toMatchObject({ id: t.parent!.id, title: "Owner parent secret" });
      expect(detail.body.blockedBy).toEqual(expect.arrayContaining([expect.objectContaining({ id: t.blocker!.id, title: "Owner blocker secret" })]));
      const mention = detail.body.relatedWork.outbound.find((item: { issue: { id: string } }) => item.issue.id === t.blocker!.id);
      expect(mention.issue).toMatchObject({ title: "Owner blocker secret" });
    }, 30_000);

    it.each(["false", "OFF "])("with the variable set to %j the stubs stay", async (value) => {
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", value);
      const detail = await get(R, `/api/issues/${t.task!.id}`);
      expect(detail.body.ancestors).toEqual([stub("parent")]);
    }, 30_000);
  });

  describe("failing read (AC-X1)", () => {
    it("answers 503 MEMBER_RESTRICTION_UNAVAILABLE with no task data when the resolver throws", async () => {
      // A malformed list makes the resolver throw for R in this company.
      await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '"broken"'::jsonb
        where ${companyMemberships.companyId} = ${companyId} and ${companyMemberships.principalId} = ${R}`);
      try {
        for (const path of [`/api/issues/${t.task!.id}`, `/api/issues/${t.task!.id}/heartbeat-context`]) {
          const res = await get(R, path);
          expect(res.status, path).toBe(503);
          expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
          expect(res.body).not.toHaveProperty("ancestors");
          expect(res.body).not.toHaveProperty("blockedBy");
          expectNoSecrets(res.body);
        }
        expect((await get(O, `/api/issues/${t.task!.id}`)).status).toBe(200);
      } finally {
        await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '[]'::jsonb
          where ${companyMemberships.companyId} = ${companyId} and ${companyMemberships.principalId} = ${R}`);
      }
    }, 30_000);
  });
});
