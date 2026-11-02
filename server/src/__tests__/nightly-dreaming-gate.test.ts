import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import { accessService } from "../services/access.js";
import { agentService } from "../services/agents.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { companySkillPolicyService } from "../services/company-skill-policy.js";
import { routineService } from "../services/routines.js";
import { companySkillRoutes } from "../routes/company-skills.js";
import { routineRoutes } from "../routes/routines.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping nightly dreaming gate tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("nightly dreaming generic gates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-nightly-dreaming-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns 409 on the generic enable and run routes, and 403 on skill writes, when the flag is off", async () => {
    const previous = process.env.PAPERCLIP_NIGHTLY_DREAMING;
    delete process.env.PAPERCLIP_NIGHTLY_DREAMING;
    try {
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "responsible-user",
        requireBoardApprovalForNewAgents: false,
      });
      await agentService(db).create(companyId, {
        name: "CEO",
        role: "ceo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        runtimeConfig: {},
        permissions: {},
      });
      const ensured = await builtInAgentService(db).ensure(companyId, "reflection-coach");
      const coachId = ensured.agentId!;
      const [routine] = await db.select().from(routines).where(eq(routines.originId, "reflection-coach:nightly-dreaming"));
      const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine!.id));
      expect(routine).toMatchObject({ status: "paused", originKind: "built_in_agent_bundle" });
      expect(trigger).toMatchObject({ enabled: false });

      const access = accessService(db);
      await access.setPrincipalPermission(companyId, "agent", coachId, "skills:create", true, null);
      await access.setPrincipalPermission(companyId, "agent", coachId, "skills:suggest-changes", true, null);
      const decision = await companySkillPolicyService(db).evaluate({
        companyId,
        principal: { type: "agent", id: coachId, role: "general" },
        action: "skills.edit",
      });
      expect(decision).toMatchObject({
        allowed: false,
        reason: "explicit_rule",
        matchedRuleId: "reflection-coach-never-apply",
      });

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const url = req.originalUrl;
        (req as express.Request).actor = url.includes("/skills/")
          ? { type: "agent", companyId, agentId: coachId, source: "agent_key" }
          : { type: "board", source: "local_implicit", userId: "board-user", isInstanceAdmin: true };
        next();
      });
      app.use("/api", routineRoutes(db));
      app.use("/api", companySkillRoutes(db));
      app.use(errorHandler);

      const enableTrigger = await request(app)
        .patch(`/api/routine-triggers/${trigger!.id}`)
        .send({ enabled: true });
      expect(enableTrigger.status, JSON.stringify(enableTrigger.body)).toBe(409);
      expect(enableTrigger.body.code).toBe("nightly_dreaming_disabled");

      const activate = await request(app)
        .patch(`/api/routines/${routine!.id}`)
        .send({ status: "active" });
      expect(activate.status, JSON.stringify(activate.body)).toBe(409);
      expect(activate.body.code).toBe("nightly_dreaming_disabled");

      const addTrigger = await request(app)
        .post(`/api/routines/${routine!.id}/triggers`)
        .send({ kind: "schedule", cronExpression: "0 4 * * *", timezone: "UTC", enabled: true });
      expect(addTrigger.status, JSON.stringify(addTrigger.body)).toBe(409);
      expect(addTrigger.body.code).toBe("nightly_dreaming_disabled");

      const run = await request(app)
        .post(`/api/routines/${routine!.id}/run`)
        .send({});
      expect(run.status, JSON.stringify(run.body)).toBe(409);
      expect(run.body.code).toBe("nightly_dreaming_disabled");

      const skillWrite = await request(app)
        .delete(`/api/companies/${companyId}/skills/${randomUUID()}`);
      expect(skillWrite.status, JSON.stringify(skillWrite.body)).toBe(403);
      expect(skillWrite.body.code).toBe("skill_policy_denied");

      const [stillPaused] = await db.select().from(routines).where(eq(routines.id, routine!.id));
      const [stillOff] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger!.id));
      expect(stillPaused).toMatchObject({ status: "paused" });
      expect(stillOff).toMatchObject({ enabled: false });

      await db.update(routines).set({ status: "active" }).where(eq(routines.id, routine!.id));
      await db.update(routineTriggers).set({
        enabled: true,
        nextRunAt: new Date("2020-01-01T00:00:00.000Z"),
      }).where(eq(routineTriggers.id, trigger!.id));
      const tick = await routineService(db).tickScheduledTriggers(new Date("2026-10-29T04:00:00.000Z"));
      expect(tick.triggered).toBe(0);
      const runs = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine!.id));
      expect(runs).toEqual([
        expect.objectContaining({ status: "skipped", failureReason: "nightly_dreaming_disabled" }),
      ]);
      const opened = await db.select().from(issues).where(eq(issues.companyId, companyId));
      expect(opened.filter((issue) => issue.originKind === "routine_execution")).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_NIGHTLY_DREAMING;
      else process.env.PAPERCLIP_NIGHTLY_DREAMING = previous;
    }
  });
});
