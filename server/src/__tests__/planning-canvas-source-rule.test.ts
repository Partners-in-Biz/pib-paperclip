import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  issues,
  planningCanvases,
  projects,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolPolicies,
  type Db,
} from "@paperclipai/db";
import { PLANNING_CANVAS_HANDOFF_ORIGIN_KIND } from "../services/planning-canvas-links.js";
import { PLANNING_CANVAS_BLUEPRINT_ORIGIN_KIND } from "../services/planning-canvas-blueprints.js";
import { PLANNING_CANVAS_ISSUE_ORIGIN_KIND } from "../services/planning-canvas-comments.js";
import {
  canvasOriginBoardId,
  canvasPersonalSourceVerdict,
  PLANNING_CANVAS_FLOW_ORIGIN_KIND,
} from "../services/planning-canvas-source-rule.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-14282 (plan PAR-14257 C "Interfaces", E "4a"; acceptance
 * `acceptance-par-14282` s.2): `canvas_personal_source_refused` through the
 * real tool gateway (`executeTool` -> `resolveConnectionGrant`) on embedded
 * Postgres. The board is read from the run's bound issue only.
 */

const support = await getEmbeddedPostgresTestSupport();
const REFUSED = "canvas_personal_source_refused";

describe("planning canvas source rule database support", () => {
  it("embedded Postgres runs here", () => {
    expect(support.supported, JSON.stringify(support)).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("gateway rule canvas_personal_source_refused (PAR-14282)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const ASKER = `asker-${randomUUID()}`;
  const OTHER = `other-${randomUUID()}`;
  let companyId = "";
  let agentId = "";
  let projectId = "";
  let personalConn = "";
  let sharedConn = "";
  let strictConn = "";
  const toolNames = new Map<string, string>();

  const gateway = () =>
    createToolGatewayService(db, {
      toolActionSigningSecret: "planning-canvas-source-rule",
      remoteHttpRequest: async (_url, init) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(init.body)).id, result: { content: [{ type: "text", text: "rows" }] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

  async function connection(name: string, credentialPolicy: "shared" | "per_user" | "per_user_with_fallback", grants: Array<"org" | string>) {
    const [application] = await db.insert(toolApplications).values({
      companyId, applicationKey: `${name}-${randomUUID().slice(0, 8)}`, name, type: "mcp_http", status: "active",
    }).returning();
    const [conn] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name, uid: `test/${randomUUID()}`, transport: "mcp_remote", status: "active",
      enabled: true, healthStatus: "ok", credentialPolicy, config: { url: "https://8.8.8.8/mcp" },
    }).returning();
    for (const grant of grants) {
      await db.insert(connectionGrants).values(grant === "org"
        ? { companyId, connectionId: conn!.id, kind: "organization", credentialSecretRefs: [], status: "active", isDefault: true }
        : { companyId, connectionId: conn!.id, kind: "user", subjectUserId: grant, credentialSecretRefs: [], status: "active" });
    }
    await db.insert(toolCatalogEntries).values({
      companyId, applicationId: application!.id, connectionId: conn!.id, entryKind: "tool", name: `${name}_read`, toolName: `${name}_read`,
      title: `${name} read`, riskLevel: "read", isReadOnly: true, status: "active", versionHash: randomUUID(), schemaHash: randomUUID(),
    });
    return conn!.id;
  }

  async function board(scope: "personal" | "project" | "company", userId: string | null = ASKER) {
    const [row] = await db.insert(planningCanvases).values({
      companyId, userId, title: `Board ${scope}`, scope, projectId: scope === "project" ? projectId : null, memberAccess: "edit",
    }).returning();
    return row!;
  }

  async function issue(originKind: string | null, originId: string | null) {
    const [row] = await db.insert(issues).values({
      companyId, title: "Work", status: "in_progress", assigneeAgentId: agentId, originKind: originKind ?? undefined, originId,
    }).returning();
    return row!;
  }

  /** A running run bound to `issueId` (or to nothing), working for `person`. */
  async function run(issueId: string | null, person: string | null = ASKER) {
    const [row] = await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "assignment", status: "running", responsibleUserId: person,
      contextSnapshot: issueId ? { issueId } : {},
    }).returning();
    return row!;
  }

  async function call(runId: string, connectionId: string, sessionIssueId?: string) {
    const gw = gateway();
    const session = await gw.createSession({ companyId, agentId, runId, ...(sessionIssueId ? { issueId: sessionIssueId } : {}) });
    const tool = (await gw.listToolsForSession(session.token)).find((candidate) => candidate.connectionId === connectionId);
    expect(tool, `tool of ${connectionId} listed`).toBeTruthy();
    toolNames.set(connectionId, tool!.name);
    try {
      const result = await gw.executeTool({ sessionToken: session.token, tool: tool!.name, parameters: {} });
      return result.status;
    } catch (error) {
      return (error as { reasonCode?: string }).reasonCode ?? String(error);
    }
  }

  const chatThread = async (b: { id: string }) => issue(PLANNING_CANVAS_ISSUE_ORIGIN_KIND, `${b.id}:chat`);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-source-rule-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Source rule", issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(companyMemberships).values([ASKER, OTHER].map((principalId) => ({
      companyId, principalType: "user" as const, principalId, status: "active", membershipRole: "operator" })));
    const [agent] = await db.insert(agents).values({ companyId, name: "Fetcher", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
    agentId = agent!.id;
    const [project] = await db.insert(projects).values({ companyId, name: "Client P" }).returning();
    projectId = project!.id;
    personalConn = await connection("personal", "per_user_with_fallback", ["org", ASKER]);
    sharedConn = await connection("shared", "shared", ["org"]);
    strictConn = await connection("strict", "per_user", []);
    await db.insert(toolPolicies).values({ companyId, name: "Allow reads", policyType: "allow", selectors: { riskLevel: "read" } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  it("control: a run on an ordinary issue uses the asker's personal grant", async () => {
    expect(await call((await run((await issue(null, null)).id)).id, personalConn)).toBe("completed");
  });

  describe.each([
    ["company", REFUSED],
    ["project", REFUSED],
    ["personal", "completed"],
  ] as const)("board chat run on a %s board", (scope, personalOutcome) => {
    it(`personal credential: ${personalOutcome}; a shared credential works`, async () => {
      const r = await run((await chatThread(await board(scope))).id);
      expect(await call(r.id, personalConn)).toBe(personalOutcome);
      expect(await call(r.id, sharedConn)).toBe("completed");
    });
  });

  it("a personal board of another person is not the asker's own: refused", async () => {
    const r = await run((await chatThread(await board("personal", OTHER))).id);
    expect(await call(r.id, personalConn)).toBe(REFUSED);
  });

  it("a personal board widened to the company (shared) is not own: refused; the shared credential works", async () => {
    const b = await board("personal");
    const r = await run((await chatThread(b)).id);
    expect(await call(r.id, personalConn)).toBe("completed");
    await db.update(planningCanvases).set({ scope: "company" }).where(eq(planningCanvases.id, b.id));
    expect(await call(r.id, personalConn)).toBe(REFUSED);
    expect(await call(r.id, sharedConn)).toBe("completed");
  });

  it("missing grant: per_user with no personal grant on a company board is refused with the canvas code, no prompt", async () => {
    const r = await run((await chatThread(await board("company"))).id);
    expect(await call(r.id, strictConn)).toBe(REFUSED);
    // Unchanged on the asker's own personal board: the person is asked to connect.
    const own = await run((await chatThread(await board("personal"))).id);
    expect(await call(own.id, strictConn)).toBe("user_authorization_required");
  });

  it("run with no person on a company board: no personal credential; the shared fallback is used", async () => {
    const r = await run((await chatThread(await board("company"))).id, null);
    expect(await call(r.id, strictConn)).toBe(REFUSED);
    expect(await call(r.id, personalConn)).toBe("completed"); // per_user_with_fallback: organization grant
    expect(await call(r.id, sharedConn)).toBe("completed");
  });

  it("a body issueId is never the board: a run with no bound issue that names a canvas thread is refused", async () => {
    const thread = await chatThread(await board("personal"));
    const unbound = await run(null);
    // Even the asker's own personal board thread: the binding is the run's, not the caller's.
    expect(await call(unbound.id, personalConn, thread.id)).toBe(REFUSED);
    expect(await call(unbound.id, sharedConn, thread.id)).toBe("completed");
    // No bound issue and no claimed issue: not a board run, personal grants unchanged.
    expect(await call((await run(null)).id, personalConn)).toBe("completed");
  });

  it("origin kinds: phase 1 mention issues and the single hand-off issue follow the rule; hand-off and blueprint kinds are unchanged", async () => {
    const company = await board("company");
    for (const originId of [company.id, `${company.id}:n1`, `${company.id}:handoff:tag1`]) {
      const r = await run((await issue(PLANNING_CANVAS_ISSUE_ORIGIN_KIND, originId)).id);
      expect(await call(r.id, personalConn), originId).toBe(REFUSED);
    }
    const flow = await run((await issue(PLANNING_CANVAS_FLOW_ORIGIN_KIND, `${company.id}:flow1`)).id);
    expect(await call(flow.id, personalConn)).toBe(REFUSED);
    for (const [kind, originId] of [
      [PLANNING_CANVAS_HANDOFF_ORIGIN_KIND, `${company.id}:tag1:n1`],
      [PLANNING_CANVAS_BLUEPRINT_ORIGIN_KIND, `${company.id}:root`],
    ] as const) {
      const r = await run((await issue(kind, originId)).id);
      expect(await call(r.id, personalConn), kind).toBe("completed");
    }
  });

  it("fail closed: hidden bound issue, missing board, failing lookup", async () => {
    const hidden = await chatThread(await board("personal"));
    const r = await run(hidden.id);
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hidden.id));
    expect(await call(r.id, personalConn)).toBe(REFUSED);
    expect(await call(r.id, sharedConn)).toBe("completed");

    const orphan = await run((await issue(PLANNING_CANVAS_ISSUE_ORIGIN_KIND, `${randomUUID()}:chat`)).id);
    expect(await call(orphan.id, personalConn)).toBe(REFUSED);

    const throwing = { select: () => { throw new Error("fixture: lookup failed"); } } as unknown as Db;
    expect(await canvasPersonalSourceVerdict(throwing, { companyId, runId: r.id, sessionIssueId: null, actingUserId: ASKER }))
      .toEqual({ refused: true, reason: "lookup_failed" });
    expect(await canvasPersonalSourceVerdict(db, { companyId, runId: randomUUID(), sessionIssueId: null, actingUserId: ASKER }))
      .toEqual({ refused: true, reason: "run_not_found" });
  });

  it("the board is the origin id up to the first colon", () => {
    expect(canvasOriginBoardId("b1:chat")).toBe("b1");
    expect(canvasOriginBoardId("b1:handoff:t")).toBe("b1");
    expect(canvasOriginBoardId("b1")).toBe("b1");
    expect(canvasOriginBoardId(null)).toBeNull();
  });
});
