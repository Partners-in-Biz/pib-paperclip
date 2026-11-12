import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
const flushSentry = vi.fn(async () => {});
vi.mock("../sentry.js", async (orig) => ({
  ...(await orig<typeof import("../sentry.js")>()),
  captureException: (...a: unknown[]) => captureException(...a),
  flushSentry: (...a: unknown[]) => flushSentry(...a),
}));

import {
  STREAM_WRITE_ERROR_NET_MARKER,
  handleUncaughtException,
  installStreamWriteErrorNet,
  resetStreamWriteErrorNetForTests,
} from "../stream-write-error-net.js";
import { buildSentryInitOptions } from "../sentry.js";

const coded = (code: string) => Object.assign(new Error(code), { code, syscall: "write" });
let exit: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetStreamWriteErrorNetForTests();
  captureException.mockClear();
  flushSentry.mockClear();
  delete process.env.PAPERCLIP_EXIT_ON_STREAM_WRITE_ERROR;
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("stream write error net", () => {
  it.each(["EPIPE", "ERR_STREAM_DESTROYED"])("keeps running on %s", async (code) => {
    await handleUncaughtException(coded(code), "uncaughtException");
    expect(exit).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain(STREAM_WRITE_ERROR_NET_MARKER);
    expect(line).toContain(code);
    expect(line).toContain("writer unknown: no M5a label was logged for this error");
  });

  it.each([
    ["EPIPE rejection", coded("EPIPE"), "unhandledRejection"],
    ["ECONNRESET", coded("ECONNRESET"), "uncaughtException"],
    ["TypeError", new TypeError("x"), "uncaughtException"],
    ["ENOENT", coded("ENOENT"), "uncaughtException"],
  ])("captures, flushes and exits 1 for %s", async (_n, err, origin) => {
    await handleUncaughtException(err, origin);
    expect(captureException).toHaveBeenCalledWith(err);
    expect(flushSentry).toHaveBeenCalledWith(2_000);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("reports only the later fatal error to Sentry", async () => {
    await handleUncaughtException(coded("EPIPE"), "uncaughtException");
    const t = new TypeError("fatal");
    await handleUncaughtException(t, "uncaughtException");
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(t);
  });

  it("removes Sentry's uncaught and unhandled-rejection default integrations", () => {
    const sentry = {
      httpIntegration: () => ({ name: "Http" }),
      onUnhandledRejectionIntegration: () => ({ name: "OnUnhandledRejection" }),
    };
    const opts = buildSentryInitOptions("https://k@example.com/1", sentry) as any;
    const out = opts.integrations([{ name: "OnUncaughtException" }, { name: "OnUnhandledRejection" }, { name: "Other" }]);
    const names = out.map((i: { name: string }) => i.name);
    expect(names).not.toContain("OnUncaughtException");
    expect(names.filter((n: string) => n === "OnUnhandledRejection")).toHaveLength(1); // the strict one we add
    expect(names).toContain("Other");
  });

  it("breaker: 10 in 60s keep running, the 11th exits", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 10; i++) await handleUncaughtException(coded("EPIPE"), "uncaughtException");
    expect(exit).not.toHaveBeenCalled();
    await handleUncaughtException(coded("EPIPE"), "uncaughtException");
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.some((c) => String(c[0]).includes("breaker tripped"))).toBe(true);
  });

  it("breaker: 10 spread over more than 60s keep running", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 20; i++) {
      await handleUncaughtException(coded("EPIPE"), "uncaughtException");
      vi.advanceTimersByTime(7_000);
    }
    expect(exit).not.toHaveBeenCalled();
  });

  it("kill switch is read at error time", async () => {
    installStreamWriteErrorNet();
    process.env.PAPERCLIP_EXIT_ON_STREAM_WRITE_ERROR = "1";
    await handleUncaughtException(coded("EPIPE"), "uncaughtException");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("installing twice adds one listener", () => {
    const before = process.listenerCount("uncaughtException");
    installStreamWriteErrorNet();
    installStreamWriteErrorNet();
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);
  });
});

describe("end to end", () => {
  const script = `
    const { installStreamWriteErrorNet } = await import(${JSON.stringify(resolve(__dirname, "../stream-write-error-net.ts"))});
    installStreamWriteErrorNet();
    const { spawn } = await import("node:child_process");
    const c = spawn("sh", ["-c", "exec 0<&-; sleep 0.3"], { stdio: ["pipe", "ignore", "ignore"] });
    setTimeout(() => c.stdin.write(Buffer.alloc(1024 * 1024)), 100);
    setTimeout(() => { console.log("alive"); process.exit(0); }, 800);
  `;
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, ...env }, encoding: "utf8", cwd: resolve(__dirname, "../.."), timeout: 30_000,
    });

  it("survives a dead child's stdin and prints the marker", () => {
    const r = run({});
    expect(r.stderr).toContain(STREAM_WRITE_ERROR_NET_MARKER);
    expect(r.stdout).toContain("alive");
    expect(r.status).toBe(0);
  }, 40_000);

  it("exits 1 with the kill switch", () => {
    expect(run({ PAPERCLIP_EXIT_ON_STREAM_WRITE_ERROR: "1" }).status).toBe(1);
  }, 40_000);
});
