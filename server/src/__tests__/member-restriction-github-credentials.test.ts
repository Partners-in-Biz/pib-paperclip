import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { githubCredentialsFixture } from "./helpers/github-credentials-fixture.js";
import { errorHandler } from "../middleware/index.js";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { companySkillService } from "../services/company-skills.js";
import { environmentService } from "../services/environments.js";
import { createGitRemoteAuthProvider, resolveManagedGitHubCredential } from "../services/git-credentials.js";
import { prepareHeartbeatExecutionConfiguration } from "../services/heartbeat/execution-configuration.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { MEMBER_RESTRICTION_DENIED_ACTION } from "../services/member-restriction/admin.js";
import { GITHUB_CREDENTIALS_RULE_ID } from "../services/member-restriction/github-credentials.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { secretService } from "../services/secrets.js";

/**
 * PAR-12608 4.6a row 5 and 4.9 decision 4 (PAR-13220): a run working for a
 * flagged member R in a company on `enforce` gets no GitHub credential, by the
 * runtime credentials route, the git remote provider or the host's token. An
 * unflagged operator O in the same company keeps today's answer.
 */

const vault = vi.hoisted(() => ({
  resolveUserSecretValue: vi.fn(async (_company: string, input: { responsibleUserId: string }) => ({
    value: `test-token-${input.responsibleUserId}`,
  })),
  resolveSecretValue: vi.fn(async () => "test-dedicated-token"),
}));
vi.mock("../services/secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/secrets.js")>();
  return { ...actual, secretService: (db: Parameters<typeof actual.secretService>[0]) => ({ ...actual.secretService(db), ...vault }) };
});
vi.mock("../services/git-credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/git-credentials.js")>();
  return { ...actual, resolveManagedGitHubCredential: vi.fn(actual.resolveManagedGitHubCredential) };
});

const R = "A", O = "B";
const support = await getEmbeddedPostgresTestSupport();

