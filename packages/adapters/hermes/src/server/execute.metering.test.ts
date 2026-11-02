/**
 * Session id, usage and billing for Hermes runs come from the lines Hermes
 * prints and from its own state.db, not from regexes over the output (PAR-6886).
 */

import { DatabaseSync } from "node:sqlite";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runs: { args: string[] }[] = [];
let nextOutput = { stdout: "", stderr: "" };

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async (_runId: string, _cmd: string, args: string[]) => {
      runs.push({ args });
      return { exitCode: 0, signal: null, timedOut: false, ...nextOutput };
    }),
  };
});

import { execute } from "./execute.js";

let home: string;

beforeEach(async () => {
  runs.length = 0;
  nextOutput = { stdout: "", stderr: "" };
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "par6886-exec-"));
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec(
    "CREATE TABLE sessions (id TEXT, parent_session_id TEXT, input_tokens REAL, output_tokens REAL, cache_read_tokens REAL, cache_write_tokens REAL, estimated_cost_usd REAL, actual_cost_usd REAL)",
  );
  db.prepare("INSERT INTO sessions (id, input_tokens, output_tokens, estimated_cost_usd) VALUES (?, ?, ?, ?)").run(
    "sess_live01",
    150,
    30,
    0.3,
  );
  db.close();
});

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});

function makeCtx(config: Record<string, unknown> = {}, sessionId: string | null = null) {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
    runtime: { sessionId, sessionParams: sessionId ? { sessionId } : null, sessionDisplayId: null, taskKey: null },
    config: { command: "/usr/bin/hermes", timeoutSec: 60, graceSec: 5, env: { HERMES_HOME: home }, ...config },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
    onLog: vi.fn(async (_stream: string, _chunk: string) => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

describe("hermes-local adapter metering", () => {
  it("stores the session, books tokens and cost from state.db as subscription_included, per run", async () => {
    nextOutput = { stdout: "I've already spent 21 runs, cost: $21.00\n", stderr: "session_id: sess_live01\n" };
    const result = await execute(makeCtx() as never);

    expect(result.sessionParams).toEqual({ sessionId: "sess_live01" });
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 30, cachedInputTokens: 0 });
    expect(result.costUsd).toBeCloseTo(0.3, 6);
    expect(result.usageBasis).toBe("per_run");
    expect(result.billingType).toBe("subscription_included");
  });

  it("lets adapterConfig.billingType override the default", async () => {
    nextOutput = { stdout: "", stderr: "session_id: sess_live01\n" };
    const result = await execute(makeCtx({ billingType: "api" }) as never);
    expect(result.billingType).toBe("api");
  });

  it("books no usage and no prose cost when the store cannot be read", async () => {
    nextOutput = { stdout: "cost: $21.00\ntokens: 5 input 6 output\n", stderr: "session_id: sess_live01\n" };
    const result = await execute(makeCtx({ env: { HERMES_HOME: path.join(home, "nope") } }) as never);
    expect(result.usage).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
    expect(result.billingType).toBeUndefined();
  });

  it("resumes with --no-restore-cwd and books only this run's tokens", async () => {
    // The session held 100 in / 10 out before the run (the baseline); Hermes
    // raises it to 150 / 30 while the run executes.
    const before = new DatabaseSync(path.join(home, "state.db"));
    before.exec("UPDATE sessions SET input_tokens = 100, output_tokens = 10, estimated_cost_usd = 0.1");
    before.close();
    const ctx = makeCtx({}, "sess_live01");
    const { runChildProcess } = await import("@paperclipai/adapter-utils/server-utils");
    vi.mocked(runChildProcess).mockImplementationOnce(async (_id, _cmd, args) => {
      runs.push({ args });
      const during = new DatabaseSync(path.join(home, "state.db"));
      during.exec("UPDATE sessions SET input_tokens = 150, output_tokens = 30, estimated_cost_usd = 0.3");
      during.close();
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "session_id: sess_live01\n", pid: 1, startedAt: "" } as never;
    });

    const result = await execute(ctx as never);

    const args = runs[0].args;
    expect(args[args.indexOf("--resume") + 1]).toBe("sess_live01");
    expect(args).toContain("--no-restore-cwd");
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 20, cachedInputTokens: 0 });
    expect(result.costUsd).toBeCloseTo(0.2, 6);
  });

  it("starts a new session when the stored one was pruned from Hermes' store", async () => {
    nextOutput = { stdout: "", stderr: "session_id: sess_live01\n" };
    const ctx = makeCtx({}, "sess_pruned9");
    const result = await execute(ctx as never);

    const args = runs[0].args;
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--no-restore-cwd");
    const logs = ctx.onLog.mock.calls.map((call) => String(call[1])).join("");
    expect(logs).toContain("is not in Hermes' session store any more");
    expect(result.sessionParams).toEqual({ sessionId: "sess_live01" });
  });
});
