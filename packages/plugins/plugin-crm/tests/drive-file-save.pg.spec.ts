/** saveDriveFile and driveFileSave tool handler on real Postgres, with the native Google Drive broker and Google faked in memory. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { vi, afterEach } from "vitest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { saveDriveFile } from "../src/drive/save.js";
import { driveFileSave, driveFolderEnsure } from "../src/drive/tools.js";
import { clearServiceAccountTokenCache } from "../src/drive/google-sa.js";
import { listDriveFiles, getDriveFile } from "../src/drive/store.js";
import { insertAccount } from "../src/db.js";
import { createAccount } from "../src/domain.js";
import { DRIVE_ID, KEY_JSON, fakeGoogle, folderPaths, isFolder, uploadsOf, type FakeGoogleOptions } from "./support/fake-google-drive.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const CO_A = "co-a", CO_B = "co-b";
const available = await embeddedAvailable();

describe.skipIf(!available)("saveDriveFile and driveFileSave", () => {
  let pg: PgHarness, ctx: PluginContext;
  let tempDir: string;
  let accountAId: string;

  beforeAll(async () => {
    pg = await startPg();
    tempDir = mkdtempSync(join(tmpdir(), "drive-file-save-"));
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    clearServiceAccountTokenCache();
    await pg.reset();
    ctx = pg.ctx;
    const accountA = createAccount({ companyId: CO_A, name: "Company A" });
    accountAId = accountA.id;
    await insertAccount(ctx, accountA);
    await insertAccount(ctx, createAccount({ companyId: CO_B, name: "Company B" }));
  });

  /** Google (in memory) is the only server: the broker under test is the real native one, reached through the global fetch. */
  function setupContext(googleOptions: FakeGoogleOptions = {}) {
    const google = fakeGoogle(googleOptions);
    vi.stubGlobal("fetch", google.fetchFn);
    let publicUrlFetchMock: ((url: string, init?: any) => any) | null = null;

    ctx.http = { fetch: async (url: string, init?: any) => publicUrlFetchMock ? publicUrlFetchMock(url, init) : ({} as any) } as any;
    const configMap = new Map<string, any>();
    ctx.config = { get: async (companyId: string) => configMap.get(companyId) ?? null, set: async (companyId: string, value: any) => configMap.set(companyId, value) } as any;
    ctx.projects = { get: async (projectId: string, companyId: string) => projectId.startsWith('p') ? { id: projectId, companyId, name: projectId } : null, list: async () => [] } as any;

    const viewer = { companyId: CO_A, userId: "user-1", runId: "run-1", agentId: "agent-1", role: "agent" as const };
    return { viewer, google, configMap, setPublicUrlFetchMock: (fn: (url: string, init?: any) => any) => { publicUrlFetchMock = fn; } };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function configureCompanyDrive(companyId: string, configMap: Map<string, any>, sharedDriveId = DRIVE_ID) {
    configMap.set(companyId, { driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId } });
  }

  /** The project's Drive folder and its numbered sub-folder by name, found by what Drive holds. */
  const subfolderOf = (google: ReturnType<typeof fakeGoogle>, project: string, name: string) => {
    const projectFolder = google.files.find((f) => isFolder(f) && f.appProperties?.pibEntityType === "project" && f.appProperties?.pibEntityId === project)!;
    return google.files.find((f) => isFolder(f) && f.name === name && f.parents[0] === projectFolder.id)!;
  };
  const projectFolderOf = (google: ReturnType<typeof fakeGoogle>, project: string) => google.files.find((f) => isFolder(f) && f.appProperties?.pibEntityType === "project" && f.appProperties?.pibEntityId === project)!;

  it("contentBase64 save -> status 'saved', url no sig, 1 upload into the project's folder", async () => {
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 test v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("content").toString("base64"),
    });
    expect(result.status).toBe("saved");
    expect(result.url).not.toMatch(/X-Amz|Signature|token/);
    const uploads = uploadsOf(google.files);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ name: "2026-10-20 test v1.txt", parents: [projectFolderOf(google, "p1").id] });
    expect(uploads[0].appProperties?.pibSha256).toBe(result.sha256);
  });

  it("path source save -> status 'saved', 1 upload", async () => {
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const filePath = join(tempDir, "test.txt");
    writeFileSync(filePath, "content");
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "product", name: "PAR-1-1729346000.txt", mimeType: "text/plain", path: filePath,
    }, { allowedRoots: [tempDir] });
    expect(result.status).toBe("saved");
    expect(uploadsOf(google.files)).toHaveLength(1);
  });

  it("duplicate -> status 'saved', duplicate:true, 1 upload total", async () => {
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const cb = Buffer.from("Same").toString("base64");
    const input = { companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 dup v1.txt", mimeType: "text/plain", contentBase64: cb };
    const r1 = await saveDriveFile(ctx, viewer, input);
    expect(r1.status).toBe("saved");
    const count1 = uploadsOf(google.files).length;
    const r2 = await saveDriveFile(ctx, viewer, input);
    expect(r2.duplicate).toBe(true);
    expect(r2.driveFileId).toBe(r1.driveFileId);
    expect(uploadsOf(google.files)).toHaveLength(count1);
  });

  it.each(["foo.png", "2026-13-45 x v1.png", "2026-02-31 x v1.png", "2026-10-20 x.png", "2026-10-20 x v1", "path/to/file.png", "file/../name.png", ".hidden.png", "file\ncontrol.png"])("invalid name '%s'", async (name) => {
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name, mimeType: "image/png", contentBase64: Buffer.from("t").toString("base64"),
    });
    expect(result.status).toBe("invalid_name");
    expect(uploadsOf(google.files)).toHaveLength(0);
    expect(google.calls).toHaveLength(0);
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
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 out v1.txt", mimeType: "text/plain", path: "/etc/hostname",
    }, { allowedRoots: [tempDir] });
    expect(result.status).toBe("path_not_allowed");
    expect(uploadsOf(google.files)).toHaveLength(0);
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

  it("unbound company (no Drive settings at all) -> drive_not_bound, Google never called", async () => {
    const { viewer, google } = setupContext();
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 test v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("t").toString("base64"),
    });
    expect(result.status).toBe("drive_not_bound");
    expect(uploadsOf(google.files)).toHaveLength(0);
    expect(google.calls).toHaveLength(0);
  });

  it("a service account key but no Shared Drive -> drive_not_bound, Google never called", async () => {
    const { viewer, google, configMap } = setupContext();
    configMap.set(CO_A, { driveServiceAccountJson: KEY_JSON });
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 test v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("t").toString("base64"),
    });
    expect(result.status).toBe("drive_not_bound");
    expect(google.calls).toHaveLength(0);
  });

  it.each([
    ["invalid_kind", "invalid_kind_xyz", Buffer.from("t").toString("base64"), undefined],
    ["invalid_input", "client", undefined, undefined],
    ["too_large", "client", Buffer.from("x".repeat(5 * 1024 * 1024 + 1)).toString("base64"), undefined],
    ["sha_mismatch", "client", Buffer.from("t").toString("base64"), "a".repeat(64)],
  ] as const)("error: %s", async (status, kind, cb64, sha) => {
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: kind, name: "2026-10-20 test v1.txt", mimeType: "text/plain", contentBase64: cb64, sha256: sha,
    });
    expect(result.status).toBe(status);
    expect(uploadsOf(google.files)).toHaveLength(0);
    // Refused before any Google call (the 5 MiB cap included)
    expect(google.calls).toHaveLength(0);
  });

  it.each([
    [500, true, undefined],
    [401, false, "bad_credential"],
    [403, false, "not_member"],
  ] as const)("Drive refuses the upload with %i -> broker_error, retryable=%s, nothing stored, no key material", async (httpStatus, retryable, code) => {
    const { viewer, configMap } = setupContext({ uploadStatus: httpStatus });
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 test v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("t").toString("base64"),
    });
    expect(result.status).toBe("broker_error");
    expect(result.retryable).toBe(retryable);
    expect(result.code).toBe(code);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE KEY|private_key|ya29/);
    expect(await listDriveFiles(ctx, CO_A, { projectId: "p1" })).toHaveLength(0);
  });

  it("tool: driveFileSave", async () => {
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await driveFileSave(ctx, viewer as any, {
      projectId: "p1", fileKind: "client", name: "2026-10-20 test v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("t").toString("base64"),
    });
    expect(result.status).toBe("saved");
    expect(uploadsOf(google.files)).toHaveLength(1);
  });

  it("tool: driveFileSave project_not_found", async () => {
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await driveFileSave(ctx, viewer as any, {
      projectId: "nonexistent", fileKind: "client", name: "2026-10-20 test v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("t").toString("base64"),
    });
    expect(result.status).toBe("project_not_found");
    expect(google.calls).toHaveLength(0);
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
    const { viewer, google, configMap, setPublicUrlFetchMock } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const content = Buffer.from("public bytes content");
    setPublicUrlFetchMock(() => new Response(content.buffer, { status: 200, headers: { "content-type": "text/plain" } }));
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 public v1.txt", mimeType: "text/plain", publicUrl: "https://example.com/file.txt",
    });
    expect(result.status).toBe("saved");
    expect(result.sha256).toBeTruthy();
    expect(result.url).not.toMatch(/X-Amz|Signature|token/);
    expect(uploadsOf(google.files)).toHaveLength(1);
  });

  it("publicUrl non-2xx response -> fetch_failed status", async () => {
    const { viewer, google, configMap, setPublicUrlFetchMock } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    setPublicUrlFetchMock(() => new Response(null, { status: 404 }));
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 fetch v1.txt", mimeType: "text/plain", publicUrl: "https://example.com/404",
    });
    expect(result.status).toBe("fetch_failed");
    expect(result.hint).not.toContain("example.com");
    expect(google.calls).toHaveLength(0);
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
    const { viewer, google, configMap, setPublicUrlFetchMock } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const largeData = new Uint8Array(5 * 1024 * 1024 + 1); // Over 5MB limit
    setPublicUrlFetchMock(() => new Response(largeData.buffer, { status: 200 }));
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 large v1.txt", mimeType: "text/plain", publicUrl: "https://example.com/large",
    });
    expect(result.status).toBe("fetch_failed");
    expect(JSON.stringify(result)).not.toContain("example.com");
    expect(google.calls).toHaveLength(0);
  });

  it("save with subfolder '03 Deliverables' -> uses that folder's id for upload and storage", async () => {
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 deliv v1.txt", mimeType: "text/plain",
      contentBase64: Buffer.from("deliv content").toString("base64"), subfolder: "03 Deliverables",
    });
    expect(result.status).toBe("saved");
    expect(result.subfolder).toBe("03 Deliverables");
    const uploads = uploadsOf(google.files);
    expect(uploads).toHaveLength(1);
    const deliverables = subfolderOf(google, "p1", "03 Deliverables");
    expect(uploads[0].parents).toEqual([deliverables.id]);
    // Verify the file was stored with subfolder
    const stored = await getDriveFile(ctx, CO_A, result.driveFileId!);
    expect(stored?.subfolder).toBe("03 Deliverables");
    expect(stored?.folderId).toBe(deliverables.id);
  });

  it("same name+sha256 in different subfolders -> creates separate rows", async () => {
    const { viewer, google, configMap } = setupContext();
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
    const uploads = uploadsOf(google.files);
    expect(uploads).toHaveLength(2); // Two uploads, one per folder
    expect(new Set(uploads.map((f) => f.parents[0])).size).toBe(2);
  });

  it("same name+sha256 in same subfolder twice -> returns duplicate", async () => {
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const input = { companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 dup-sub v1.txt", mimeType: "text/plain", contentBase64: Buffer.from("dup").toString("base64"), subfolder: "02 Assets" };

    const r1 = await saveDriveFile(ctx, viewer, input);
    expect(r1.status).toBe("saved");
    expect(r1.duplicate).toBe(false);

    const r2 = await saveDriveFile(ctx, viewer, input);
    expect(r2.status).toBe("saved");
    expect(r2.duplicate).toBe(true);
    expect(r2.driveFileId).toBe(r1.driveFileId);
    expect(uploadsOf(google.files)).toHaveLength(1); // Only one upload
  });

  it("unknown subfolder 'Nope' -> invalid_subfolder early (no driveFolderEnsure, no Google call, no upload)", async () => {
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const toolsModule = await import("../src/drive/tools.js");
    const ensureSpy = vi.spyOn(toolsModule, "driveFolderEnsure");
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 bad-sub v1.txt", mimeType: "text/plain",
      contentBase64: Buffer.from("content").toString("base64"), subfolder: "Nope",
    });
    expect(result.status).toBe("invalid_subfolder");
    expect(result.hint).toContain("must be one of");
    expect(uploadsOf(google.files)).toHaveLength(0);
    expect(google.calls).toHaveLength(0);
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("no subfolder -> saves to project root with subfolder=null", async () => {
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await saveDriveFile(ctx, viewer as any, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 root v1.txt", mimeType: "text/plain",
      contentBase64: Buffer.from("root content").toString("base64"),
    });
    expect(result.status).toBe("saved");
    expect(result.subfolder).toBe(null);
    const uploads = uploadsOf(google.files);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].parents).toEqual([projectFolderOf(google, "p1").id]);
    const stored = await getDriveFile(ctx, CO_A, result.driveFileId!);
    expect(stored?.subfolder).toBe(null);
  });

  it("tool: drive_file_save with subfolder parameter", async () => {
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const result = await driveFileSave(ctx, viewer as any, {
      projectId: "p1", fileKind: "client", name: "2026-10-20 tool-sub v1.txt", mimeType: "text/plain",
      contentBase64: Buffer.from("tool content").toString("base64"), subfolder: "04 Reports",
    });
    expect(result.status).toBe("saved");
    expect(result.subfolder).toBe("04 Reports");
    const uploads = uploadsOf(google.files);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].parents).toEqual([subfolderOf(google, "p1", "04 Reports").id]);
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
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);

    // First call without subfolder (simulates previous ensure)
    const r1 = await saveDriveFile(ctx, viewer, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 first v1.txt",
      mimeType: "text/plain", contentBase64: Buffer.from("first").toString("base64"),
    });
    expect(r1.status).toBe("saved");
    expect(uploadsOf(google.files)).toHaveLength(1);
    const foldersAfterFirst = google.files.filter(isFolder).length;

    // Second call with subfolder on already-ensured project
    const r2 = await saveDriveFile(ctx, viewer, {
      companyId: CO_A, projectId: "p1", fileKind: "client", name: "2026-10-20 second v1.txt",
      mimeType: "text/plain", contentBase64: Buffer.from("second").toString("base64"), subfolder: "02 Assets",
    });
    expect(r2.status).toBe("saved");
    expect(r2.subfolder).toBe("02 Assets");
    const uploads = uploadsOf(google.files);
    expect(uploads).toHaveLength(2); // One more upload
    // It went into the existing "02 Assets" folder: no new folder was made for it
    expect(uploads[1].parents).toEqual([subfolderOf(google, "p1", "02 Assets").id]);
    expect(google.files.filter(isFolder)).toHaveLength(foldersAfterFirst);
  });

  it("a company folder ensure (no sub-folders at the end of the plan) falls back to the accumulated tree", async () => {
    // The company step is the leaf of its plan and carries no sub-folders, so the broker's own tree for it is empty.
    const { viewer, google, configMap } = setupContext();
    await configureCompanyDrive(CO_A, configMap);
    const res = await driveFolderEnsure(ctx, viewer, { entity_type: "crm_company", entity_id: accountAId, include_tree: true });

    expect((res as any).status).toBe("created");
    // Should use accumulated tree since the broker returned an empty one
    expect((res as any).tree).toBeDefined();
    expect((res as any).tree.length).toBeGreaterThan(0); // Has accumulated entries
    expect((res as any).tree).toEqual([{ path: "Company A", folderId: google.files[0].id, created: true }]);
    expect(folderPaths(google.files)).toEqual(["Company A"]);
  });
});
