/**
 * Background Drive transfers (PAR-8125). A save or import over 5 MiB can take minutes, far past the host's action
 * limit, so the action starts it here and returns a transfer id at once; the page polls `getTransfer` for progress and
 * the result. Status lives in this worker's memory only: after a restart the page is told plainly to try again, and a
 * retry makes no second copy (the CRM dedupes saves on sha256, imports dedupe on the asset's source ref).
 * A transfer view never holds a signed link: those stay inside the run function and the CRM event.
 */
import { randomUUID } from "node:crypto";
import { StudioError } from "./errors.js";

export type TransferKind = "save" | "import";

export interface TransferView {
  transferId: string;
  kind: TransferKind;
  status: "running" | "done" | "failed";
  bytesDone: number;
  bytesTotal: number;
  result?: unknown;
  error?: string;
}

interface Entry extends TransferView {
  companyId: string;
  key: string;
  updatedAt: number;
}

/** No progress for this long: the transfer is reported as stopped (the kit's own idle wait is shorter). */
export const TRANSFER_STALE_MS = 2 * 60_000;
const KEEP_MS = 30 * 60_000;
const RETRY = "Try again; a retry doesn't make a second copy.";
const transfers = new Map<string, Entry>();

function view(e: Entry): TransferView {
  const out: TransferView = { transferId: e.transferId, kind: e.kind, status: e.status, bytesDone: e.bytesDone, bytesTotal: e.bytesTotal };
  if (e.status === "done") out.result = e.result;
  if (e.status === "failed") out.error = e.error;
  return out;
}

function prune(now: number): void {
  for (const [id, e] of transfers) if (e.status !== "running" && now - e.updatedAt > KEEP_MS) transfers.delete(id);
}

/**
 * Start `run` in the background, or return the transfer already running for the same company and key (a double click,
 * or two people at once in this worker). The check and the insert are synchronous, so two calls can't both start one.
 */
export function startTransfer(
  companyId: string,
  kind: TransferKind,
  key: string,
  bytesTotal: number,
  run: (progress: (bytesDone: number, bytesTotal: number) => void) => Promise<unknown>,
): TransferView {
  const now = Date.now();
  prune(now);
  for (const e of transfers.values()) if (e.companyId === companyId && e.key === key && e.status === "running") return view(e);
  const e: Entry = { transferId: randomUUID(), companyId, kind, key, status: "running", bytesDone: 0, bytesTotal, updatedAt: now };
  transfers.set(e.transferId, e);
  void (async () => {
    try {
      const result = await run((done, total) => {
        if (e.status !== "running" || !Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return;
        e.bytesTotal = total;
        e.bytesDone = Math.max(e.bytesDone, Math.min(done, total));
        e.updatedAt = Date.now();
      });
      if (e.status !== "running") return;
      e.status = "done";
      e.bytesDone = e.bytesTotal;
      e.result = result;
    } catch (err) {
      if (e.status !== "running") return;
      e.status = "failed";
      // Only Studio's own plain messages reach the page; anything else could carry a storage link.
      e.error = err instanceof StudioError ? err.message : `The Drive transfer failed. ${RETRY}`;
    }
    e.updatedAt = Date.now();
  })();
  return view(e);
}

export function getTransfer(companyId: string, transferId: string, now = Date.now()): TransferView {
  const e = transfers.get(transferId);
  if (!e || e.companyId !== companyId) {
    throw new StudioError(`This transfer isn't running any more, most likely because Studio restarted. ${RETRY}`, "not_found");
  }
  if (e.status === "running" && now - e.updatedAt > TRANSFER_STALE_MS) {
    e.status = "failed";
    e.error = `Nothing moved for ${TRANSFER_STALE_MS / 60_000} minutes, so Studio stopped waiting. Check that the CRM plugin is running. ${RETRY}`;
    e.updatedAt = now;
  }
  return view(e);
}

/** Tests only. */
export function resetTransfers(): void {
  transfers.clear();
}
