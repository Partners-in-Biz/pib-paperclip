/**
 * Large Drive transfers on the page (PAR-8125): a save or import over 5 MiB answers with a transfer id instead of the
 * result. `awaitTransfer` polls `drive-transfer` until it is done, reporting progress, and resolves with the result or
 * throws the worker's plain refusal. Small files answer directly and pass straight through.
 */
export interface TransferState {
  transferId: string;
  status: "running" | "done" | "failed";
  bytesDone: number;
  bytesTotal: number;
  result?: unknown;
  error?: string;
}

export function isTransfer(out: unknown): out is TransferState {
  return !!out && typeof out === "object" && typeof (out as TransferState).transferId === "string" && typeof (out as TransferState).status === "string";
}

export const POLL_MS = 1500;

export async function awaitTransfer<T>(
  out: unknown,
  poll: (params: { companyId: string; transferId: string }) => Promise<unknown>,
  companyId: string,
  onProgress: (done: number, total: number) => void,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  let state = out;
  while (isTransfer(state)) {
    onProgress(state.bytesDone, state.bytesTotal);
    if (state.status === "done") return state.result as T;
    if (state.status === "failed") throw new Error(state.error || "The Drive transfer failed. Try again.");
    await wait(POLL_MS);
    state = await poll({ companyId, transferId: state.transferId });
  }
  return state as T;
}

export function percent(done: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, Math.floor((done / total) * 100))) : 0;
}
