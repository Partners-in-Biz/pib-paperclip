/** saveDriveFile and driveFileSave tool handler on real Postgres. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { vi, afterEach } from "vitest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { saveDriveFile, type SaveDriveFileInput } from "../src/drive/save.js";
import { driveFileSave } from "../src/drive/tools.js";
import * as brokerModule from "../src/drive/broker.js";
import { listDriveFiles, getDriveFile } from "../src/drive/store.js";
import { insertAccount } from "../src/db.js";
import { createAccount } from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";
import { createFakeBroker, type FakeBrokerState } from "./support/fake-broker.js";
import type { Broker } from "../src/drive/broker.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const CO_A = "co-a", CO_B = "co-b";
const available = await embeddedAvailable();

describe.skipIf(!available)("saveDriveFile and driveFileSave", () => {
  let pg: PgHarness, ctx: PluginContext;
  let tempDir: string;

  beforeAll(async () => {
    pg = await startPg();
    tempDir = mkdtempSync(join(tmpdir(), "drive-file-save-"));
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    await pg.reset();
    ctx = pg.ctx;
    await insertAccount(ctx, createAccount({ companyId: CO_A, name: "Company A" }));
    await insertAccount(ctx, createAccount({ companyId: CO_B, name: "Company B" }));
  });

  function setupContext(brokerState?: FakeBrokerState, failWithUpload?: number) {
    const { uploadFetch: realUploadFetch, state } = createFakeBroker({ failWith: failWithUpload });
    const brokerState_ = brokerState || state;
    const folderCache = new Map<string, { id: string; path: string }>();

    const brokerFactory = (fetchFn: any, cfg: any) => {
      const broker: Broker = {
        resolve: async () => null,
        ensure: async (body) => {
          const cacheKey = `${body.entity_type}:${body.entity_id}`;
          let cached = folderCache.get(cacheKey);
          let wasCreated = !cached;
          if (!cached) {
            cached = { id: `folder_${Math.random().toString(36).slice(2, 11)}`, path: `02 Partners in Biz/Projects/${body.entity_id}/Deliverables` };
            folderCache.set(cacheKey, cached);
          }
          return {
            folder: { id: cached.id, entity_type: body.entity_type, entity_id: body.entity_id, path: cached.path, folder_id: cached.id, folder_url: `https://drive.google.com/drive/folders/${cached.id}` },
            created: wasCreated,
            tree: [{ path: cached.path, folderId: cached.id, created: wasCreated }],
          };
        },
        uploadFile: async (input) => {
          const formData = new FormData();
          const blob = new Blob([Buffer.from(input.bytes)], { type: input.mimeType });
          formData.append("file", blob as any, input.name);
          formData.append("name", input.name);
          formData.append("sharedDriveId", cfg.sharedDriveId);
          if (input.parentFolderId) formData.append("parentFolderId", input.parentFolderId);
          const response = await realUploadFetch("http://broker/upload", { method: "POST", headers: { Authorization: `Bearer ${cfg.token}` }, body: formData });
          const result = JSON.parse(await response.text());
          if (!response.ok || !result.success) {
            const error = new Error(result.error?.message || "Upload failed");
            (error as any).status = response.status;
            (error as any).code = result.error?.code || "upload_failed";
            (error as any).retryable = response.status >= 500;
            throw error;
          }
          return result.data;
        },
      };
      return broker;
    };

    vi.spyOn(brokerModule, 'createBroker' as any).mockImplementation(brokerFactory);
    ctx.http = { fetch: async () => ({} as any) };
    const configMap = new Map<string, any>();
    ctx.config = { get: async (companyId: string) => configMap.get(companyId) ?? null, set: async (companyId: string, value: any) => configMap.set(companyId, value) } as any;
    ctx.projects = { get: async (projectId: string, companyId: string) => projectId.startsWith('p') ? { id: projectId, companyId, name: projectId } : null, list: async () => [] } as any;

    const viewer = { companyId: CO_A, userId: "user-1", runId: "run-1", agentId: "agent-1", role: "agent" as const };
    return { viewer, brokerState: brokerState_, configMap };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function configureCompanyDrive(companyId: string, configMap: Map<string, any>, brokerToken = "fake-token", sharedDriveId = `drive-${companyId}`) {
    configMap.set(companyId, { driveBrokerToken: brokerToken, drive: { sharedDriveId } });
  }

  it("contentBase64 save -> status 'saved', url no sig, 1 upload", async () => {
    const { viewer, brokerState, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 test v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("content").toString("base64"),
    });
    expect(result.status).toBe("saved");
    expect(result.url).not.toMatch(/X-Amz|Signature|token/);
    expect(brokerState.requests).toHaveLength(1);
  });

  it("path source save -> status 'saved', 1 upload", async () => {
    const { viewer, brokerState, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const filePath = join(tempDir, "test.txt");
    writeFileSync(filePath, "content");
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "product", name: "PAR-1-1729346000.txt", mimeType: "text/plain", path: filePath,
    }, { allowedRoots: [tempDir] });
    expect(result.status).toBe("saved");
    expect(brokerState.requests).toHaveLength(1);
  });

  it("duplicate -> status 'saved', duplicate:true, 1 upload total", async () => {
    const { viewer, brokerState, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const cb = Buffer.from("Same").toString("base64");
    const input = { companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 dup v1.txt", mimeType: "text/plain", contentBase64: cb };
    const r1 = await saveDriveFile(ctx, viewer, input);
    expect(r1.status).toBe("saved");
    const count1 = brokerState.requests.length;
    const r2 = await saveDriveFile(ctx, viewer, input);
    expect(r2.duplicate).toBe(true);
    expect(r2.driveFileId).toBe(r1.driveFileId);
    expect(brokerState.requests).toHaveLength(count1);
  });

  it.each(["foo.png", "2026-13-45 x v1.png", "2026-02-31 x v1.png", "2026-10-20 x.png", "2026-10-20 x v1", "path/to/file.png", "file/../name.png", ".hidden.png", "file\ncontrol.png"])("invalid name '%s'", async (name) => {
    const { viewer, brokerState, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name, mimeType: "image/png", contentBase64: Buffer.from("t").toString("base64"),
    });
    expect(result.status).toBe("invalid_name");
    expect(brokerState.requests).toHaveLength(0);
  });

  it.each(["PAR-4059-1760000000.png", "BUG-123-456789.pdf", "TASK-1-9999999.txt"])("valid evidence '%s'", async (name) => {
    const { viewer, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name, mimeType: "image/png", contentBase64: Buffer.from(name).toString("base64"),
    });
    expect(result.status).toBe("saved");
  });

  it("path outside root -> path_not_allowed, no /etc in hint", async () => {
    const { viewer, brokerState, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 out v1.txt", mimeType: "text/plain", path: "/etc/hostname",
    }, { allowedRoots: [tempDir] });
    expect(result.status).toBe("path_not_allowed");
    expect(brokerState.requests).toHaveLength(0);
    if (result.hint) expect(result.hint).not.toContain("/etc");
  });

  it("bare name (no path) -> path_not_allowed, result doesn't contain input", async () => {
    const { viewer, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const input = "secret.png";
    const result = await saveDriveFile(ctx, viewer, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 out v1.txt", mimeType: "text/plain", path: input,
    }, { allowedRoots: [tempDir] });
    expect(result.status).toBe("path_not_allowed");
    expect(JSON.stringify(result)).not.toContain(input);
  });

  it("path with trailing slash -> path_not_allowed, result doesn't contain input", async () => {
    const { viewer, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const input = "/etc/passwd/";
    const result = await saveDriveFile(ctx, viewer, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 out v1.txt", mimeType: "text/plain", path: input,
    }, { allowedRoots: [tempDir] });
    expect(result.status).toBe("path_not_allowed");
    expect(JSON.stringify(result)).not.toContain(input);
  });

  it("unbound company -> drive_not_bound", async () => {
    const { viewer, brokerState } = setupContext();
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 test v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("t").toString("base64"),
    });
    expect(result.status).toBe("drive_not_bound");
    expect(brokerState.requests).toHaveLength(0);
  });

  it.each([
    ["invalid_kind", "invalid_kind_xyz", Buffer.from("t").toString("base64"), undefined],
    ["invalid_input", "client", undefined, undefined],
    ["too_large", "client", Buffer.from("x".repeat(5 * 1024 * 1024 + 1)).toString("base64"), undefined],
    ["sha_mismatch", "client", Buffer.from("t").toString("base64"), "a".repeat(64)],
  ] as const)("error: %s", async (status, kind, cb64, sha) => {
    const { viewer, brokerState, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: kind, name: "2026-10-20 test v1.txt", mimeType: "text/plain", contentBase64: cb64, sha256: sha,
    });
    expect(result.status).toBe(status);
    expect(brokerState.requests).toHaveLength(0);
  });

  it.each([[500], [401]] as const)("broker %i -> broker_error, retryable, no token", async (httpStatus) => {
    const { viewer, configMap } = setupContext(undefined, httpStatus);
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 test v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("t").toString("base64"),
    });
    expect(result.status).toBe("broker_error");
    expect(typeof result.retryable).toBe("boolean");
    expect(JSON.stringify(result)).not.toContain("fake-token");
  });

  it("tool: driveFileSave", async () => {
    const { viewer, brokerState, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await driveFileSave(ctx, viewer as any, {
      projectId: "p1", fileKind: "client", name: "2026-10-20 test v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("t").toString("base64"),
    });
    expect(result.status).toBe("saved");
  });

  it("tool: driveFileSave project_not_found", async () => {
    const { viewer, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await driveFileSave(ctx, viewer as any, {
      projectId: "nonexistent", fileKind: "client", name: "2026-10-20 test v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("t").toString("base64"),
    });
    expect(result.status).toBe("project_not_found");
  });
});
