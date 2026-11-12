import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, assets, companies, createDb, heartbeatRuns, runnerApiResponseReservations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createRunResponseCapture } from "./run-response-capture.js";
import { acquireRunnerApiResponseSlot, RUNNER_API_RESPONSE_MAX_BYTES } from "./native-runtime/runner-api-response-limits.js";
import type { StorageService } from "../storage/types.js";

describe.skipIf(process.platform !== "linux")("run response capture", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("run-response-capture-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Capture", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Capture", role: "ceo", status: "active", adapterType: "paperclip_runner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "assignment", triggerDetail: "system", contextSnapshot: {} });
    const putFile = vi.fn<StorageService["putFile"]>(async input => {
      const body = input.body as Buffer;
      return { provider: "local_disk", objectKey: `${companyId}/${input.namespace}/${randomUUID()}`, contentType: input.contentType ?? "application/octet-stream",
        byteSize: body.length, sha256: createHash("sha256").update(body).digest("hex"), originalFilename: input.originalFilename ?? null };
    });
    const storage = { putFile, deleteObject: vi.fn(async () => undefined) } as unknown as StorageService;
    const authorize = async (tx: typeof db) => {
      const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
      return { run };
    };
    const capture = (overrides: Partial<Parameters<typeof createRunResponseCapture>[0]> = {}) => createRunResponseCapture({
      db, storage, companyId, agentId, runId, issueId: null, source: "tool_gateway", authorize, ...overrides,
    });
    const reservations = () => db.select().from(runnerApiResponseReservations).where(eq(runnerApiResponseReservations.companyId, companyId));
    const runBytes = async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      return (run.resultJson as Record<string, unknown> | null)?.apiResponseCaptureBytes;
    };
    return { companyId, putFile, capture, reservations, runBytes };
  }

  /** Two slots per company: both must be free after the call under test. */
  function expectSlotsFree(companyId: string) {
    const releases = [acquireRunnerApiResponseSlot(companyId), acquireRunnerApiResponseSlot(companyId)];
    releases.forEach(release => release());
  }

  it("books nothing and releases the process slot when authorize throws", async () => {
    const f = await fixture();
    const capture = f.capture({ authorize: async () => { throw new Error("not authorized"); } });
    await expect(capture.captureOnce(Buffer.from("{}"), "application/json")).rejects.toThrow("not authorized");
    await expect(capture.reserveResponseCapture()).rejects.toThrow("not authorized");
    expect(await f.reservations()).toEqual([]);
    expect(await f.runBytes()).toBeUndefined();
    expect(f.putFile).not.toHaveBeenCalled();
    expectSlotsFree(f.companyId);
  });

  it("settles a successful capture to the real byte size", async () => {
    const f = await fixture();
    const bytes = Buffer.from(JSON.stringify({ result: "x".repeat(1000) }));
    const artifact = await f.capture().captureOnce(bytes, "application/json");
    expect(artifact).toMatchObject({ contentType: "application/json", byteSize: bytes.length, url: `/api/assets/${artifact.artifactId}/content` });
    expect(await f.runBytes()).toBe(bytes.length);
    expect(await f.reservations()).toEqual([expect.objectContaining({ assetId: artifact.artifactId, reservedBytes: bytes.length })]);
    const [asset] = await db.select().from(assets).where(eq(assets.id, artifact.artifactId));
    expect(asset.byteSize).toBe(bytes.length);
    expectSlotsFree(f.companyId);
  });

  it("removes the reservation when the capture fails before storage", async () => {
    const f = await fixture();
    f.putFile.mockRejectedValueOnce(new Error("disk full"));
    // putFile throws before the object exists, but the store was attempted:
    // that is ambiguous, so the reservation stays (as in the runner).
    await expect(f.capture().captureOnce(Buffer.from("{}"), "application/json")).rejects.toThrow("disk full");
    expect(await f.reservations()).toHaveLength(1);
    // A failure before any storage call frees the reservation.
    const capture = f.capture();
    const settle = await capture.reserveResponseCapture();
    expect(await f.reservations()).toHaveLength(2);
    await settle(undefined, true);
    expect(await f.reservations()).toHaveLength(1);
    expectSlotsFree(f.companyId);
  });

  it("books a reserveBytes below 1 GiB in the run budget and the company sum", async () => {
    const f = await fixture();
    const reserveBytes = 64 * 1024 * 1024;
    expect(reserveBytes).toBeLessThan(RUNNER_API_RESPONSE_MAX_BYTES);
    vi.stubEnv("PAPERCLIP_RUNNER_API_COMPANY_CAPTURE_MAX_BYTES", String(RUNNER_API_RESPONSE_MAX_BYTES));
    try {
      const capture = f.capture();
      const settle = await capture.reserveResponseCapture(reserveBytes);
      expect(await f.runBytes()).toBe(reserveBytes);
      expect(await f.reservations()).toEqual([expect.objectContaining({ assetId: null, reservedBytes: reserveBytes })]);
      // The pending reservation counts toward the company sum: a full 1 GiB no longer fits.
      await expect(f.capture().reserveResponseCapture()).rejects.toMatchObject({ code: "api_response_company_storage_limit" });
      const second = await f.capture().reserveResponseCapture(reserveBytes);
      expect(await f.runBytes()).toBe(2 * reserveBytes);
      await second(undefined, true);
      await settle(100, true);
      expect(await f.runBytes()).toBe(reserveBytes + 100);
    } finally { vi.unstubAllEnvs(); }
    expectSlotsFree(f.companyId);
  });
});
