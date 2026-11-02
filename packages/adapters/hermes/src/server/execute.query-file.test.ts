/**
 * The prompt goes to a private file (hermes chat --query-file), not argv, so a
 * task history over 128 KB no longer fails with spawn E2BIG (PAR-6886).
 */

import fsp from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const seen: { args: string[]; fileText: string | null; env: Record<string, string> }[] = [];

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  const fs = await import("node:fs/promises");
  return {
    ...actual,
    runChildProcess: vi.fn(async (_runId: string, _cmd: string, args: string[], opts: { env: Record<string, string> }) => {
      const at = args.indexOf("--query-file");
      seen.push({
        args,
        fileText: at >= 0 ? await fs.readFile(args[at + 1], "utf8") : null,
        env: opts.env,
      });
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    }),
  };
});

import { execute } from "./execute.js";

function makeCtx(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "/usr/bin/hermes", timeoutSec: 60, graceSec: 5, ...config },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
    onLog: vi.fn(async (_stream: string, _chunk: string) => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

describe("hermes-local adapter --query-file", () => {
  beforeEach(() => {
    seen.length = 0;
  });

  it("passes a prompt over the kernel limit via a file that exists during the run and is gone after", async () => {
    const huge = "x".repeat(200000);
    const ctx = makeCtx({ promptTemplate: `Task: ${huge}` });
    await execute(ctx as never);

    expect(seen).toHaveLength(1);
    const { args, fileText } = seen[0];
    expect(args[0]).toBe("chat");
    expect(args).not.toContain("-q");
    expect(args.every((arg) => Buffer.byteLength(arg, "utf8") < 131072)).toBe(true);
    expect(fileText).toContain(huge);
    expect(args).toContain("-Q");

    const file = args[args.indexOf("--query-file") + 1];
    await expect(fsp.stat(file)).rejects.toThrow();
    const logs = ctx.onLog.mock.calls.map((call) => String(call[1])).join("");
    expect(logs).toMatch(/\[hermes\] Prompt: \d+ bytes via --query-file/);
  });

  it("drops an environment string the kernel would refuse and says so", async () => {
    const ctx = makeCtx({ env: { HUGE_VAR: "v".repeat(140000), SMALL_VAR: "ok" } });
    await execute(ctx as never);

    expect(seen[0].env.HUGE_VAR).toBeUndefined();
    expect(seen[0].env.SMALL_VAR).toBe("ok");
    const logs = ctx.onLog.mock.calls.map((call) => String(call[1])).join("");
    expect(logs).toContain("left out environment variable HUGE_VAR");
  });
});
