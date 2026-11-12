import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, assets, companies, connectionGrants, createDb, heartbeatRuns, issues, projects, runnerApiResponseReservations,
  toolActionRequests, toolApplications, toolCatalogEntries, toolConnections, toolInvocations, toolPolicies,
  toolProfileBindings, toolProfiles,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { binarySpillRunScope, decodeStrictBase64, findBinarySpillCandidates, spillBinaryLeaves } from "../services/tool-gateway-binary-spill.js";
import { acquireRunnerApiResponseSlot, RunnerApiResponseLimitError } from "../services/native-runtime/runner-api-response-limits.js";
import { validateToolContent } from "../services/tool-content-guards.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { assetRoutes } from "../routes/assets.js";
import { errorHandler } from "../middleware/index.js";

const SAVED_NOTE = /^\[Paperclip saved this file \((\d+) bytes, ([a-z/]+)\) as artifact ([0-9a-f-]{36})\. Download it with GET \/api\/assets\/\3\/content and this run's API key\.\]$/;

/** A JPEG-signed buffer of the PAR-9904 size: 263,460 base64 chars. */
function jpeg(size = 197_593) {
  const bytes = randomBytes(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

function withSignature(signature: number[] | string, size = 200_000) {
  const bytes = randomBytes(size);
  bytes.set(typeof signature === "string" ? Buffer.from(signature, "latin1") : signature);
  return bytes;
}

function driveShape(base64: string, mimeType = "image/jpeg") {
  const file = { content: base64, id: "1AbCdEfG", mimeType, title: "Hero shot.jpg" };
  return { content: [{ type: "text", text: JSON.stringify(file) }], structuredContent: file };
}

type McpPart = { type?: string; text?: string; data?: string; mimeType?: string };
type DriveFile = { content: string; id: string; mimeType: string; title: string };
type McpShape = { content: McpPart[]; structuredContent: DriveFile };
type SavedFile = { artifactId: string; url: string; contentType: string; byteSize: number; sha256: string };
type GatewayCallOut = { status: string; result: { savedFiles?: SavedFile[]; content: string; data: McpShape } };

function fakeArtifact(bytes: Buffer, contentType: string) {
  const artifactId = randomUUID();
  return { artifactId, url: `/api/assets/${artifactId}/content`, contentType, byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

describe("binary spill leaves", () => {
  const spill = async (value: unknown) => {
    const capture = vi.fn(async (bytes: Buffer, contentType: string) => fakeArtifact(bytes, contentType));
    const out = await spillBinaryLeaves(value, findBinarySpillCandidates(value), capture);
    return { ...out, capture };
  };

  it("checks base64 strictly", () => {
    const bytes = jpeg(1000);
    expect(decodeStrictBase64(bytes.toString("base64"))?.equals(bytes)).toBe(true);
    expect(decodeStrictBase64(bytes.toString("base64url"))?.equals(bytes)).toBe(true);
    expect(decodeStrictBase64("ab+_")).toBeNull();
    expect(decodeStrictBase64("abc")).toBeNull();
    expect(decodeStrictBase64("ab=c")).toBeNull();
    expect(decodeStrictBase64("QR==")).toBeNull();
  });

  it("spills only for a session's own agent run, never for an approved execution", () => {
    const session = { companyId: "c", agentId: "a", runId: "r" };
    expect(binarySpillRunScope(session, false)).toEqual(session);
    expect(binarySpillRunScope({ ...session, runId: null }, false)).toBeNull();
    expect(binarySpillRunScope({ ...session, agentId: null }, false)).toBeNull();
    expect(binarySpillRunScope(session, true)).toBeNull();
  });

  it("saves one MCP image part over the limit", async () => {
    const bytes = withSignature([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { value, savedFiles, capture } = await spill({ content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]![0].equals(bytes)).toBe(true);
    expect(savedFiles).toEqual([expect.objectContaining({ contentType: "image/png", byteSize: bytes.length })]);
    expect((value as McpShape).content[0]!.data).toMatch(SAVED_NOTE);
  });

  it.each([
    ["resource blob, URL-safe pdf", { resource: { blob: withSignature("%PDF-1.7").toString("base64url"), mimeType: "application/pdf" } }],
    ["audio/mpeg frame sync", { type: "audio", data: withSignature([0xff, 0xfb]).toString("base64"), mimeType: "audio/mpeg" }],
    ["webp", { data: withSignature("RIFF\0\0\0\0WEBP").toString("base64"), mimeType: "image/webp; q=1" }],
  ])("saves %s", async (_label, value) => {
    expect((await spill(value)).savedFiles).toHaveLength(1);
  });

  it.each([
    ["text/plain", "text/plain", jpeg()],
    ["octet-stream", "application/octet-stream", jpeg()],
    ["svg", "image/svg+xml", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${"<g/>".repeat(60_000)}</svg>`)],
    ["a JSON secret labelled image/png", "image/png", Buffer.from(JSON.stringify({ apiKey: `sk-live-${"x".repeat(200_000)}` }))],
  ])("withholds %s", async (_label, mimeType, bytes) => {
    const value = driveShape(bytes.toString("base64"), mimeType);
    const { value: out, savedFiles, capture } = await spill(value);
    expect(capture).not.toHaveBeenCalled();
    expect(savedFiles).toEqual([]);
    expect(out).toBe(value);
    const validated = await validateToolContent({ value: out, direction: "result", promptInjectionMode: "ignore" });
    expect(validated.summary).not.toBeNull();
    expect(JSON.stringify(validated.value)).not.toContain(bytes.toString("base64").slice(0, 100));
  });

  it("withholds invalid and mixed-alphabet base64", async () => {
    const valid = jpeg().toString("base64");
    for (const text of [`${valid.slice(0, -4)}*AAA`, `${valid.slice(0, 1000)}-_${valid.slice(1002)}`, `${valid}A`]) {
      const { savedFiles, capture } = await spill(driveShape(text));
      expect(capture).not.toHaveBeenCalled();
      expect(savedFiles).toEqual([]);
    }
  });

  it.each([
    ["api_response_capture_busy", "file capture is busy, retry this call in a moment."],
    ["api_response_capture_limit", "This run has insufficient capture budget"],
    ["api_response_company_storage_limit", "Company API snapshot storage quota is exhausted"],
  ])("withholds with a note on %s", async (code, note) => {
    const bytes = jpeg();
    const value = driveShape(bytes.toString("base64"));
    const error = new RunnerApiResponseLimitError(code, code === "api_response_capture_busy" ? "busy"
      : code === "api_response_capture_limit" ? "This run has insufficient capture budget (4 GiB per run)." : "Company API snapshot storage quota is exhausted.");
    const onError = vi.fn();
    const out = await spillBinaryLeaves(value, findBinarySpillCandidates(value), async () => { throw error; }, onError);
    expect(onError).toHaveBeenCalledWith(error);
    expect(out.savedFiles).toEqual([]);
    const content = (out.value as McpShape).structuredContent.content;
    expect(content).toMatch(new RegExp(`^\\[Paperclip withheld this file \\(${bytes.length} bytes, image/jpeg\\): `));
    expect(content).toContain(note);
    expect(JSON.parse((out.value as McpShape).content[0]!.text!).content).toBe(content);
  });
});

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("gateway binary spill", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir = "";
  const storage = () => createStorageService(createLocalDiskStorageProvider(storageDir));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-binary-spill-");
    db = createDb(tempDb.connectionString);
    storageDir = mkdtempSync(path.join(tmpdir(), "binary-spill-"));
  }, 30_000);
  afterAll(async () => {
    await tempDb?.cleanup();
    rmSync(storageDir, { recursive: true, force: true });
  });

  async function fixture(mcpResult: () => unknown, options: Parameters<typeof createToolGatewayService>[1] = {}) {
    const [company] = await db.insert(companies).values({ name: `Spill ${randomUUID()}`, issuePrefix: `SP${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const companyId = company!.id;
    const newAgent = async () => (await db.insert(agents).values({ companyId, name: `Agent ${randomUUID()}`, role: "engineer",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning())[0]!;
    const agent = await newAgent();
    const [project] = await db.insert(projects).values({ companyId, name: "Spill" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, projectId: project!.id, title: "Spill", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, invocationSource: "assignment", status: "running",
      issueId: issue!.id, contextSnapshot: { issueId: issue!.id, projectId: project!.id } }).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: `all-${randomUUID()}`, name: "All", defaultAction: "allow" }).returning();
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile!.id, targetType: "agent", targetId: agent.id });
    const [application] = await db.insert(toolApplications).values({ companyId, applicationKey: `drive-${randomUUID().slice(0, 8)}`,
      name: "Drive", type: "mcp_http", status: "active" }).returning();
    const config = { url: "https://mcp.drive.test/mcp", sourceTemplateKey: "google-drive" };
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id, name: "Drive", uid: `test/${randomUUID()}`,
      transport: "mcp_remote", status: "active", enabled: true, healthStatus: "ok", config, transportConfig: config, credentialRefs: [], credentialSecretRefs: [] }).returning();
    await db.insert(connectionGrants).values({ companyId, connectionId: connection!.id, kind: "organization", credentialSecretRefs: [], status: "active", isDefault: true });
    await db.insert(toolCatalogEntries).values({ companyId, applicationId: application!.id, connectionId: connection!.id, entryKind: "tool",
      name: `download-${randomUUID()}`, toolName: "download_file_content", title: "Download", description: "Download a file",
      inputSchema: { type: "object", properties: { fileId: { type: "string" } }, additionalProperties: false },
      annotations: { readOnlyHint: true }, riskLevel: "read", isReadOnly: true, isWrite: false, isDestructive: false, status: "active", versionHash: randomUUID() });
    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "binary-spill-signing-secret",
      storage: storage(),
      remoteHttpRequest: async (_url, init) => {
        const body = JSON.parse(String(init.body ?? "{}"));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body?.id ?? "fixture", result: await mcpResult() }),
          { status: 200, headers: { "content-type": "application/json" } });
      },
      ...options,
    });
    const session = await gateway.createSession({ companyId, agentId: agent.id, runId: run!.id });
    const tool = (await gateway.listToolsForSession(session.token)).find(candidate => candidate.connectionId === connection!.id)!;
    expect(tool).toBeDefined();
    const call = async () => await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: { fileId: "1AbCdEfG" } }) as unknown as GatewayCallOut;
    const companyAssets = () => db.select().from(assets).where(eq(assets.companyId, companyId));
    return { companyId, agent, run: run!, issue: issue!, connection: connection!, gateway, call, newAgent, companyAssets };
  }

  function assetApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", assetRoutes(db, storage()));
    app.use(errorHandler);
    return app;
  }

  it("saves a Drive download as a run-scoped file only that run's agent can read", async () => {
    const bytes = jpeg();
    const base64 = bytes.toString("base64");
    expect(base64).toHaveLength(263_460);
    const f = await fixture(() => driveShape(base64));
    const out = await f.call();
    expect(out.status).toBe("completed");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(out.result.savedFiles).toEqual([{ artifactId: expect.any(String), url: `/api/assets/${out.result.savedFiles![0]!.artifactId}/content`,
      contentType: "image/jpeg", byteSize: 197_593, sha256 }]);
    const { artifactId } = out.result.savedFiles![0]!;
    const note = out.result.data.structuredContent.content;
    expect(note).toMatch(SAVED_NOTE);
    expect(note).toContain(artifactId);
    for (const text of [out.result.content, out.result.data.content[0]!.text!]) {
      expect(JSON.parse(text)).toEqual({ content: note, id: "1AbCdEfG", mimeType: "image/jpeg", title: "Hero shot.jpg" });
    }
    expect(JSON.stringify(out.result)).not.toContain(base64.slice(0, 64));
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, f.companyId));
    expect(invocation!.resultSizeBytes).toBeLessThan(10_000);

    const ownActor: Express.Request["actor"] = { type: "agent", agentId: f.agent.id, companyId: f.companyId, runId: f.run.id, keyScope: { kind: "standard" }, source: "agent_jwt" };
    const res = await request(assetApp(ownActor)).get(`/api/assets/${artifactId}/content`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(createHash("sha256").update(res.body as Buffer).digest("hex")).toBe(sha256);

    const other = await f.newAgent();
    const otherActor = { ...ownActor, agentId: other.id, runId: randomUUID() };
    expect([403, 404]).toContain((await request(assetApp(otherActor)).get(`/api/assets/${artifactId}/content`)).status);
  }, 60_000);

  it("saves the same bytes once when two parts carry them", async () => {
    const base64 = jpeg().toString("base64");
    const f = await fixture(() => ({ content: [{ type: "image", data: base64, mimeType: "image/jpeg" }, { type: "image", data: base64, mimeType: "image/jpeg" }] }));
    const out = await f.call();
    expect(out.result.savedFiles).toHaveLength(1);
    expect(out.result.data.content.map(part => part.data)).toEqual([expect.stringMatching(SAVED_NOTE), expect.stringMatching(SAVED_NOTE)]);
    expect(await f.companyAssets()).toHaveLength(1);
  }, 60_000);

  it("withholds with the busy note when capture slots are taken, never a 500", async () => {
    const base64 = jpeg().toString("base64");
    const f = await fixture(() => driveShape(base64));
    const releases = [acquireRunnerApiResponseSlot(f.companyId), acquireRunnerApiResponseSlot(f.companyId)];
    try {
      const out = await f.call();
      expect(out.status).toBe("completed");
      expect(out.result.savedFiles).toBeUndefined();
      expect(out.result.data.structuredContent.content).toContain("file capture is busy, retry this call in a moment.");
    } finally { releases.forEach(release => release()); }
    expect(await f.companyAssets()).toEqual([]);
  }, 60_000);

  it("withholds with the failed note when storage fails", async () => {
    const base64 = jpeg().toString("base64");
    const failing: StorageService = { ...storage(), putFile: async () => { throw new Error("disk gone"); } };
    const f = await fixture(() => driveShape(base64), { storage: failing });
    const out = await f.call();
    expect(out.status).toBe("completed");
    expect(out.result.data.structuredContent.content).toContain("file capture failed.");
  }, 60_000);

  it("withholds when the run finished while the tool ran", async () => {
    const base64 = jpeg().toString("base64");
    let runId = "";
    const f = await fixture(async () => {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      return driveShape(base64);
    });
    runId = f.run.id;
    const out = await f.call();
    expect(out.status).toBe("completed");
    expect(out.result.savedFiles).toBeUndefined();
    expect(JSON.stringify(out.result)).not.toContain(base64.slice(0, 64));
    expect(await f.companyAssets()).toEqual([]);
    expect(await db.select().from(runnerApiResponseReservations).where(eq(runnerApiResponseReservations.runId, f.run.id))).toEqual([]);
  }, 60_000);

  it("withholds for an approved-action execution", async () => {
    const base64 = jpeg().toString("base64");
    const f = await fixture(() => driveShape(base64));
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Review", policyType: "require_approval",
      selectors: { connectionId: f.connection.id }, priority: 1 });
    await expect(f.call()).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [pending] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.companyId));
    await f.gateway.approveActionRequest({ companyId: f.companyId, actionRequestId: pending!.id, actor: { userId: "board" } });
    await vi.waitFor(async () => {
      const [invocation] = await db.select().from(toolInvocations)
        .where(eq(toolInvocations.id, pending!.invocationId));
      expect(invocation?.status).toBe("succeeded");
    }, { timeout: 20_000 });
    const rows = await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, f.companyId));
    expect(rows.every(row => !JSON.stringify(row.resultSummary).includes(base64.slice(0, 64)))).toBe(true);
    expect(await f.companyAssets()).toEqual([]);
  }, 60_000);
});
