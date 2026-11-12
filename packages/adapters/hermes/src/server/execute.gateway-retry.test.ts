/**
 * A local run that starts while the Hermes gateway is booting fails with
 * "Gateway starting: deadline". The adapter tries once more (PAR-9964).
 */

import fsp from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Res = { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
const GATEWAY: Res = { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "Error: Gateway starting: deadline\n" };
const OK: Res = { exitCode: 0, signal: null, timedOut: false, stdout: "session_id: 20261112_010101_abcdef\nhello\n", stderr: "" };

const { results, seen } = vi.hoisted(() => ({
  results: [] as unknown[],
  seen: [] as { cmd: string; args: string[]; env: unknown; timeoutSec: number; fileExisted: boolean }[],
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  const fs = await import("node:fs/promises");
  return {
    ...actual,
    runChildProcess: vi.fn(async (_id: string, cmd: string, args: string[], opts: { env: unknown; timeoutSec: number; onSpawn?: (m: unknown) => unknown }) => {
      const at = args.indexOf("--query-file");
      const fileExisted = at >= 0 ? await fs.stat(args[at + 1]).then(() => true, () => false) : true;
      seen.push({ cmd, args, env: opts.env, timeoutSec: opts.timeoutSec, fileExisted });
      await opts.onSpawn?.({ pid: 100 + seen.length, startedAt: "" });
      const next = results.shift();
      if (typeof next === "function") return (next as () => Res)();
      return next ?? OK;
    }),
  };
});

import { execute, gatewayWasNotReady } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    runId: "run-9964",
    agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "/usr/bin/hermes", timeoutSec: 600, graceSec: 5, promptTemplate: "x".repeat(200000), ...config },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
    onLog: vi.fn(async (_s: string, _c: string) => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
    ...extra,
  };
}
const logs = (ctx: ReturnType<typeof makeCtx>) => ctx.onLog.mock.calls.map((c) => String(c[1])).join("");
const RETRY_LINE = "[hermes] Hermes gateway was still starting; trying once more";

beforeEach(() => {
  results.length = 0;
  seen.length = 0;
  vi.mocked(serverUtils.runChildProcess).mockClear();
});

describe("gatewayWasNotReady", () => {
  it("is true only for a plain non-zero exit with the gateway text and nothing parsed", () => {
    expect(gatewayWasNotReady(GATEWAY, {})).toBe(true);
    expect(gatewayWasNotReady({ ...GATEWAY, stderr: "", stdout: "Gateway starting: deadline" }, {})).toBe(true);
    expect(gatewayWasNotReady(GATEWAY, { sessionId: "s" })).toBe(false);
    expect(gatewayWasNotReady(GATEWAY, { response: "hi" })).toBe(false);
    expect(gatewayWasNotReady({ ...GATEWAY, exitCode: 0 }, {})).toBe(false);
    expect(gatewayWasNotReady({ ...GATEWAY, exitCode: null }, {})).toBe(false);
    expect(gatewayWasNotReady({ ...GATEWAY, timedOut: true }, {})).toBe(false);
    expect(gatewayWasNotReady({ ...GATEWAY, signal: "SIGTERM" }, {})).toBe(false);
    expect(gatewayWasNotReady({ ...GATEWAY, stderr: "boom" }, {})).toBe(false);
  });
});

describe("hermes-local gateway retry", () => {
  it("retries once with the same command, args, env and a still-present query file", async () => {
    results.push(GATEWAY, OK);
    const ctx = makeCtx();
    const result = await execute(ctx as never);
    expect(seen).toHaveLength(2);
    expect(seen[1].cmd).toBe(seen[0].cmd);
    expect(seen[1].args).toEqual(seen[0].args);
    expect(seen[1].env).toEqual(seen[0].env);
    expect(seen[1].fileExisted).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage ?? null).toBeNull();
    expect(logs(ctx).split(RETRY_LINE).length - 1).toBe(1);
    expect(ctx.onSpawn).toHaveBeenCalledTimes(2);
    const file = seen[0].args[seen[0].args.indexOf("--query-file") + 1];
    await expect(fsp.stat(file)).rejects.toThrow();
  });

  it("never makes a third attempt", async () => {
    results.push(GATEWAY, GATEWAY, OK);
    const result = await execute(makeCtx() as never);
    expect(seen).toHaveLength(2);
    expect(result.exitCode).toBe(1);
  });

  it.each([
    ["a parsed session id", { ...GATEWAY, stdout: "session_id: 20261112_010101_abcdef\n" }],
    ["assistant output", { ...GATEWAY, stdout: "session_id: 20261112_010101_abcdef\nhello there\n" }],
    ["another failure", { ...GATEWAY, stderr: "Error: something else" }],
    ["a timeout", { ...GATEWAY, timedOut: true }],
    ["a signal", { ...GATEWAY, signal: "SIGTERM" }],
  ])("does not retry on %s", async (_name, first) => {
    results.push(first, OK);
    await execute(makeCtx() as never);
    expect(seen).toHaveLength(1);
  });

  it("does not retry when the run was cancelled meanwhile", async () => {
    const ac = new AbortController();
    results.push(() => { ac.abort(); return GATEWAY; }, OK);
    await execute(makeCtx({}, { signal: ac.signal }) as never);
    expect(seen).toHaveLength(1);
  });

  it("gives attempt 2 the remaining timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      results.push(() => { vi.setSystemTime(100_000); return GATEWAY; }, OK);
      await execute(makeCtx({ timeoutSec: 600 }) as never);
      expect(seen.map((s) => s.timeoutSec)).toEqual([600, 500]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry with under 30 s left", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      results.push(() => { vi.setSystemTime(580_000); return GATEWAY; }, OK);
      await execute(makeCtx({ timeoutSec: 600 }) as never);
      expect(seen).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
