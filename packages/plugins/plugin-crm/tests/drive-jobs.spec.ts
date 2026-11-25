/**
 * PAR-9261 (PAR-9219 C.1-C.8): the in-memory Drive job registry, the shared transfer slots and drive_transfer_status.
 * Generated data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tools = vi.hoisted(() => ({
  resolveProducerSaveProject: vi.fn(async () => "pA"),
  driveFolderEnsure: vi.fn(async () => ({ status: "exists", folder_id: "rootA", path: "Clients/A", tree: [{ path: "Clients/A/Assets/Video", folderId: "fA" }] })),
  createBrokerForCompany: vi.fn(async () => null as unknown),
}));
vi.mock("../src/drive/tools.js", () => tools);
vi.mock("../src/drive/store.js", () => ({
  findDriveFile: vi.fn(async () => null),
  upsertDriveFile: vi.fn(async (_ctx: unknown, f: { name: string; sha256: string }) => ({ file: { id: "row1", name: f.name, sha256: f.sha256, webUrl: "https://drive.google.com/x", subfolder: null } })),
}));

import { BrokerError } from "../src/drive/broker.js";
import { startDriveJob, driveJobStatus, resetDriveJobsForTests, saveJobKey, fetchJobKey, DriveJobFailure, TEXTS, type StartDriveJob } from "../src/drive/jobs.js";
import { transfersInFlight, resetTransferSlotsForTests, BUSY_TEXT } from "../src/drive/transfer-slots.js";
import { saveDriveFile } from "../src/drive/save.js";
import { copyAssetFileToR2, clearAssetFolderCache } from "../src/drive/read.js";

const A = { companyId: "co-a", agentId: "agent-1", runId: "run-1" };
const R2 = "https://acct123.r2.cloudflarestorage.com/studio/a.mp4?X-Amz-Signature=deadbeefsecret";
const SHA = "a".repeat(64);
const flush = () => new Promise<void>((r) => setImmediate(r));
const deferred = <T = unknown>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const logger = { warn: vi.fn() };
const job = (key: string, work: StartDriveJob["work"], extra: Partial<StartDriveJob> = {}) =>
  startDriveJob(A, { kind: "save", key, bytesTotal: 100, work, logger, ...extra });

beforeEach(() => {
  resetDriveJobsForTests();
  resetTransferSlotsForTests();
  clearAssetFolderCache();
  logger.warn.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("Drive job registry", () => {
  it("returns at once; running, then done with the result; the slot is released", async () => {
    const d = deferred();
    const start = job(saveJobKey("co-a", "p1", "Assets/Video", "x.mp4"), async (progress) => {
      progress(40);
      return d.promise;
    });
    expect(start).toMatchObject({ status: "started", bytesTotal: 100 });
    const id = (start as { jobId: string }).jobId;
    expect(driveJobStatus(A, id)).toMatchObject({ status: "running", bytesDone: 40, bytesTotal: 100 });
    expect(transfersInFlight()).toBe(1);
    d.resolve({ status: "saved", driveFileId: "f1" });
    await flush();
    expect(driveJobStatus(A, id)).toMatchObject({ status: "done", bytesDone: 100, result: { status: "saved", driveFileId: "f1" } });
    expect(transfersInFlight()).toBe(0);
  });

  it("a same-key start while running returns the same jobId with alreadyRunning; a fetch key includes the run", async () => {
    const d = deferred();
    const key = saveJobKey("co-a", "p1", null, "x.mp4");
    const first = job(key, () => d.promise) as { jobId: string };
    const cleanup = vi.fn();
    expect(job(key, () => d.promise, { cleanup })).toEqual({ status: "started", jobId: first.jobId, bytesTotal: 100, alreadyRunning: true });
    await flush();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(transfersInFlight()).toBe(1);
    expect(fetchJobKey("co-a", "run-1", "g1")).not.toBe(fetchJobKey("co-a", "run-2", "g1"));
    expect(saveJobKey("co-a", "p1", "Deliverables", "x.mp4")).not.toBe(key);
    d.resolve("ok");
    await flush();
  });

  it("a chunk that takes 170 s keeps the job running and a retry gets the same id (no time-based stale state)", async () => {
    vi.useFakeTimers();
    const key = saveJobKey("co-a", "p1", null, "slow.mp4");
    const start = job(key, () => new Promise((r) => setTimeout(() => r("ok"), 170_000))) as { jobId: string };
    await vi.advanceTimersByTimeAsync(169_000);
    expect(driveJobStatus(A, start.jobId).status).toBe("running");
    expect(job(key, async () => "x")).toMatchObject({ jobId: start.jobId, alreadyRunning: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(driveJobStatus(A, start.jobId)).toMatchObject({ status: "done", result: "ok" });
  });

  it("releases the slot after failed and thrown work, and runs cleanup each time", async () => {
    const cleanup = vi.fn();
    const failed = job("k1", async () => { throw new DriveJobFailure("file_changed", TEXTS.fileChanged); }, { cleanup }) as { jobId: string };
    const thrown = job("k2", () => { throw new Error("boom"); }, { cleanup }) as { jobId: string };
    await flush();
    expect(driveJobStatus(A, failed.jobId)).toMatchObject({ status: "failed", code: "file_changed", hint: TEXTS.fileChanged });
    expect(driveJobStatus(A, thrown.jobId)).toMatchObject({ status: "failed", code: "transfer_failed", hint: TEXTS.failed });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(transfersInFlight()).toBe(0);
  });

  it("maps each broker code to its own text and never shows Google's message", async () => {
    const google = "Bearer ya29.secret upload_id=XYZ X-Amz-Signature=1 Google said no";
    const cases: Array<[BrokerError, string, string]> = [
      [new BrokerError(google, 413, false, undefined, undefined, "too_large"), "too_large", TEXTS.tooLarge],
      [new BrokerError(google, 400, false, undefined, undefined, "size_mismatch"), "file_changed", TEXTS.fileChanged],
      [new BrokerError(google, 400, false, undefined, undefined, "bad_credential"), "bad_credential", TEXTS.badCredential],
      [new BrokerError(google, 404, false), "not_found", TEXTS.notFound],
      [new BrokerError(google, 500, true), "transfer_failed", TEXTS.failed],
    ];
    const ids: string[] = [];
    for (const [i, [e]] of cases.entries()) {
      ids.push((job(`b${i}`, async () => { throw e; }) as { jobId: string }).jobId);
      await flush();
    }
    const fetchId = (startDriveJob(A, { kind: "fetch", key: "f", bytesTotal: 1, work: async () => { throw cases[1]![0]; } }) as { jobId: string }).jobId;
    await flush();
    cases.forEach(([, code, hint], i) => expect(driveJobStatus(A, ids[i]!)).toMatchObject({ code, hint }));
    expect(driveJobStatus(A, fetchId)).toMatchObject({ code: "sha_mismatch", hint: TEXTS.sizeMismatch });
    const shown = JSON.stringify([ids.map((id) => driveJobStatus(A, id)), logger.warn.mock.calls]);
    expect(shown).not.toMatch(/upload_id=|X-Amz-|Bearer|Google said/);
  });
});

describe("drive_transfer_status scope", () => {
  it("another agent's or company's job is not_found; an unknown id gets the restart text; a fetch from another run is expired", async () => {
    const save = job("s", async () => "ok") as { jobId: string };
    const fetch = startDriveJob(A, { kind: "fetch", key: fetchJobKey("co-a", "run-1", "g1"), bytesTotal: 1, work: async () => "ok" }) as { jobId: string };
    await flush();
    expect(driveJobStatus({ ...A, agentId: "agent-2" }, save.jobId)).toEqual({ status: "not_found", hint: TEXTS.restart });
    expect(driveJobStatus({ ...A, companyId: "co-b" }, save.jobId)).toEqual({ status: "not_found", hint: TEXTS.restart });
    expect(driveJobStatus(A, "nope")).toEqual({ status: "not_found", hint: TEXTS.restart });
    expect(driveJobStatus({ ...A, runId: "run-2" }, fetch.jobId)).toEqual({ status: "expired", hint: TEXTS.expired });
    expect(driveJobStatus({ ...A, runId: "run-2" }, save.jobId)).toMatchObject({ status: "done" });
    expect(driveJobStatus(A, fetch.jobId)).toMatchObject({ status: "done" });
  });
});

describe("shared transfer slots across producer routes and agent jobs", () => {
  function hangingBroker(gate: Promise<unknown>) {
    return {
      uploadFileStream: vi.fn(async () => { await gate; return { fileId: "g1", webUrl: "https://drive.google.com/g1", name: "x" }; }),
      listFiles: vi.fn(async () => []),
      downloadFile: vi.fn(async () => new Uint8Array(1)),
      fileMeta: vi.fn(async () => ({ id: "fileAAAAAAAAAAAA", name: "c.mp4", mimeType: "video/mp4", size: 10, parents: ["fA"] })),
      downloadStream: vi.fn(async () => { await gate; throw new BrokerError("Google said no", 500, true); }),
    };
  }
  const ctx = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as never;

  it("an r2Url save and a copyAssetFileToR2 are counted, never refused; a third agent job gets busy; all slots come back", async () => {
    const gate = deferred();
    const b = hangingBroker(gate.promise);
    tools.createBrokerForCompany.mockResolvedValue(b);
    const viewer = { companyId: "co-a", userId: null, agentId: null, role: null };
    const save = saveDriveFile(ctx, viewer, { companyId: "co-a", projectId: "p1", fileKind: "client", name: "2026-11-11 clip v1.mp4", mimeType: "video/mp4", r2Url: R2, size: 10, sha256: SHA } as never);
    const copy = copyAssetFileToR2(ctx, "co-a", { clientKind: "company", clientRef: "co-a" } as never, "fileAAAAAAAAAAAA", R2, () => undefined, async () => b as never);
    await vi.waitFor(() => expect(transfersInFlight()).toBe(2));
    // A producer route is still let through at two (counted, not refused).
    const third = copyAssetFileToR2(ctx, "co-a", { clientKind: "company", clientRef: "co-a" } as never, "fileAAAAAAAAAAAA", R2, () => undefined, async () => b as never);
    await vi.waitFor(() => expect(transfersInFlight()).toBe(3));
    const cleanup = vi.fn();
    expect(job("agent", async () => "x", { cleanup })).toEqual({ status: "busy", hint: BUSY_TEXT });
    await flush();
    expect(cleanup).toHaveBeenCalledOnce();
    gate.resolve(undefined);
    expect(await save).toMatchObject({ status: "saved" });
    await expect(copy).rejects.toBeInstanceOf(BrokerError);
    await expect(third).rejects.toBeInstanceOf(BrokerError);
    expect(transfersInFlight()).toBe(0);
    expect(job("agent", async () => "x")).toMatchObject({ status: "started" });
    expect(JSON.stringify(ctx)).not.toMatch(/X-Amz-|deadbeefsecret/);
  });

  it("two agent jobs fill the slots; a third is busy", async () => {
    const d = deferred();
    job("j1", () => d.promise);
    job("j2", () => d.promise);
    expect(job("j3", () => d.promise)).toEqual({ status: "busy", hint: BUSY_TEXT });
    d.resolve("ok");
    await flush();
    expect(transfersInFlight()).toBe(0);
  });
});
