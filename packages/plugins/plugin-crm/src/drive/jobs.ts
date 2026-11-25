/**
 * In-memory registry of agent Drive transfers (PAR-9219 C.1-C.7). A transfer outlives the 30 s tool call, so the
 * tool returns a jobId at once and `drive_transfer_status` reports progress.
 *
 * No time-based stale state: a job is `running` until its promise settles (every network step on the path has its
 * own abort timeout). `finally` releases the transfer slot and runs the job's cleanup (closing fds). Finished jobs
 * are kept 30 minutes. A worker restart loses the registry; dedupe makes a retry safe.
 */
import { randomUUID } from "node:crypto";
import { BrokerError } from "./broker.js";
import { BUSY_TEXT, tryAcquireAgentSlot } from "./transfer-slots.js";

export type DriveJobKind = "save" | "fetch";
export type DriveJobStatus = "running" | "done" | "failed";

export interface DriveJobOwner {
  companyId: string;
  agentId: string | null;
  runId: string | null;
}

export interface DriveJobError {
  code: string;
  hint: string;
}

export interface DriveJob extends DriveJobOwner {
  jobId: string;
  kind: DriveJobKind;
  key: string;
  status: DriveJobStatus;
  bytesDone: number;
  bytesTotal: number;
  result?: unknown;
  error?: DriveJobError;
  updatedAt: string;
}

export type DriveJobStart =
  | { status: "started"; jobId: string; bytesTotal: number; alreadyRunning?: true }
  | { status: "busy"; hint: string };

/** A failure whose code and text are ours (never Google's): passed through to the status as it is. */
export class DriveJobFailure extends Error {
  constructor(readonly code: string, readonly hint: string) {
    super(hint);
    this.name = "DriveJobFailure";
  }
}

export const JOB_KEEP_MS = 30 * 60 * 1000;

export const TEXTS = {
  restart: "This transfer isn't running any more, most likely because the CRM restarted. Save it again; a finished copy is not made twice.",
  expired: "That file went to an earlier run's scratch dir, which is deleted when a run ends. Fetch it again in this run.",
  tooLarge: "The file is over 200 MB, the largest Drive transfer.",
  fileChanged: "The file changed while it was being saved. Save it again once it is finished.",
  sizeMismatch: "Drive sent a different size or checksum than it lists for this file, so the copy was removed. Fetch it again.",
  badCredential: "The Drive connection's key was refused; tell the operator.",
  notFound: "That Drive file no longer exists or isn't in this project's folder.",
  failed: "The Drive transfer failed. Try again; a retry doesn't make a second copy.",
} as const;

export const saveJobKey = (companyId: string, projectId: string, subfolder: string | null | undefined, name: string) =>
  JSON.stringify(["save", companyId, projectId, subfolder ?? "", name]);
export const fetchJobKey = (companyId: string, runId: string | null | undefined, googleFileId: string) =>
  JSON.stringify(["fetch", companyId, runId ?? "", googleFileId]);

const jobs = new Map<string, DriveJob & { endedAt?: number }>();
const running = new Map<string, string>(); // key -> jobId

/** Broker codes to our own texts (C.7). The broker message, which may carry Google's reply, is never used. */
export function jobErrorFor(kind: DriveJobKind, e: unknown): DriveJobError {
  if (e instanceof DriveJobFailure) return { code: e.code, hint: e.hint };
  const code = e instanceof BrokerError ? e.code : undefined;
  if (code === "too_large") return { code: "too_large", hint: TEXTS.tooLarge };
  if (code === "size_mismatch" || code === "sha_mismatch") {
    return kind === "save" ? { code: "file_changed", hint: TEXTS.fileChanged } : { code: "sha_mismatch", hint: TEXTS.sizeMismatch };
  }
  if (code === "bad_credential") return { code: "bad_credential", hint: TEXTS.badCredential };
  if (code === "not_found" || (e instanceof BrokerError && e.status === 404)) return { code: "not_found", hint: TEXTS.notFound };
  return { code: "transfer_failed", hint: TEXTS.failed };
}

