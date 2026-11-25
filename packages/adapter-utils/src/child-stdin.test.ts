import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardChildStdin, writeChildStdin } from "./child-stdin.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// events.once() would reject on "error"; only wait for "close".
function closed(stream: Writable) {
  return new Promise<void>((resolve) => stream.once("close", () => resolve()));
}

function shortLivedChild() {
  return spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["pipe", "ignore", "ignore"] });
}

describe("child stdin helpers", () => {
  it("guardChildStdin adds one listener per child and logs an EPIPE once with its label", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onError = vi.fn();
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      const child = shortLivedChild();
      const before = child.stdin!.listenerCount("error");
      guardChildStdin(child, "test.guard", onError);
      guardChildStdin(child, "test.guard", onError);
      expect(child.stdin!.listenerCount("error")).toBe(before + 1);

      // 1 MB is more than the pipe holds, so the write is still pending when
      // the child exits and fails with EPIPE.
      child.stdin!.write(Buffer.alloc(1024 * 1024));
      await closed(child.stdin!);
      // After exit Node has destroyed stdin; a later write fails quietly.
      child.stdin!.write("late");
      await new Promise((resolve) => setTimeout(resolve, 50));

      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("test.guard");
      expect(lines[0]).toMatch(/code=(EPIPE|ERR_STREAM_DESTROYED|ECONNRESET)/);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("passes pipe-closed errors on only when asked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const quiet = vi.fn();
    const loud = vi.fn();
    const a = shortLivedChild();
    const b = shortLivedChild();
    writeChildStdin(a, Buffer.alloc(1024 * 1024), "test.quiet", quiet);
    writeChildStdin(b, Buffer.alloc(1024 * 1024), "test.loud", loud, { includePipeClosed: true });
    await Promise.all([closed(a.stdin!), closed(b.stdin!)]);
    expect(quiet).not.toHaveBeenCalled();
    expect(loud).toHaveBeenCalledTimes(1);
  });
});