describe("4.6a row 5 database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("4.6a row 5: no GitHub credential for a run of a restricted person", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const oldHome = process.env.PAPERCLIP_HOME;
  const { seed, grant } = githubCredentialsFixture(() => db);

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-member-restriction-github-");
    db = createDb(database.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-member-restriction-github-"));
    process.env.PAPERCLIP_HOME = home;
  }, 60_000);
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  }, 60_000);

  /** R (`A`) flagged, O (`B`) not, one company; the seeded run works for R. */
  async function company(mode: "enforce" | "report" = "enforce") {
    const input = await seed();
    await db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, input.companyId));
    await db.update(companyMemberships).set({ restricted: true })
      .where(and(eq(companyMemberships.companyId, input.companyId), eq(companyMemberships.principalId, R)));
    return input;
  }
  async function runFor(input: Awaited<ReturnType<typeof seed>>, person: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.agentId, status: "running",
      contextSnapshot: { issueId: input.issueId } });
    await initializeRunIdentity(db, { companyId: input.companyId, runId, responsibleUserId: person, cause: "instruction" });
    return { ...input, runId };
  }
  function post(input: { companyId: string; agentId: string; runId: string }, person: string) {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-member-restriction-github-secret");
    const app = express();
    app.use(express.json());
    app.use(runtimeConnectionIntentRoutes(db));
    app.use(errorHandler);
    const token = createRuntimeToolsToken({ ...input, responsibleUserId: person, scope: "github_credentials" })!.token;
    return request(app).post("/runtime-tools/github/credentials").set("Authorization", `Bearer ${token}`);
  }
  async function denials(companyId: string) {
    return (await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION))))
      .map((row) => row.details);
  }
  function credentialStoreRead() {
    return vi.mocked(resolveManagedGitHubCredential).mock.calls.length
      + vault.resolveUserSecretValue.mock.calls.length + vault.resolveSecretValue.mock.calls.length;
  }
  async function hostGitHub(input: Awaited<ReturnType<typeof seed>>, person: string) {
    const [agent] = await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: {} })
      .where(eq(agents.id, input.agentId)).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: input.companyId, agentId: input.agentId, issueId: input.issueId,
      scopeKind: "issue", status: "running", responsibleUserId: person, contextSnapshot: {} }).returning();
    const environment = await environmentService(db).ensureLocalEnvironment();
    const prepared = await prepareHeartbeatExecutionConfiguration(db, {
      run, agent,
      task: { issueId: input.issueId, context: { issueId: input.issueId }, responsibleUserId: person,
        acceptedPlanContinuationWake: false, acceptedPlanWakeRoutingDecision: null,
        taskProjectContext: null, routineEnvContext: { routineId: null, env: null, responsibleUserId: null } },
      config: { sourceWorkspaceConfig: {}, aiBinding: undefined },
      policy: { trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
        useIsolatedTaskDirectory: false, explicitTaskDirectory: false, requestedExecutionWorkspaceMode: "shared_workspace" },
      environment: { selectedEnvironmentId: environment.id, selectedEnvironmentForConfig: environment,
        resolvedInstanceSettings: await instanceSettingsService(db).get(), persistedNativeExecutionInput: null },
      services: { secretsSvc: secretService(db), companySkills: companySkillService(db), appendRunEvent: vi.fn(),
        finalizeAiConnectionBusyDeferral: vi.fn() },
      onFailureSecretsResolved: () => {}, onManagedAiRuntimeAcquired: () => {}, onIdentityRedactorPrepared: () => {},
    } as Parameters<typeof prepareHeartbeatExecutionConfiguration>[1]);
    if (!prepared.prepared) throw new Error("configuration was not prepared");
    return prepared.useHostGitHub;
  }

  it("enforce: R's run gets unavailable, no env, and the credential store is never read", async () => {
    const input = await company();
    await grant(input, R);
    const response = await post(input, R);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "unavailable", reason: expect.stringContaining("GitHub access is limited") });
    expect(response.body.env).toEqual({});
    expect(credentialStoreRead()).toBe(0);
    expect(await denials(input.companyId)).toEqual([expect.objectContaining({
      personId: R, ruleId: GITHUB_CREDENTIALS_RULE_ID, target: "github_operation_credentials", objectId: input.runId, mode: "enforce",
    })]);
  });

  it("control: O's run in the same company gets today's managed credential", async () => {
    const input = await company();
    await grant(input, O);
    const response = await post(await runFor(input, O), O);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "available", login: O, authenticationMode: "managed" });
    expect(Object.keys(response.body.env).length).toBeGreaterThan(0);
    expect(await denials(input.companyId)).toEqual([]);
  });

  it("every caller is bound: the git remote provider never falls back to a company secret or the server token", async () => {
    const input = await company();
    const secrets = {
      getByName: vi.fn(async () => ({ id: randomUUID() })),
      resolveSecretValue: vi.fn(async () => "company-secret-token"),
    };
    const provider = createGitRemoteAuthProvider(db, input.companyId, { heartbeatRunId: input.runId, agentId: input.agentId },
      { secrets: secrets as never, env: { GITHUB_TOKEN: "server-env-token" } });
    const invocation = await provider("https://github.com/acme/repo.git");
    expect(JSON.stringify(invocation)).not.toMatch(/company-secret-token|server-env-token/);
    expect(secrets.getByName).not.toHaveBeenCalled();
    expect(secrets.resolveSecretValue).not.toHaveBeenCalled();
  });

  it("host credentials: R's run with no managed connection on a local environment does not use the host's GitHub; O's does", async () => {
    const input = await company();
    expect(await hostGitHub(input, R)).toBe(false);
    expect(await hostGitHub(input, O)).toBe(true);
  });

  it("kill switch (AC-F8): variable off, column enforce: R's run gets today's answers", async () => {
    const input = await company();
    await grant(input, R);
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const response = await post(input, R);
    expect(response.body).toMatchObject({ status: "available", login: R });
    expect(await hostGitHub(await company(), R)).toBe(true);
    expect(await denials(input.companyId)).toEqual([]);
  });

  it("failing read (AC-X1): 503 MEMBER_RESTRICTION_UNAVAILABLE, no credential, and run preparation refused", async () => {
    const input = await company();
    await grant(input, R);
    await db.execute(sql`UPDATE company_memberships SET restricted_plugin_keys = '{"broken": true}'::jsonb
      WHERE company_id = ${input.companyId} AND principal_id = ${R}`);
    const response = await post(input, R);
    expect(response.status).toBe(503);
    expect(response.body).not.toHaveProperty("env");
    expect(JSON.stringify(response.body)).not.toContain(`test-token-${R}`);
    expect(credentialStoreRead()).toBe(0);
    const unmanaged = await company();
    await db.execute(sql`UPDATE company_memberships SET restricted_plugin_keys = '{"broken": true}'::jsonb
      WHERE company_id = ${unmanaged.companyId} AND principal_id = ${R}`);
    await expect(hostGitHub(unmanaged, R)).rejects.toMatchObject({ status: 503, details: { code: "MEMBER_RESTRICTION_UNAVAILABLE" } });
  });

  it("report: R gets today's answer and one member_restriction.denied entry in mode report", async () => {
    const input = await company("report");
    await grant(input, R);
    const response = await post(input, R);
    expect(response.body).toMatchObject({ status: "available", login: R });
    expect(await hostGitHub(await company("report"), R)).toBe(true);
    expect(await denials(input.companyId)).toEqual([expect.objectContaining({
      personId: R, ruleId: GITHUB_CREDENTIALS_RULE_ID, target: "github_operation_credentials", mode: "report",
    })]);
  });
});
