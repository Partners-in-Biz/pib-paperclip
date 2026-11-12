import { captureException, flushSentry } from "./sentry.js";

/** Fixed log marker for searches. A marker with no preceding M5a label line means an unguarded writer exists. */
export const STREAM_WRITE_ERROR_NET_MARKER = "[paperclip] stream-write-error-net: kept running";
export const STREAM_WRITE_ERROR_BREAKER_MAX = 10;
export const STREAM_WRITE_ERROR_BREAKER_WINDOW_MS = 60_000;
const KILL_SWITCH_ENV = "PAPERCLIP_EXIT_ON_STREAM_WRITE_ERROR";

let installed = false;
let markerTimes: number[] = [];

function isKeptAliveClass(error: unknown, origin: string): boolean {
  if (origin !== "uncaughtException") return false;
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

/** The uncaughtException handler. Exported so tests can call it directly. */
export async function handleUncaughtException(error: unknown, origin: string): Promise<void> {
  if (isKeptAliveClass(error, origin) && process.env[KILL_SWITCH_ENV] !== "1") {
    const now = Date.now();
    markerTimes = markerTimes.filter((t) => now - t <= STREAM_WRITE_ERROR_BREAKER_WINDOW_MS);
    if (markerTimes.length < STREAM_WRITE_ERROR_BREAKER_MAX) {
      markerTimes.push(now);
      const e = error as { code?: string; syscall?: string; stack?: string };
      console.error(
        `${STREAM_WRITE_ERROR_NET_MARKER} code=${e.code} syscall=${e.syscall ?? "unknown"}: ` +
          `writer unknown: no M5a label was logged for this error\n${e.stack ?? ""}`,
      );
      return;
    }
    console.error("[paperclip] stream-write-error-net: breaker tripped");
  }
  console.error("[paperclip] uncaught exception, exiting", error);
  try {
    captureException(error);
    await flushSentry(2_000);
  } finally {
    process.exit(1);
  }
}

/** Install the net once. Idempotent. */
export function installStreamWriteErrorNet(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (error, origin) => {
    void handleUncaughtException(error, origin);
  });
}

/** Test helper: reset module state. */
export function resetStreamWriteErrorNetForTests(): void {
  installed = false;
  markerTimes = [];
}
