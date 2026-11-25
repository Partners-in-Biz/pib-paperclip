/**
 * Runner slots (PAR-10126 D5b): at most `RUNNER_SLOTS` `dist/ml/runner.mjs` processes at once in this worker, over every
 * mode (track and matte). Each runner holds up to ~1.4 GB with its two ffmpeg children, so a third start waits, in order,
 * until one ends. Every runner start goes through `startRunner`; nothing else spawns `runner.mjs`.
 */
import { runContained, type RunHandle, type RunOptions } from "../video-edit/ffmpeg.js";

export const RUNNER_SLOTS = 2;

/** A FIFO counting semaphore. `release` is idempotent. */
export class Semaphore {
  private inUse = 0;
  private readonly queue: Array<{ grant: (release: () => void) => void }> = [];
  private readonly size: number;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error("size must be a positive integer");
    this.size = size;
  }

  get active(): number {
    return this.inUse;
  }

  get waiting(): number {
    return this.queue.length;
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next.grant(this.releaser());
      else this.inUse -= 1;
    };
  }

  /** A slot now, or null. Synchronous, so a caller can hold it before any await. */
  tryAcquire(): (() => void) | null {
    if (this.inUse >= this.size) return null;
    this.inUse += 1;
    return this.releaser();
  }

  /** Waits for a slot; an aborted `signal` leaves the queue and rejects with its reason. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const now = this.tryAcquire();
    if (now) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(signal!.reason);
      };
      const entry = {
        grant: (release: () => void) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(release);
        },
      };
      this.queue.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** The one in-worker semaphore over every runner start. */
export const runnerSlots = new Semaphore(RUNNER_SLOTS);

export interface StartRunnerOptions extends Omit<RunOptions, "tool"> {
  /** Aborting while queued gives up the place; after the start, cancel through the handle. */
  signal?: AbortSignal;
  /** Tests only. */
  slots?: Semaphore;
}

/** Waits for a runner slot, then starts `runner.mjs <args>` contained (`runContained` tool "node"). The slot frees when the run ends. */
export async function startRunner(args: string[], opts: StartRunnerOptions = {}): Promise<RunHandle> {
  const { signal, slots = runnerSlots, ...run } = opts;
  const release = await slots.acquire(signal);
  let handle: RunHandle;
  try {
    handle = runContained(args, { ...run, tool: "node" });
  } catch (e) {
    release();
    throw e;
  }
  void handle.done.finally(release);
  return handle;
}