function prune(now: number): void {
  for (const [id, job] of jobs) if (job.endedAt !== undefined && now - job.endedAt > JOB_KEEP_MS) jobs.delete(id);
}

export interface StartDriveJob {
  kind: DriveJobKind;
  key: string;
  bytesTotal: number;
  /** The transfer. `progress(bytesDone)` updates the status; the resolved value is the job's result. */
  work: (progress: (bytesDone: number) => void) => Promise<unknown>;
  /** Always runs once the job settles (e.g. closes the fd). Also runs when the job is not started. */
  cleanup?: () => unknown;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** Start a job, or return the running one with the same key. Returns at once; the work goes on in the background. */
export function startDriveJob(owner: DriveJobOwner, spec: StartDriveJob): DriveJobStart {
  prune(Date.now());
  const sameKey = running.get(spec.key);
  if (sameKey) {
    void Promise.resolve().then(spec.cleanup).catch(() => undefined);
    return { status: "started", jobId: sameKey, bytesTotal: jobs.get(sameKey)!.bytesTotal, alreadyRunning: true };
  }
  const release = tryAcquireAgentSlot();
  if (!release) {
    void Promise.resolve().then(spec.cleanup).catch(() => undefined);
    return { status: "busy", hint: BUSY_TEXT };
  }
  const job: DriveJob & { endedAt?: number } = {
    jobId: randomUUID(), ...owner, kind: spec.kind, key: spec.key, status: "running",
    bytesDone: 0, bytesTotal: spec.bytesTotal, updatedAt: new Date().toISOString(),
  };
  jobs.set(job.jobId, job);
  running.set(spec.key, job.jobId);
  const progress = (bytesDone: number) => {
    job.bytesDone = bytesDone;
    job.updatedAt = new Date().toISOString();
  };
  void (async () => {
    try {
      job.result = await spec.work(progress);
      job.status = "done";
      job.bytesDone = job.bytesTotal;
    } catch (e) {
      job.error = jobErrorFor(spec.kind, e);
      job.status = "failed";
      spec.logger?.warn("drive transfer failed", { jobId: job.jobId, kind: job.kind, code: job.error.code });
    } finally {
      release();
      running.delete(spec.key);
      job.endedAt = Date.now();
      job.updatedAt = new Date(job.endedAt).toISOString();
      try {
        await spec.cleanup?.();
      } catch {
        // cleanup is best effort; the job's outcome stands
      }
    }
  })();
  return { status: "started", jobId: job.jobId, bytesTotal: job.bytesTotal };
}

export type DriveJobView =
  | { status: "not_found"; hint: string }
  | { status: "expired"; hint: string }
  | { status: "invalid_input"; hint: string }
  | ({ status: DriveJobStatus; jobId: string; kind: DriveJobKind; bytesDone: number; bytesTotal: number; updatedAt: string; result?: unknown } & Partial<DriveJobError>);

/** Status for the caller only: another company's or agent's job reads exactly like an unknown one. */
export function driveJobStatus(viewer: DriveJobOwner, jobId: unknown): DriveJobView {
  if (typeof jobId !== "string" || jobId.length === 0 || jobId.length > 100) return { status: "invalid_input", hint: "jobId is the id a Drive save or fetch returned." };
  prune(Date.now());
  const job = jobs.get(jobId);
  if (!job || job.companyId !== viewer.companyId || (job.agentId ?? null) !== (viewer.agentId ?? null)) {
    return { status: "not_found", hint: TEXTS.restart };
  }
  if (job.kind === "fetch" && (job.runId ?? null) !== (viewer.runId ?? null)) return { status: "expired", hint: TEXTS.expired };
  const view = { status: job.status, jobId: job.jobId, kind: job.kind, bytesDone: job.bytesDone, bytesTotal: job.bytesTotal, updatedAt: job.updatedAt };
  if (job.status === "done") return { ...view, result: job.result };
  if (job.status === "failed" && job.error) return { ...view, ...job.error };
  return view;
}

/** Tests only. */
export function resetDriveJobsForTests(): void {
  jobs.clear();
  running.clear();
}
