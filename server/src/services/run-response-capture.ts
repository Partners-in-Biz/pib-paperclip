import { createReadStream } from "node:fs";
import { and, eq, isNull, sql } from "drizzle-orm";
import { assets, heartbeatRuns, runnerApiResponseReservations, type Db } from "@paperclipai/db";
import { getStorageService } from "../storage/index.js";
import type { StorageService } from "../storage/types.js";
import { assetService } from "./assets.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import type { RunnerApiResponseBody } from "./native-runtime/runner-api-response.js";
import { acquireRunnerApiResponseSlot, runnerApiCompanyCaptureMaxBytes, RUNNER_API_RESPONSE_MAX_BYTES, RUNNER_API_RESPONSE_RUN_MAX_BYTES, RunnerApiResponseLimitError } from "./native-runtime/runner-api-response-limits.js";

export type RunResponseCaptureSource = "runner.call_api" | "runner.assigned_tool" | "tool_gateway";

export type RunResponseCaptureArtifact = { artifactId: string; url: string; contentType: string; byteSize: number; sha256: string };

/** Settles a reservation: real size on success, reclaim on a cleaned pre-storage failure. */
export type RunResponseCaptureSettle = (completedBytes?: number, cleaned?: boolean) => Promise<void>;

export interface RunResponseCaptureOptions {
  db: Db;
  storage?: StorageService;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  caseId?: string;
  source: RunResponseCaptureSource;
  /** Locks and re-checks the caller's authority inside the reservation transaction. */
  authorize: (tx: Db) => Promise<{ run: typeof heartbeatRuns.$inferSelect }>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Run-scoped response capture: a durable byte reservation (per run in
 * `resultJson.apiResponseCaptureBytes`, per company in
 * `runnerApiResponseReservations`), a stored asset and an activity row.
 */
export function createRunResponseCapture(options: RunResponseCaptureOptions) {
  const { db, companyId, agentId, runId, source } = options;
  let reservationId: string | undefined;
  let storageAttempted = false;

  const lockCompany = async (tx: Db) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`runner-api-capture:${companyId}`}, 0))`);
  };

  const reserve = async (reserveBytes: number) => {
    if (!Number.isSafeInteger(reserveBytes) || reserveBytes <= 0 || reserveBytes > RUNNER_API_RESPONSE_MAX_BYTES) {
      throw new Error("Invalid response capture reservation size");
    }
    const release = acquireRunnerApiResponseSlot(companyId);
    let id: string;
    try {
      id = await db.transaction(async tx => {
        await lockCompany(tx as unknown as Db);
        const locked = await options.authorize(tx as unknown as Db);
        const resultJson = record(locked.run.resultJson);
        const used = resultJson.apiResponseCaptureBytes ?? 0;
        if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0
          || used + reserveBytes > RUNNER_API_RESPONSE_RUN_MAX_BYTES) {
          throw new RunnerApiResponseLimitError("api_response_capture_limit", "This run has insufficient capture budget (4 GiB per run). Read an existing asset or narrow the query.");
        }
        // One company lock covers all runs/processes. Stored assets include
        // snapshots from before reservations existed; attached reservations
        // are excluded so completed snapshots are counted exactly once.
        const [usage] = await tx.select({ bytes: sql<string>`
          coalesce((select sum(${assets.byteSize}) from ${assets}
            where ${assets.companyId} = ${companyId}
              and (${assets.objectKey} like ${`${companyId}/runner-api/%`}
                or exists (select 1 from ${runnerApiResponseReservations} capture
                  where capture.asset_id = ${assets.id} and capture.company_id = ${companyId}))), 0)
          + coalesce((select sum(${runnerApiResponseReservations.reservedBytes}) from ${runnerApiResponseReservations}
            where ${runnerApiResponseReservations.companyId} = ${companyId}
              and ${runnerApiResponseReservations.assetId} is null), 0)` }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const companyBytes = Number(usage.bytes);
        if (!Number.isSafeInteger(companyBytes) || companyBytes < 0 || companyBytes + reserveBytes > runnerApiCompanyCaptureMaxBytes()) {
          throw new RunnerApiResponseLimitError("api_response_company_storage_limit", "Company API snapshot storage quota is exhausted. Read an existing asset or ask the operator to remove old snapshots or increase the quota.");
        }
        // Reserve worst-case bytes durably before creating a temporary file.
        // Interrupted/failed captures keep the reservation, preventing retry
        // loops and process restarts from resetting this run's disk-I/O budget.
        await tx.update(heartbeatRuns).set({ resultJson: { ...resultJson, apiResponseCaptureBytes: used + reserveBytes } }).where(eq(heartbeatRuns.id, runId));
        const [reservation] = await tx.insert(runnerApiResponseReservations).values({ companyId, runId, reservedBytes: reserveBytes }).returning({ id: runnerApiResponseReservations.id });
        return reservation.id;
      });
    } catch (error) { release(); throw error; }
    let settled = false;
    return { id, settle: async (completedBytes?: number, cleaned?: boolean, attempted?: boolean) => {
      if (settled) return;
      settled = true;
      try {
        await db.transaction(async tx => {
          await lockCompany(tx as unknown as Db);
          // Reclaim a handled pre-storage failure only after disk cleanup.
          // Crashes, failed cleanup, and ambiguous storage failures keep their
          // reservation until an operator reconciles the possible orphan data.
          if (cleaned && !attempted) await tx.delete(runnerApiResponseReservations).where(and(eq(runnerApiResponseReservations.id, id), isNull(runnerApiResponseReservations.assetId)));
          if (completedBytes === undefined) return;
          const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))).for("update");
          if (!run) return;
          const resultJson = record(run.resultJson);
          const used = resultJson.apiResponseCaptureBytes;
          if (typeof used !== "number" || !Number.isSafeInteger(used) || used < reserveBytes) return;
          await tx.update(heartbeatRuns).set({ resultJson: { ...resultJson, apiResponseCaptureBytes: used - reserveBytes + completedBytes } }).where(eq(heartbeatRuns.id, run.id));
        });
      } finally { release(); }
    } };
  };

  const reserveResponseCapture = async (reserveBytes = RUNNER_API_RESPONSE_MAX_BYTES): Promise<RunResponseCaptureSettle> => {
    const reservation = await reserve(reserveBytes);
    reservationId = reservation.id;
    return (completedBytes, cleaned) => reservation.settle(completedBytes, cleaned, storageAttempted);
  };

  const saveResponse = async (bytes: RunnerApiResponseBody, contentType: string): Promise<RunResponseCaptureArtifact> => {
    if (!reservationId) throw new Error("API response storage reservation is missing");
    const storage = options.storage ?? getStorageService();
    storageAttempted = true;
    const saved = await storage.putFile({ companyId, namespace: options.caseId ? `cases/${options.caseId}/runner-api` : "runner-api", originalFilename: contentType.includes("json") ? "response.json" : "response.bin", contentType, ...(Buffer.isBuffer(bytes) ? { body: bytes } : { body: createReadStream(bytes.path), byteSize: bytes.byteSize, sha256: bytes.sha256 }) });
    const asset = await db.transaction(async tx => {
      await lockCompany(tx as unknown as Db);
      const asset = await assetService(tx as unknown as Db).create(companyId, { ...saved, createdByAgentId: agentId });
      await tx.update(runnerApiResponseReservations).set({ assetId: asset.id, reservedBytes: asset.byteSize }).where(and(eq(runnerApiResponseReservations.id, reservationId!), eq(runnerApiResponseReservations.companyId, companyId)));
      return asset;
    }).catch(async error => {
      // A failed commit acknowledgement can still leave a committed
      // asset. A locking read waits out that transaction before proving
      // the reservation is unlinked and safe to compensate.
      const reservation = await db.select({ assetId: runnerApiResponseReservations.assetId })
        .from(runnerApiResponseReservations).where(and(eq(runnerApiResponseReservations.id, reservationId!), eq(runnerApiResponseReservations.companyId, companyId))).for("update")
        .then(rows => rows[0]).catch(() => undefined);
      if (reservation?.assetId === null) {
        const removed = await storage.deleteObject(companyId, saved.objectKey).then(() => true, () => false);
        if (removed) storageAttempted = false;
      }
      throw error;
    });
    const activity = await persistActivity(db, { companyId, actorType: "agent", actorId: agentId, agentId, runId, issueId: options.issueId, action: "asset.created", entityType: "asset", entityId: asset.id, details: { source, byteSize: saved.byteSize } });
    publishActivity(activity.publication);
    return { artifactId: asset.id, url: `/api/assets/${asset.id}/content`, contentType, byteSize: saved.byteSize, sha256: saved.sha256 };
  };

  /** Reserve, save and settle one response; a failure before storage frees the reservation. */
  const captureOnce = async (bytes: RunnerApiResponseBody, contentType: string, reserveBytes = RUNNER_API_RESPONSE_MAX_BYTES): Promise<RunResponseCaptureArtifact> => {
    const settle = await reserveResponseCapture(reserveBytes);
    try {
      const artifact = await saveResponse(bytes, contentType);
      await settle(artifact.byteSize, true);
      return artifact;
    } catch (error) {
      // Ambiguous storage failures keep the reservation (see settle).
      await settle(undefined, true).catch(() => undefined);
      throw error;
    }
  };

  return { reserveResponseCapture, saveResponse, captureOnce };
}
