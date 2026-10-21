/** saveDriveFile and driveFileSave tool handler on real Postgres. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { vi, afterEach } from "vitest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { saveDriveFile, type SaveDriveFileInput } from "../src/drive/save.js";
import { driveFileSave, driveFolderEnsure } from "../src/drive/tools.js";
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
    let publicUrlFetchMock: ((url: string, init?: any) => any) | null = null;

    const brokerFactory = (fetchFn: any, cfg: any) => {
      const broker: Broker = {
        resolve: async () => null,
        ensure: async (body) => {
          const cacheKey = `${body.entity_type}:${body.entity_id}`;
          let cached = folderCache.get(cacheKey);
          let wasCreated = !cached;
          if (!cached) {
            cached = { id: `folder_${Math.random().toString(36).slice(2, 11)}`, path: `02 Partners in Biz/Projects/${body.entity_id}` };
            folderCache.set(cacheKey, cached);
          }
          const tree: Array<{ path: string; folderId: string; created: boolean }> = [{ path: cached.path, folderId: cached.id, created: wasCreated }];
          // Add subfolders to tree if provided in the body
          if (body.subfolders && Array.isArray(body.subfolders)) {
            for (const subfolder of body.subfolders) {
              const subfolderCacheKey = `${body.entity_type}:${body.entity_id}:${subfolder}`;
              const subfolderPath = `${cached.path}/${subfolder}`;
              const subfolderFolderId = `${cached.id}_${subfolder.replace(/\s+/g, '_')}`;
              tree.push({ path: subfolderPath, folderId: subfolderFolderId, created: wasCreated });
            }
          }
          return {
            folder: { id: cached.id, entity_type: body.entity_type, entity_id: body.entity_id, path: cached.path, folder_id: cached.id, folder_url: `https://drive.google.com/drive/folders/${cached.id}` },
            created: wasCreated,
            tree,
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
        identity: async (sharedDriveId?: string) => ({
          serviceAccountEmail: "test-sa@project.iam.gserviceaccount.com",
          isMember: true,
        }),
      };
      return broker;
    };

    vi.spyOn(brokerModule, 'createBroker' as any).mockImplementation(brokerFactory);
    ctx.http = { fetch: async (url: string, init?: any) => publicUrlFetchMock ? publicUrlFetchMock(url, init) : ({} as any) } as any;
    const configMap = new Map<string, any>();
    ctx.config = { get: async (companyId: string) => configMap.get(companyId) ?? null, set: async (companyId: string, value: any) => configMap.set(companyId, value) } as any;
    ctx.projects = { get: async (projectId: string, companyId: string) => projectId.startsWith('p') ? { id: projectId, companyId, name: projectId } : null, list: async () => [] } as any;

    const viewer = { companyId: CO_A, userId: "user-1", runId: "run-1", agentId: "agent-1", role: "agent" as const };
    return { viewer, brokerState: brokerState_, configMap, setPublicUrlFetchMock: (fn: (url: string, init?: any) => any) => { publicUrlFetchMock = fn; } };
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

  it("path load error sanitizes message/path in hint", async () => {
    const { viewer, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const dirPath = tempDir;
    const result = await saveDriveFile(ctx, viewer, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 test v1.txt", mimeType: "text/plain", path: dirPath,
    }, { allowedRoots: [tempDir] });
    // Directory instead of file should trigger path_not_allowed or invalid_input
    expect(["path_not_allowed", "invalid_input"]).toContain(result.status);
    // Verify hint contains no directory path or system error text
    expect(result.hint).not.toContain(tempDir);
    expect(result.hint).not.toContain("EISDIR");
    // Verify the full serialized result contains no sensitive data
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(tempDir);
  });

  it("publicUrl save -> status 'saved', url stripped of sig params, 1 upload", async () => {
    const { viewer, brokerState, configMap, setPublicUrlFetchMock } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const content = Buffer.from("public bytes content");
    setPublicUrlFetchMock(() => new Response(content.buffer, { status: 200, headers: { "content-type": "text/plain" } }));
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 public v1.txt", mimeType: "text/plain", publicUrl: "https://example.com/file.txt",
    });
    expect(result.status).toBe("saved");
    expect(result.sha256).toBeTruthy();
    expect(result.url).not.toMatch(/X-Amz|Signature|token/);
    expect(brokerState.requests).toHaveLength(1);
  });

  it("publicUrl non-2xx response -> fetch_failed status", async () => {
    const { viewer, configMap, setPublicUrlFetchMock } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    setPublicUrlFetchMock(() => new Response(null, { status: 404 }));
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 fetch v1.txt", mimeType: "text/plain", publicUrl: "https://example.com/404",
    });
    expect(result.status).toBe("fetch_failed");
    expect(result.hint).not.toContain("example.com");
  });

  it("publicUrl private IP direct -> fetch_failed via SSRF guard", async () => {
    const { viewer, configMap, setPublicUrlFetchMock } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const calls: Array<{ url: string; init?: any }> = [];
    setPublicUrlFetchMock((url: string, init?: any) => {
      calls.push({ url, init });
      // Model SSRF host-blocking by rejecting private/loopback addresses
      if (url.includes("127.0.0.1") || url.includes("169.254.169.254") || url.includes("10.0.0.1")) {
        throw new Error("SSRF protection: blocked private address");
      }
      return new Response(Buffer.from("public"), { status: 200, headers: { "content-type": "text/plain" } });
    });
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 blocked v1.txt", mimeType: "text/plain", publicUrl: "http://127.0.0.1/file",
    });
    expect(result.status).toBe("fetch_failed");
    expect(result.hint).not.toContain("127.0.0.1");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("publicUrl redirect to private IP -> fetch_failed via SSRF re-check", async () => {
    const { viewer, configMap, setPublicUrlFetchMock } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const calls: Array<{ url: string; init?: any }> = [];
    setPublicUrlFetchMock((url: string, init?: any) => {
      calls.push({ url, init });
      // Model SSRF host-blocking by rejecting private/loopback addresses
      if (url.includes("169.254.169.254")) {
        throw new Error("SSRF protection: blocked private address");
      }
      // First request redirects from public to private
      if (url === "https://example.com/redirect") {
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/secret" } });
      }
      return new Response(Buffer.from("public"), { status: 200, headers: { "content-type": "text/plain" } });
    });
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 redir v1.txt", mimeType: "text/plain", publicUrl: "https://example.com/redirect",
    });
    expect(result.status).toBe("fetch_failed");
    expect(result.hint).not.toContain("169.254.169.254");
    expect(calls.length).toBeGreaterThan(1); // Verify redirect was followed and re-checked
    expect(calls.some(c => c.init?.redirect === "manual")).toBe(true);
  });

  it("publicUrl over-cap body -> fetch_failed", async () => {
    const { viewer, configMap, setPublicUrlFetchMock } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const largeData = new Uint8Array(5 * 1024 * 1024 + 1); // Over 5MB limit
    setPublicUrlFetchMock(() => new Response(largeData.buffer, { status: 200 }));
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 large v1.txt", mimeType: "text/plain", publicUrl: "https://example.com/large",
    });
    expect(result.status).toBe("fetch_failed");
    expect(JSON.stringify(result)).not.toContain("example.com");
  });

  it("save with subfolder '03 Deliverables' -> uses that folder's id for upload and storage", async () => {
    const { viewer, brokerState, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 deliv v1.txt", mimeType: "text/plain",
      contentBase64: Buffer.from("deliv content").toString("base64"), subfolder: "03 Deliverables",
    });
    expect(result.status).toBe("saved");
    expect(result.subfolder).toBe("03 Deliverables");
    expect(brokerState.requests).toHaveLength(1);
    // Verify the file was stored with subfolder
    const stored = await getDriveFile(ctx, CO_A, result.driveFileId!);
    expect(stored?.subfolder).toBe("03 Deliverables");
  });

  it("same name+sha256 in different subfolders -> creates separate rows", async () => {
    const { viewer, brokerState, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const input = { companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 shared v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("shared").toString("base64") };

    // Save to root
    const r1 = await saveDriveFile(ctx, viewer, { ...input, subfolder: undefined });
    expect(r1.status).toBe("saved");
    expect(r1.subfolder).toBe(null);

    // Save same file to "03 Deliverables"
    const r2 = await saveDriveFile(ctx, viewer, { ...input, subfolder: "03 Deliverables" });
    expect(r2.status).toBe("saved");
    expect(r2.subfolder).toBe("03 Deliverables");
    expect(r2.driveFileId).not.toBe(r1.driveFileId); // Different files
    expect(brokerState.requests).toHaveLength(2); // Two uploads
  });

  it("same name+sha256 in same subfolder twice -> returns duplicate", async () => {
    const { viewer, brokerState, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const input = { companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 dup-sub v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("dup").toString("base64"), subfolder: "02 Assets" };

    const r1 = await saveDriveFile(ctx, viewer, input);
    expect(r1.status).toBe("saved");
    expect(r1.duplicate).toBe(false);

    const r2 = await saveDriveFile(ctx, viewer, input);
    expect(r2.status).toBe("saved");
    expect(r2.duplicate).toBe(true);
    expect(r2.driveFileId).toBe(r1.driveFileId);
    expect(brokerState.requests).toHaveLength(1); // Only one upload
  });

  it("unknown subfolder 'Nope' -> invalid_subfolder early (no driveFolderEnsure, no upload)", async () => {
    const { viewer, brokerState, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const toolsModule = await import("../src/drive/tools.js");
    const ensureSpy = vi.spyOn(toolsModule, "driveFolderEnsure");
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 bad-sub v1.txt", mimeType: "text/plain",
      contentBase64: Buffer.from("content").toString("base64"), subfolder: "Nope",
    });
    expect(result.status).toBe("invalid_subfolder");
    expect(result.hint).toContain("must be one of");
    expect(brokerState.requests).toHaveLength(0);
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("no subfolder -> saves to project root with subfolder=null", async () => {
    const { viewer, brokerState, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 root v1.txt", mimeType: "text/plain",
      contentBase64: Buffer.from("root content").toString("base64"),
    });
    expect(result.status).toBe("saved");
    expect(result.subfolder).toBe(null);
    expect(brokerState.requests).toHaveLength(1);
    const stored = await getDriveFile(ctx, CO_A, result.driveFileId!);
    expect(stored?.subfolder).toBe(null);
  });

  it("tool: drive_file_save with subfolder parameter", async () => {
    const { viewer, brokerState, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await driveFileSave(ctx, viewer as any, {
      projectId: "p1", fileKind: "client", name: "2026-10-20 tool-sub v1.txt", mimeType: "text/plain",
      contentBase64: Buffer.from("tool content").toString("base64"), subfolder: "04 Reports",
    });
    expect(result.status).toBe("saved");
    expect(result.subfolder).toBe("04 Reports");
    expect(brokerState.requests).toHaveLength(1);
  });

  it("listDriveFiles with subfolder filter", async () => {
    const { viewer, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);

    // Save files to different subfolders
    await saveDriveFile(ctx, viewer, { companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 f1 v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("f1").toString("base64"), subfolder: "01 Briefs" });
    await saveDriveFile(ctx, viewer, { companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 f2 v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("f2").toString("base64"), subfolder: "03 Deliverables" });
    await saveDriveFile(ctx, viewer, { companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 f3 v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("f3").toString("base64") });

    // List all files for project
    const allFiles = await listDriveFiles(ctx, CO_A, { projectId: "p1" });
    expect(allFiles.length).toBe(3);

    // Filter by subfolder
    const briefsFiles = await listDriveFiles(ctx, CO_A, { projectId: "p1", subfolder: "01 Briefs" });
    expect(briefsFiles).toHaveLength(1);
    expect(briefsFiles[0].subfolder).toBe("01 Briefs");

    // Filter by root (null subfolder)
    const rootFiles = await listDriveFiles(ctx, CO_A, { projectId: "p1", subfolder: null });
    expect(rootFiles).toHaveLength(1);
    expect(rootFiles[0].subfolder).toBe(null);
  });

  it("subfolder on already-ensured project -> resolves from tree returned with include_tree", async () => {
    const { viewer, brokerState, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);

    // First call without subfolder (simulates previous ensure)
    const r1 = await saveDriveFile(ctx, viewer, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 first v1.txt",
      mimeType: "text/plain", contentBase64: Buffer.from("first").toString("base64"),
    });
    expect(r1.status).toBe("saved");
    expect(brokerState.requests).toHaveLength(1);

    // Second call with subfolder on already-ensured project
    const r2 = await saveDriveFile(ctx, viewer, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 second v1.txt",
      mimeType: "text/plain", contentBase64: Buffer.from("second").toString("base64"), subfolder: "02 Assets",
    });
    expect(r2.status).toBe("saved");
    expect(r2.subfolder).toBe("02 Assets");
    expect(brokerState.requests).toHaveLength(2); // One more upload
  });

  it("broker returning empty tree falls back to accumulated tree", async () => {
    // Create context with broker that returns empty tree on last step
    const { viewer, configMap } = setupContext();
    const folderCache = new Map<string, { id: string; path: string }>();

    const brokerFactory = (fetchFn: any, cfg: any) => {
      const broker: any = {
        resolve: async () => null,
        ensure: async (body: any) => {
          const cacheKey = `${body.entity_type}:${body.entity_id}`;
          let cached = folderCache.get(cacheKey);
          if (!cached) {
            cached = { id: `folder_${Math.random().toString(36).slice(2, 11)}`, path: `Projects/${body.entity_id}` };
            folderCache.set(cacheKey, cached);
          }
          return {
            folder: { id: cached.id, entity_type: body.entity_type, entity_id: body.entity_id, path: cached.path, folder_id: cached.id, folder_url: `https://drive.google.com/drive/folders/${cached.id}` },
            created: true,
            tree: [], // Broker returns empty tree
          };
        },
        uploadFile: async (input: any) => ({ fileId: `file_${Date.now()}`, name: input.name, mimeType: input.mimeType, size: 0, sha256: "hash", webViewLink: "url", deduplicated: false }),
      };
      return broker;
    };

    vi.spyOn(await import("../src/drive/broker.js"), "createBroker" as any).mockImplementation(brokerFactory);
    await configureCompanyDrive(CO_A, configMap);
    const res = await driveFolderEnsure(ctx, viewer, { entity_type: "project", entity_id: "p3", include_tree: true });

    // Should use accumulated tree since broker returned empty
    expect((res as any).tree).toBeDefined();
    expect((res as any).tree.length).toBeGreaterThan(0); // Has accumulated entries
  });
});
