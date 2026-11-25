import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog, agents, authUsers, companies, companyMemberships, createDb, externalObjectMentions, externalObjects,
  issues, projectAccessMembers, projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { projectRoutes } from "../routes/projects.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { MEMBER_RESTRICTION_DENIED_ACTION } from "../services/member-restriction/admin.js";
import { GITHUB_EXTERNAL_OBJECTS_RULE_ID } from "../services/member-restriction/github-external-objects.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-14590, PAR-12608 4.6a row 5 (read side): GitHub external objects are
 * resolved with the company's GitHub credential. A person restricted under
 * `enforce` reads them through the three open read routes without their
 * resolved fields unless the repository is known public; `report` records and
 * answers as today; `off` answers as today. Owners always get today's answer.
 */

const support = await getEmbeddedPostgresTestSupport();

describe("GitHub external object read rule database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Mode = "off" | "report" | "enforce";

const PRIVATE_TITLE = "acme/secret#7: Rename the billing table for client B";
const UNKNOWN_TITLE = "acme/other#9: Private issue title";
const PUBLIC_TITLE = "acme/open#3: Public PR title";

(support.supported ? describe : describe.skip)("GitHub external objects for a restricted person (4.6a row 5)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;

  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  let Y = "";
  let agentY = "";
  let issueId = "";
  let projectId = "";
  let privateId = "";
  let unknownId = "";
  let publicId = "";

  const as = (who: Actor) => {
    actor = who;
    return request(app);
  };
  const boardFor = async (userId: string): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return {
      type: "board", userId, source: "session", isInstanceAdmin: false, memberships,
      companyIds: memberships.map((row: { companyId: string }) => row.companyId),
    } as Actor;
  };
  const runFor = async (userId: string): Promise<Actor> => ({
    type: "agent", companyId: Y, agentId: agentY, source: "agent_key", onBehalfOfUserId: userId,
    onBehalfOfMemberships: await loadActorMemberships(db, { userId, activeOnly: true }),
  }) as Actor;
  const setMode = async (mode: Mode) => {
    await db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, Y));
  };
  const denials = async () => db.select({ details: activityLog.details }).from(activityLog).where(and(
    eq(activityLog.companyId, Y),
    eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION),
  ));

  /** The three open read routes, each reduced to the objects it lists. */
  const readAll = async (who: Actor) => {
    const list = await as(who).get(`/api/issues/${issueId}/external-objects`);
    const summary = await as(who).get(`/api/issues/${issueId}/external-object-summary`);
    const project = await as(who).get(`/api/projects/${projectId}/external-object-summary`);
    for (const res of [list, summary, project]) expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byId = (rows: Array<{ id: string }>) => new Map(rows.map((row) => [row.id, row]));
    return {
      list: byId(list.body.map((group: { object: { id: string } }) => group.object)) as Map<string, Record<string, unknown>>,
      summary: byId(summary.body.objects) as Map<string, Record<string, unknown>>,
      project: byId(project.body.objects) as Map<string, Record<string, unknown>>,
      bodies: JSON.stringify([list.body, summary.body, project.body]),
      issueSummary: summary.body,
    };
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-github-external-objects-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableExternalObjects: true });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use("/api", projectRoutes(db));
    app.use(errorHandler);

    const [y] = await db.insert(companies).values({
      name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    Y = y!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
    ]);
    const [agent] = await db.insert(agents).values({
      companyId: Y, name: "Agent Y", role: "engineer", adapterType: "process", status: "active",
    }).returning();
    agentY = agent!.id;
    const [project] = await db.insert(projects).values({ companyId: Y, name: "R's project", privacyOwnerUserId: R }).returning();
    projectId = project!.id;
    await db.insert(projectAccessMembers).values({ companyId: Y, projectId, subjectType: "user", subjectId: R });
    // R's own task: he may read it under every mode, so only the object fields differ.
    const [task] = await db.insert(issues).values({
      companyId: Y, projectId, title: "R's task", status: "todo", createdByUserId: R, responsibleUserId: R,
    }).returning();
    issueId = task!.id;

    const resolved = { liveness: "fresh", lastResolvedAt: now, lastChangedAt: now, remoteVersion: "2026-11-20T00:00:00Z" } as const;
    const [privateObject, unknownObject, publicObject] = await db.insert(externalObjects).values([
      {
        companyId: Y, providerKey: "github", objectType: "pull_request", externalId: "acme/secret#pull/7",
        sanitizedCanonicalUrl: "https://github.com/acme/secret/pull/7", displayKey: "GitHub Pull Request",
        displayTitle: PRIVATE_TITLE, statusKey: "merged", statusLabel: "Merged", statusCategory: "succeeded",
        statusTone: "success", isTerminal: true, ...resolved,
        data: { provider: "github", owner: "acme", repo: "secret", number: 7, headRef: "client-b", repoVisibility: "private" },
      },
      {
        companyId: Y, providerKey: "github", objectType: "issue", externalId: "acme/other#issues/9",
        sanitizedCanonicalUrl: "https://github.com/acme/other/issues/9", displayKey: "GitHub Issue",
        displayTitle: UNKNOWN_TITLE, statusKey: "open", statusLabel: "Open", statusCategory: "open",
        statusTone: "info", ...resolved,
        data: { provider: "github", owner: "acme", repo: "other", number: 9, state: "open" },
      },
      {
        companyId: Y, providerKey: "github", objectType: "pull_request", externalId: "acme/open#pull/3",
        sanitizedCanonicalUrl: "https://github.com/acme/open/pull/3", displayKey: "GitHub Pull Request",
        displayTitle: PUBLIC_TITLE, statusKey: "open", statusLabel: "Open", statusCategory: "open",
        statusTone: "info", ...resolved,
        data: { provider: "github", owner: "acme", repo: "open", number: 3, repoVisibility: "public" },
      },
    ]).returning();
    privateId = privateObject!.id;
    unknownId = unknownObject!.id;
    publicId = publicObject!.id;
    await db.insert(externalObjectMentions).values([privateObject!, unknownObject!, publicObject!].map((object) => ({
      companyId: Y, sourceIssueId: issueId, sourceKind: "description" as const, objectId: object.id,
      providerKey: object.providerKey, objectType: object.objectType,
      sanitizedDisplayUrl: object.sanitizedCanonicalUrl, confidence: "exact" as const,
    })));
  }, 120_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(activityLog).where(eq(activityLog.companyId, Y));
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  const expectToday = (read: Awaited<ReturnType<typeof readAll>>) => {
    for (const view of [read.list, read.summary, read.project]) {
      expect(view.get(privateId)?.displayTitle).toBe(PRIVATE_TITLE);
      expect(view.get(unknownId)?.displayTitle).toBe(UNKNOWN_TITLE);
      expect(view.get(publicId)?.displayTitle).toBe(PUBLIC_TITLE);
    }
    expect(read.list.get(privateId)).toMatchObject({ statusLabel: "Merged", data: { headRef: "client-b" } });
  };

  it("enforce: R, signed in and through his run, sees withheld GitHub objects as their URL only; public ones in full", async () => {
    await setMode("enforce");
    for (const who of [await boardFor(R), await runFor(R)]) {
      const read = await readAll(who);
      for (const view of [read.list, read.summary, read.project]) {
        expect(view.get(privateId)).toMatchObject({
          displayTitle: "acme/secret#7", statusCategory: "unknown", statusTone: "neutral", liveness: "unknown", isTerminal: false,
        });
        expect(view.get(unknownId)).toMatchObject({ displayTitle: "acme/other#9", statusCategory: "unknown", liveness: "unknown" });
        expect(view.get(publicId)).toMatchObject({ displayTitle: PUBLIC_TITLE, statusCategory: "open", liveness: "fresh" });
      }
      expect(read.list.get(privateId)).toMatchObject({
        statusKey: null, statusLabel: null, remoteVersion: null, lastResolvedAt: null, lastChangedAt: null,
        data: { provider: "github", owner: "acme", repo: "secret", number: 7, withheld: true },
        sanitizedCanonicalUrl: "https://github.com/acme/secret/pull/7",
      });
      // Counts are built from the withheld fields too: no "succeeded" count for the merged private PR.
      expect(read.issueSummary.byStatusCategory).toEqual({ unknown: 2, open: 1 });
      for (const leaked of ["Rename the billing table", "Private issue title", "client-b", "Merged"]) {
        expect(read.bodies).not.toContain(leaked);
      }
    }
    const recorded = await denials();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.details).toMatchObject({ personId: R, ruleId: GITHUB_EXTERNAL_OBJECTS_RULE_ID, mode: "enforce" });
  });

  it("enforce: the owner gets today's answer and nothing is recorded", async () => {
    await setMode("enforce");
    expectToday(await readAll(await boardFor(O)));
    expect(await denials()).toHaveLength(0);
  });

  it("report: R gets today's answer and the would-be withholding is recorded", async () => {
    await setMode("report");
    expectToday(await readAll(await boardFor(R)));
    const recorded = await denials();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.details).toMatchObject({ personId: R, ruleId: GITHUB_EXTERNAL_OBJECTS_RULE_ID, mode: "report" });
  });

  it("off, and the kill switch under enforce: R gets today's answer and nothing is recorded", async () => {
    await setMode("off");
    expectToday(await readAll(await boardFor(R)));
    await setMode("enforce");
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    expectToday(await readAll(await runFor(R)));
    expect(await denials()).toHaveLength(0);
  });
});
