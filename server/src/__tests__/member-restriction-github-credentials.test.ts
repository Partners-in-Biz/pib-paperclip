import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companyMemberships, connectionGrantDelegations, createDb, heartbeatRuns, issueWorkProducts,
  runIdentityContexts } from "@paperclipai/db";
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
import {
  GITHUB_CREDENTIALS_RESTRICTED_REASON,
  GITHUB_CREDENTIALS_RULE_ID,
  GRANT_GITHUB_CREDENTIALS_RESTRICTED_REASON,
} from "../services/member-restriction/github-credentials.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { secretService } from "../services/secrets.js";
import { workProductService } from "../services/work-products.js";

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
  async function company(mode: "enforce" | "report" | "off" = "enforce") {
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
    expect(invocation?.env).toMatchObject({ GITHUB_TOKEN: "", GH_TOKEN: "", GIT_CONFIG_GLOBAL: "/dev/null" });
    expect(secrets.getByName).not.toHaveBeenCalled();
    expect(secrets.resolveSecretValue).not.toHaveBeenCalled();
    expect(credentialStoreRead()).toBe(0);
    const [context] = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.runId, input.runId));
    expect(context.github).toMatchObject({ status: "unavailable", reason: GITHUB_CREDENTIALS_RESTRICTED_REASON });
    expect(await denials(input.companyId)).toEqual([expect.objectContaining({
      personId: R, ruleId: GITHUB_CREDENTIALS_RULE_ID, target: "github_operation_credentials", objectId: input.runId, mode: "enforce",
    })]);
  });

  /** A run row with a person and no identity context (one that predates identity contexts). */
  async function contextlessRun(input: Awaited<ReturnType<typeof seed>>, person: string) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: input.companyId, agentId: input.agentId, status: "running",
      responsibleUserId: person, contextSnapshot: { issueId: input.issueId } }).returning();
    expect(run.activeIdentityContextId).toBeNull();
    return run.id;
  }
  function legacySources() {
    return {
      secrets: { getByName: vi.fn(async () => ({ id: randomUUID() })), resolveSecretValue: vi.fn(async () => "company-secret-token") },
      env: { GITHUB_TOKEN: "server-env-token" },
    };
  }

  it("git remote provider, run with no identity context: R gets no managed, company-secret or server token", async () => {
    const input = await company();
    await grant(input, R);
    const runId = await contextlessRun(input, R);
    const legacy = legacySources();
    const provider = createGitRemoteAuthProvider(db, input.companyId, { heartbeatRunId: runId, agentId: input.agentId },
      { secrets: legacy.secrets as never, env: legacy.env });
    const invocation = await provider("https://github.com/acme/repo.git");
    expect(invocation?.env).toMatchObject({ GITHUB_TOKEN: "", GH_TOKEN: "", PAPERCLIP_GIT_TOKEN: "", GIT_CONFIG_GLOBAL: "/dev/null" });
    expect(JSON.stringify(invocation)).not.toMatch(/company-secret-token|server-env-token|test-token/);
    expect(legacy.secrets.getByName).not.toHaveBeenCalled();
    expect(credentialStoreRead()).toBe(0);
    expect(await denials(input.companyId)).toEqual([expect.objectContaining({
      personId: R, ruleId: GITHUB_CREDENTIALS_RULE_ID, target: "git_remote_credentials", objectId: runId, mode: "enforce",
    })]);
  });

  it("git remote provider, run with no identity context: O's run keeps today's company secret", async () => {
    const input = await company();
    const runId = await contextlessRun(input, O);
    const legacy = legacySources();
    const provider = createGitRemoteAuthProvider(db, input.companyId, { heartbeatRunId: runId, agentId: input.agentId },
      { secrets: legacy.secrets as never, env: legacy.env });
    expect((await provider("https://github.com/acme/repo.git"))?.env.GITHUB_TOKEN).toBe("company-secret-token");
    expect(await denials(input.companyId)).toEqual([]);
  });

  it("git remote provider, caller's person (issue path, no run): R's issue gets no token; a stated run of another company fails closed", async () => {
    const input = await company();
    const legacy = legacySources();
    const forIssue = createGitRemoteAuthProvider(db, input.companyId, { issueId: input.issueId, responsibleUserId: R },
      { secrets: legacy.secrets as never, env: legacy.env });
    expect((await forIssue("https://github.com/acme/repo.git"))?.env.GITHUB_TOKEN).toBe("");
    const unknownRun = createGitRemoteAuthProvider(db, input.companyId, { heartbeatRunId: randomUUID() },
      { secrets: legacy.secrets as never, env: legacy.env });
    expect((await unknownRun("https://github.com/acme/repo.git"))?.env.GITHUB_TOKEN).toBe("");
    expect(legacy.secrets.getByName).not.toHaveBeenCalled();
    expect(await denials(input.companyId)).toEqual([expect.objectContaining({
      personId: R, target: "git_remote_credentials", objectId: input.issueId, mode: "enforce",
    })]);
  });

  it("one person source: a run row and identity context that disagree fail closed", async () => {
    const input = await company();
    await grant(input, O);
    const run = await runFor(input, O);
    await db.update(heartbeatRuns).set({ responsibleUserId: R }).where(eq(heartbeatRuns.id, run.runId));
    const result = await resolveGitHubOperationCredentials(db, run);
    expect(result).toMatchObject({ status: "unavailable", reason: GITHUB_CREDENTIALS_RESTRICTED_REASON, env: {} });
    expect(credentialStoreRead()).toBe(0);
    expect(await denials(input.companyId)).toEqual([expect.objectContaining({ personId: R, objectId: run.runId, mode: "enforce" })]);
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
  // Review round 2 (PAR-14561): a stated run that is not in the company fails
  // closed under `enforce` only (covered above); `off` and `report` keep today's answer.
  for (const mode of ["off", "report"] as const) {
    it(`git remote provider, unknown run on ${mode}: today's company secret, no denial`, async () => {
      const input = await company(mode);
      const legacy = legacySources();
      const unknownRun = createGitRemoteAuthProvider(db, input.companyId, { heartbeatRunId: randomUUID() },
        { secrets: legacy.secrets as never, env: legacy.env });
      expect((await unknownRun("https://github.com/acme/repo.git"))?.env.GITHUB_TOKEN).toBe("company-secret-token");
      expect(await denials(input.companyId)).toEqual([]);
    });
  }

  /** A company_default (ownerless) run whose only GitHub grant is R's, delegated to the agent. */
  async function delegatedOwnerlessRun(input: Awaited<ReturnType<typeof seed>>, person: string) {
    const delegated = await grant(input, person);
    await db.insert(connectionGrantDelegations).values({
      companyId: input.companyId, grantId: delegated.id, agentId: input.agentId, createdByUserId: person,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.agentId, status: "running",
      contextSnapshot: { issueId: input.issueId } });
    await initializeRunIdentity(db, { companyId: input.companyId, runId, issueId: input.issueId, responsibleUserId: null,
      cause: "company_default" });
    const [context] = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.runId, runId));
    expect(context).toMatchObject({ cause: "company_default", responsibleUserId: null });
    return { ...input, runId };
  }

  it("delegation, enforce: an ownerless run with R's delegated grant gets unavailable and no vault read", async () => {
    const input = await company();
    const run = await delegatedOwnerlessRun(input, R);
    const result = await resolveGitHubOperationCredentials(db, run);
    expect(result).toMatchObject({ status: "unavailable", reason: GRANT_GITHUB_CREDENTIALS_RESTRICTED_REASON, env: {} });
    expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
    expect(vault.resolveSecretValue).not.toHaveBeenCalled();
    expect(await denials(input.companyId)).toEqual([expect.objectContaining({
      personId: R, ruleId: GITHUB_CREDENTIALS_RULE_ID, target: "managed_github_grant", objectId: run.runId, mode: "enforce",
    })]);
  });

  it("delegation, enforce: the git remote provider with no person does not fall back to R's grant, a secret or the server token", async () => {
    const input = await company();
    await delegatedOwnerlessRun(input, R);
    const legacy = legacySources();
    const provider = createGitRemoteAuthProvider(db, input.companyId, { agentId: input.agentId },
      { secrets: legacy.secrets as never, env: legacy.env });
    await expect(provider("https://github.com/acme/repo.git")).rejects.toThrow(GRANT_GITHUB_CREDENTIALS_RESTRICTED_REASON);
    expect(legacy.secrets.getByName).not.toHaveBeenCalled();
    expect(vault.resolveUserSecretValue).not.toHaveBeenCalled();
  });

  it("delegation, report: the ownerless run gets R's token and one report denial", async () => {
    const input = await company("report");
    const run = await delegatedOwnerlessRun(input, R);
    const result = await resolveGitHubOperationCredentials(db, run);
    expect(result).toMatchObject({ status: "available", login: R });
    expect(vault.resolveUserSecretValue).toHaveBeenCalledTimes(1);
    expect(await denials(input.companyId)).toEqual([expect.objectContaining({
      personId: R, target: "managed_github_grant", mode: "report",
    })]);
  });

  it("delegation, off: the ownerless run gets R's token and no denial", async () => {
    const input = await company("off");
    const run = await delegatedOwnerlessRun(input, R);
    expect(await resolveGitHubOperationCredentials(db, run)).toMatchObject({ status: "available", login: R });
    expect(await denials(input.companyId)).toEqual([]);
  });

  /** Work products read GitHub with the company's credential on a caller's request. */
  function workProducts() {
    const resolveCommitDetails = vi.fn(async () => ({ additions: 1, deletions: 1, changedFiles: 1 }));
    const resolvePullRequestDetails = vi.fn(async () => ({ state: "merged", headRef: null, headSha: null,
      workProductState: "merged" }) as never);
    return { resolveCommitDetails, resolvePullRequestDetails,
      svc: workProductService(db, { resolveCommitDetails, resolvePullRequestDetails }) };
  }
  const commit = { provider: "github", url: "https://github.com/acme/private/commit/9c12ae7b41e5" };
  async function pullRequestProduct(input: Awaited<ReturnType<typeof seed>>) {
    await db.insert(issueWorkProducts).values({ companyId: input.companyId, issueId: input.issueId, type: "pull_request",
      provider: "github", title: "PR", url: "https://github.com/acme/private/pull/7", status: "open" });
  }

  it("work products, enforce: R's request reads no commit stats or pull request state with the company credential; O's does", async () => {
    const input = await company();
    await pullRequestProduct(input);
    const { svc, resolveCommitDetails, resolvePullRequestDetails } = workProducts();
    expect(await svc.resolveCommitDiffSummary(input.companyId, commit, { personIds: [R] })).toBeNull();
    await svc.listForIssue(input.issueId, { refreshPullRequests: true, personIds: [R] });
    expect(resolveCommitDetails).not.toHaveBeenCalled();
    expect(resolvePullRequestDetails).not.toHaveBeenCalled();
    expect(await denials(input.companyId)).toEqual([expect.objectContaining({
      personId: R, target: "github_api_credentials", mode: "enforce",
    })]);
    expect(await svc.resolveCommitDiffSummary(input.companyId, commit, { personIds: [O] })).toMatchObject({ changedFiles: 1 });
    await svc.listForIssue(input.issueId, { refreshPullRequests: true, personIds: [O] });
    expect(resolvePullRequestDetails).toHaveBeenCalledTimes(1);
  });

  for (const mode of ["off", "report"] as const) {
    it(`work products, ${mode}: R's request keeps today's GitHub lookups`, async () => {
      const input = await company(mode);
      await pullRequestProduct(input);
      const { svc, resolveCommitDetails, resolvePullRequestDetails } = workProducts();
      expect(await svc.resolveCommitDiffSummary(input.companyId, commit, { personIds: [R] })).toMatchObject({ changedFiles: 1 });
      await svc.listForIssue(input.issueId, { refreshPullRequests: true, personIds: [R] });
      expect(resolveCommitDetails).toHaveBeenCalledTimes(1);
      expect(resolvePullRequestDetails).toHaveBeenCalledTimes(1);
      expect((await denials(input.companyId)).map((d) => (d as { mode: string }).mode)).toEqual(mode === "report" ? ["report"] : []);
    });
  }
});
