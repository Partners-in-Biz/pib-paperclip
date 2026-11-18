import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { logger } from "../middleware/logger.js";
import { issueRoutes } from "../routes/issues.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { MEMBER_RESTRICTION_DENIED_ACTION } from "../services/member-restriction/admin.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12929 (C4h): `PUT /api/issues/:id/title` reads the task through
 * `issue:read` for a caller the member restriction binds. Spec PAR-12608 rev 3,
 * 4.6, AC-G3, AC-F2, AC-G12, plus this consumer's kill-switch and failing-read
 * cases (AC-F8, AC-X1). Real route, real resolver, real reads.
 *
 * BASE holds the answers of `development` at 1fd214261 (before this change),
 * recorded with `PAR12929_RECORD=<file>` on that commit. Every cell keeps that
 * answer except a caller bound by R under `enforce` (ENFORCED).
 */

const support = await getEmbeddedPostgresTestSupport();
/** Set to a file path to record the answers (on the base commit) instead of checking them. */
const RECORD = process.env.PAR12929_RECORD;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("title route database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Mode = "off" | "report" | "enforce" | "kill";
type Target = "own" | "other" | "private" | "otherCompany";
/**
 * R: restricted in Y, owner in X. R-run / R-key: a run, and a long-lived key,
 * of an agent working for R. O: a board member who is not restricted. agent:
 * an agent working for nobody; it can read P's open task but not change it
 * (not its assignee), and cannot read P's private task. agent-of-O: a run
 * working for O. admin: an instance admin who is no member. R-in-X: R working
 * in X, where he is owner; his "other company" is Y.
 */
type Caller = "R" | "R-run" | "R-key" | "O" | "agent" | "agent-of-O" | "admin" | "R-in-X";

const MODES: Mode[] = ["off", "report", "enforce", "kill"];
const TARGETS: Target[] = ["own", "other", "private", "otherCompany"];
const CALLERS: Caller[] = ["R", "R-run", "R-key", "O", "agent", "agent-of-O", "admin", "R-in-X"];
/** Callers R binds in Y: R himself, a run that works for him, his long-lived key. */
const BOUND: readonly Caller[] = ["R", "R-run", "R-key"];

const NOT_FOUND = "404 Issue not found";
const NOT_VISIBLE = "403 issue_write_not_visible";
const NO_RUN = "403 Setting a task title requires its assigned agent's active run";
const all = (answer: string) => [answer, answer, answer, answer];

const [OK, NF, NR, NV] = ["200", NOT_FOUND, NO_RUN, NOT_VISIBLE];
/** Answers on `development` at 1fd214261, per caller: targets own, other, private, otherCompany; each off, report, enforce, kill. */
const BASE: Record<Caller, Record<Target, string[]>> = {
  "R": { own: all(OK), other: all(OK), private: all(OK), otherCompany: all(OK) },
  "R-run": { own: all(OK), other: [NR, NR, NV, NR], private: [NR, NR, NV, NR], otherCompany: all(NF) },
  "R-key": { own: all(NR), other: [NR, NR, NV, NR], private: [NR, NR, NV, NR], otherCompany: all(NF) },
  "O": { own: all(OK), other: all(OK), private: all(OK), otherCompany: all(OK) },
  "agent": { own: all(OK), other: all(NR), private: all(NR), otherCompany: all(NF) },
  "agent-of-O": { own: all(OK), other: all(NR), private: all(NR), otherCompany: all(NF) },
  "admin": { own: all(NF), other: all(NF), private: all(NF), otherCompany: all(NF) },
  "R-in-X": { own: all(OK), other: all(OK), private: all(OK), otherCompany: all(OK) },
};

/**
 * The only cells that change: a caller bound by R under `enforce`, on a task
 * in Y that is not R's, gets "not found". His own task, and every task in X
 * (where R is owner), keep BASE.
 */
const ENFORCED: Partial<Record<Caller, Partial<Record<Target, string>>>> = {
  "R": { other: NOT_FOUND, private: NOT_FOUND },
  "R-run": { other: NOT_FOUND, private: NOT_FOUND },
  "R-key": { other: NOT_FOUND, private: NOT_FOUND },
  "R-in-X": { otherCompany: NOT_FOUND },
};

const answerOf = (res: request.Response) => {
  const code = res.body?.code ?? res.body?.details?.code;
  const text = code ?? (res.status === 200 ? "" : res.body?.error ?? "");
  return text ? `${res.status} ${text}` : String(res.status);
};

(support.supported ? describe : describe.skip)("PUT /api/issues/:id/title and the member restriction (PAR-12929)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;
  const recorded: Record<string, Record<string, string[]>> = {};

  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const P = `person-${randomUUID()}`;
  const ADMIN = `instance-admin-${randomUUID()}`;
  let Y = "";
  let X = "";
  let agentR = "";
  let agentPlain = "";
  let agentO = "";

  const as = (who: Actor) => {
    actor = who;
    return request(app);
  };
  const board = async (userId: string, isInstanceAdmin = false): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return { type: "board", userId, source: "session", isInstanceAdmin, memberships,
      companyIds: memberships.map((row) => row.companyId) } as Actor;
  };
  const agentActor = async (agentId: string, person: string | null, issueId: string | null): Promise<Actor> => {
    const onBehalfOfMemberships = person ? await loadActorMemberships(db, { userId: person, activeOnly: true }) : [];
    if (!issueId) {
      return { type: "agent", agentId, companyId: Y, keyId: randomUUID(), source: "agent_key",
        onBehalfOfUserId: person, onBehalfOfMemberships } as Actor;
    }
    const [run] = await db.insert(heartbeatRuns).values({ companyId: Y, agentId, status: "running",
      responsibleUserId: person, contextSnapshot: { issueId } }).returning();
    return { type: "agent", agentId, companyId: Y, runId: run!.id, source: "agent_jwt",
      onBehalfOfUserId: person, onBehalfOfMemberships } as Actor;
  };

  /** A fresh task per request, so a rename that goes through cannot change the next cell. */
  const task = async (companyId: string, owner: string, extra: Partial<typeof issues.$inferInsert> = {}) => {
    const [row] = await db.insert(issues).values({ companyId, title: "Before", status: "todo",
      createdByUserId: owner, responsibleUserId: owner, ...extra }).returning();
    return row!.id;
  };
  const targetFor = async (caller: Caller, target: Target) => {
    const home = caller === "R-in-X" ? X : Y;
    const away = caller === "R-in-X" ? Y : X;
    if (target === "other") return task(home, P);
    if (target === "private") return task(home, P, { visibility: "private" });
    if (target === "otherCompany") return task(away, caller === "R-in-X" ? O : P);
    switch (caller) {
      case "R": case "R-in-X": return task(home, R);
      case "R-run": case "R-key": return task(home, R, { assigneeAgentId: agentR });
      case "O": return task(home, O);
      case "agent": return task(home, P, { assigneeAgentId: agentPlain });
      case "agent-of-O": return task(home, O, { assigneeAgentId: agentO });
      case "admin": return task(home, ADMIN);
    }
  };
  const callerActor = (caller: Caller, issueId: string): Promise<Actor> => {
    switch (caller) {
      case "R": case "R-in-X": return board(R);
      case "R-run": return agentActor(agentR, R, issueId);
      case "R-key": return agentActor(agentR, R, null);
      case "O": return board(O);
      case "agent": return agentActor(agentPlain, null, issueId);
      case "agent-of-O": return agentActor(agentO, O, issueId);
      case "admin": return board(ADMIN, true);
    }
  };
  const setMode = async (mode: Mode) => {
    await db.update(companies).set({ memberRestrictionMode: mode === "kill" || mode === "enforce" ? "enforce" : mode });
    if (mode === "kill") vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    else vi.unstubAllEnvs();
  };
  const titleOf = async (issueId: string) =>
    (await db.select({ title: issues.title }).from(issues).where(eq(issues.id, issueId)))[0]!.title;
  const rename = async (caller: Caller, target: Target, method: "put" | "patch" = "put") => {
    const issueId = await targetFor(caller, target);
    const who = await callerActor(caller, issueId);
    const res = method === "put"
      ? await as(who).put(`/api/issues/${issueId}/title`).send({ title: "After" })
      : await as(who).patch(`/api/issues/${issueId}`).send({ title: "After" });
    return { issueId, res, answer: answerOf(res), renamed: (await titleOf(issueId)) === "After" };
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-title-route-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);

    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}` },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}` },
    ]).returning();
    Y = y!.id;
    X = x!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R, P, ADMIN].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
      { companyId: Y, principalType: "user", principalId: P, status: "active", membershipRole: "operator" },
      { companyId: X, principalType: "user", principalId: R, status: "active", membershipRole: "owner" },
      { companyId: X, principalType: "user", principalId: O, status: "active", membershipRole: "operator" },
    ]);
    const made = await db.insert(agents).values(["Agent of R", "Plain agent", "Agent of O"].map((name) => ({
      companyId: Y, name, role: "engineer", adapterType: "process", status: "active",
    }))).returning();
    [agentR, agentPlain, agentO] = made.map((row) => row.id);
  }, 120_000);

  afterAll(async () => {
    if (RECORD) writeFileSync(RECORD, JSON.stringify(recorded, null, 2));
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe.each(CALLERS)("caller %s", (caller) => {
    it.each(TARGETS)("target %s: status, code and title in every mode", async (target) => {
      const answers: string[] = [];
      for (const mode of MODES) {
        await setMode(mode);
        const { answer, renamed } = await rename(caller, target);
        answers.push(answer);
        expect(renamed, `${mode}: ${answer}`).toBe(answer === "200");
        if (RECORD) continue;
        const expected = (mode === "enforce" ? ENFORCED[caller]?.[target] : undefined)
          ?? BASE[caller][target][MODES.indexOf(mode)];
        expect(answer, mode).toBe(expected);
      }
      (recorded[caller] ??= {})[target] = answers;
    });
  });

  /** Targets in Y, where R binds the caller. */
  const boundTargets = (caller: Caller): Target[] => caller === "R-in-X" ? ["otherCompany"] : ["own", "other", "private"];

  it.each([...BOUND, "R-in-X"] as Caller[])("enforce: %s gets the same answer from PUT .../title as from a title-only PATCH", async (caller) => {
    await setMode("enforce");
    for (const target of boundTargets(caller)) {
      const put = await rename(caller, target);
      const patch = await rename(caller, target, "patch");
      expect(put.res.status, target).toBe(patch.res.status);
      // A long-lived key without a run passes the access check on its own task,
      // then each route's own run rule (today's, for every agent) refuses it
      // with that route's code.
      if (put.answer === NO_RUN) {
        expect(patch.answer, target).toBe("403 cross_issue_influence_run_context_required");
        continue;
      }
      expect(put.answer, target).toBe(patch.answer);
    }
  });

  it("owner in X, restricted in Y, at enforce: X's task renamed, Y's task of another person 404 and unchanged", async () => {
    await setMode("enforce");
    const own = await rename("R-in-X", "own");
    expect(own.res.status).toBe(200);
    expect(own.renamed).toBe(true);
    const away = await rename("R-in-X", "otherCompany");
    expect(away.answer).toBe(NOT_FOUND);
    expect(away.renamed).toBe(false);
  });

  it("a run R authorized (working for nobody) is bound by R too: enforce 404, kill switch today's answer, failed read 503", async () => {
    const send = async () => {
      const issueId = await task(Y, P);
      const [run] = await db.insert(heartbeatRuns).values({ companyId: Y, agentId: agentPlain, status: "running",
        contextSnapshot: { issueId } }).returning();
      const who = { type: "agent", agentId: agentPlain, companyId: Y, runId: run!.id, source: "agent_jwt",
        onBehalfOfUserId: null, authorizingUserId: R, onBehalfOfMemberships: [] } as Actor;
      const res = await as(who).put(`/api/issues/${issueId}/title`).send({ title: "After" });
      return { answer: answerOf(res), renamed: (await titleOf(issueId)) === "After" };
    };
    await setMode("enforce");
    expect(await send()).toEqual({ answer: NOT_FOUND, renamed: false });
    await setMode("kill");
    expect(await send()).toEqual({ answer: NO_RUN, renamed: false });
    await setMode("enforce");
    await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '"broken"'::jsonb
      where company_id = ${Y} and principal_id = ${R}`);
    try {
      expect(await send()).toEqual({ answer: "503 MEMBER_RESTRICTION_UNAVAILABLE", renamed: false });
    } finally {
      await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '[]'::jsonb
        where company_id = ${Y} and principal_id = ${R}`);
    }
  });

  describe("AC-X1: a failed read refuses with 503, writes nothing", () => {
    const expectRefused = async (caller: Caller) => {
      const { issueId, res, renamed } = await rename(caller, "own");
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
      expect(renamed).toBe(false);
      const rows = await db.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.entityId, issueId));
      expect(rows).toEqual([]);
    };

    it.each(["report", "enforce"] as const)("%s: the resolver throws (unreadable restriction lists)", async (mode) => {
      await setMode(mode);
      await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '"broken"'::jsonb
        where company_id = ${Y} and principal_id = ${R}`);
      try {
        for (const caller of BOUND) await expectRefused(caller);
      } finally {
        await db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '[]'::jsonb
          where company_id = ${Y} and principal_id = ${R}`);
      }
    });

    it.each(["report", "enforce"] as const)("%s: the issue:read decision throws (strict read table gone)", async (mode) => {
      await setMode(mode);
      await db.execute(sql`alter table issue_access_grants rename to issue_access_grants_hidden`);
      try {
        for (const caller of BOUND) await expectRefused(caller);
      } finally {
        await db.execute(sql`alter table issue_access_grants_hidden rename to issue_access_grants`);
      }
    });
  });

  it("report: R renames another person's task: 200, one denial entry a day, a log line each call", async () => {
    await setMode("report");
    const denials = () => db.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, Y), eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION),
      eq(activityLog.responsibleUserId, R), sql`${activityLog.details} ->> 'ruleId' = 'R-read'`));
    await db.delete(activityLog).where(and(eq(activityLog.companyId, Y), eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION)));
    const warn = vi.spyOn(logger, "warn");
    const wouldRefuse = () => warn.mock.calls.filter(([, message]) => message === "member restriction would refuse").length;

    const first = await rename("R", "other");
    expect(first.res.status).toBe(200);
    expect(first.renamed).toBe(true);
    expect(await denials()).toHaveLength(1);
    expect(wouldRefuse()).toBe(1);

    const second = await rename("R", "other");
    expect(second.res.status).toBe(200);
    expect(await denials()).toHaveLength(1);
    expect(wouldRefuse()).toBe(2);
  });
});
