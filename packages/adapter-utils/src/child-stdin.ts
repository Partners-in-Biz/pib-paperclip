import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * A child's stdin is a Socket. A write after the child died emits `error`
 * (`EPIPE`) on it, and with no listener that error kills the server. These
 * helpers attach the listener before any write and keep it attached for late
 * errors.
 *
 * Every error is logged once at warn level with the caller's fixed `label`, so
 * the log names the writer. `EPIPE` and `ERR_STREAM_DESTROYED` mean the child
 * closed its end: they are not passed to `onError`, because the child's exit
 * decides the result. Pass `{ includePipeClosed: true }` when the caller must
 * act on them too (a peer process that would block otherwise).
 */
export type ChildStdinErrorHandler = (error: NodeJS.ErrnoException) => void;

export interface ChildStdinGuardOptions {
  includePipeClosed?: boolean;
}

const PIPE_CLOSED_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);
const guarded = new WeakSet<Writable>();

export function isPipeClosedError(error: NodeJS.ErrnoException): boolean {
  return typeof error.code === "string" && PIPE_CLOSED_CODES.has(error.code);
}

/**
 * Attach the stdin error listener once per child. A second call on the same
 * child is a no-op (the first handler stays), so it adds no extra listener.
 */
export function guardChildStdin(
  child: Pick<ChildProcess, "stdin">,
  label: string,
  onError?: ChildStdinErrorHandler,
  options: ChildStdinGuardOptions = {},
): void {
  const stdin = child.stdin;
  if (!stdin || guarded.has(stdin)) return;
  guarded.add(stdin);
  stdin.on("error", (error: NodeJS.ErrnoException) => {
    console.warn(
      `[paperclip] child stdin error (${label}): code=${error.code ?? "unknown"} syscall=${error.syscall ?? "unknown"}`,
    );
    if (!onError) return;
    if (isPipeClosedError(error) && !options.includePipeClosed) return;
    onError(error);
  });
}

/** One-shot write: guard first, then `end(input)`. */
export function writeChildStdin(
  child: Pick<ChildProcess, "stdin">,
  input: string | Buffer,
  label: string,
  onError?: ChildStdinErrorHandler,
  options?: ChildStdinGuardOptions,
): void {
  if (!child.stdin) return;
  guardChildStdin(child, label, onError, options);
  child.stdin.end(input);
}

/** Guard the destination stdin, then pipe `source` into it. */
export function pipeIntoChildStdin(
  source: Readable,
  child: Pick<ChildProcess, "stdin">,
  label: string,
  onError?: ChildStdinErrorHandler,
  options?: ChildStdinGuardOptions,
): void {
  if (!child.stdin) return;
  guardChildStdin(child, label, onError, options);
  source.pipe(child.stdin);
}
