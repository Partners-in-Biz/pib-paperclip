/**
 * hermes_local on an ssh environment (PAR-7017): the process, prompt file,
 * workspace sync and session read all go to the remote target; local runs do
 * not touch the remote path at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const target = {
  kind: "remote",
  transport: "ssh",
  remoteCwd: "/Users/peet/ws",
  spec: { host: "mac.example", port: 22, username: "peet", remoteCwd: "/Users/peet/ws" },
};

const { localRun } = vi.hoisted(() => ({
  localRun: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "session_id: sess_local01\n", stderr: "" })),
}));

type Call = { command: string; args: string[]; env: Record<string, string>; stdin?: string; cwd: string; runId: string };
const { calls, restore, prepare, state } = vi.hoisted(() => {
  const restore = vi.fn(async () => undefined);
  return {
    calls: [] as Array<{ command: string; args: string[]; env: Record<string, string>; stdin?: string; cwd: string; runId: string }>,
    restore,
    prepare: vi.fn(async (_input: unknown) => ({
      workspaceRemoteDir: "/Users/peet/.paperclip-runtime/hermes/ws",
      runtimeRootDir: "/Users/peet/.paperclip-runtime/hermes",
      assetDirs: {},
      restoreWorkspace: restore,
    })),
    state: {
      sessionRows:
        '[{"id":"sess_remote1","input_tokens":100,"output_tokens":40,"cache_read_tokens":0,"cache_write_tokens":0,"estimated_cost_usd":0.2}]',
      mainResult: { exitCode: 0 as number | null, signal: null as string | null, timedOut: false },
      mainStdout: null as string | null,
    },
  };
});
void (null as unknown as Call);

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime: prepare,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
    runAdapterExecutionTargetProcess: vi.fn(async (runId: string, _t: unknown, command: string, args: string[], opts: { env: Record<string, string>; stdin?: string; cwd: string }) => {
      calls.push({ runId, command, args, env: opts.env, stdin: opts.stdin, cwd: opts.cwd });
      const script = args.join(" ");
      let stdout = "";
      if (command === "sh" && script.includes("mktemp")) stdout = "PCQ:/tmp/paperclip-hermes-query-AbC123\n";
      else if (command === "python3") stdout = `PCSESS:${state.sessionRows}\n`;
      else if (script.includes("exec \"$@\"")) stdout = state.mainStdout ?? "session_id: sess_remote1\nhello from the mac\n";
      const isMain = script.includes("exec \"$@\"");
      return { ...(isMain ? state.mainResult : { exitCode: 0, signal: null, timedOut: false }), stdout, stderr: "", pid: 1, startedAt: "" };
    }),
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return { ...actual, runChildProcess: localRun };
});

import { execute } from "./execute.js";

function makeCtx(over: Record<string, unknown> = {}, sessionParams: Record<string, unknown> | null = null) {
  return {
    runId: "run-7017",
    agent: { id: "agent-1", companyId: "company-1", name: "Release Engineer", adapterType: "hermes_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams, sessionDisplayId: null, taskKey: null },
    config: {
      hermesCommand: "/opt/hermes/bin/hermes",
      model: "claude-sonnet-5-5",
      provider: "claude-subscription-directsdk-experimental",
      timeoutSec: 60,
      graceSec: 3,
      cwd: "/tmp/server-workspace",
      env: { HERMES_HOME: "/Users/peet/.hermes/profiles/claudesub", MY_TOKEN: "super-secret-value" },
      ...over,
    },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
    authToken: "run-token",
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
    executionTarget: target,
  } as never;
}

beforeEach(() => {
  calls.length = 0;
  restore.mockClear();
  prepare.mockClear();
  localRun.mockClear();
  state.mainResult = { exitCode: 0, signal: null, timedOut: false };
  state.mainStdout = null;
});

const mainCall = () => calls.find((c) => c.args.join(" ").includes('exec "$@"'))!;

describe("hermes_local on an ssh target", () => {
  it("syncs the workspace, stages the prompt remotely, runs hermes there, restores and cleans up", async () => {
    const ctx = makeCtx();
    const result = await execute(ctx);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(localRun).not.toHaveBeenCalled();

    const staged = calls.find((c) => c.args.join(" ").includes("mktemp"))!;
    expect(staged.stdin).toContain("Release Engineer"); // prompt travels on stdin, not argv
    expect(staged.args.join(" ")).not.toContain("Release Engineer");

    const main = mainCall();
    expect(main.cwd).toBe("/Users/peet/.paperclip-runtime/hermes/ws");
    const argv = main.args.slice(3); // sh -c WRAPPER sh PIDFILE cmd ...
    expect(argv[0]).toBe("/tmp/paperclip-hermes-query-AbC123/pid");
    expect(argv[1]).toBe("/opt/hermes/bin/hermes");
    expect(argv).toContain("--query-file");
    expect(argv[argv.indexOf("--query-file") + 1]).toBe("/tmp/paperclip-hermes-query-AbC123/query.txt");
    expect(argv).not.toContain("-q");
    expect(argv[argv.indexOf("--provider") + 1]).toBe("claude-subscription-directsdk-experimental");
    expect(main.env.HERMES_HOME).toBe("/Users/peet/.hermes/profiles/claudesub");
    expect(main.env.MY_TOKEN).toBe("super-secret-value");
    expect(main.env.PATH).toBeUndefined(); // server environment is not forwarded
    expect(main.env.PAPERCLIP_API_KEY).toBe("run-token");

    // cleanup of the staged dir and workspace restore
    expect(calls.some((c) => c.command === "rm" && c.args.includes("/tmp/paperclip-hermes-query-AbC123"))).toBe(true);
    expect(restore).toHaveBeenCalledTimes(1);

    // session metered from the remote state.db, identity stored for resume
    expect(result.exitCode).toBe(0);
    expect(result.provider).toBe("claude-subscription-directsdk-experimental");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 40, cachedInputTokens: 0 });
    expect(result.sessionParams).toMatchObject({ sessionId: "sess_remote1", remoteExecution: { host: "mac.example" } });
    const pyCall = calls.find((c) => c.command === "python3")!;
    expect(pyCall.args.slice(-3)).toEqual(["/Users/peet/.hermes/profiles/claudesub", "sess_remote1", ""]);
  });

  it("never prints env values", async () => {
    const ctx = makeCtx();
    await execute(ctx);
    const logged = JSON.stringify((ctx as { onLog: { mock: { calls: unknown[] } } }).onLog.mock.calls);
    expect(logged).not.toContain("super-secret-value");
    expect(logged).not.toContain("run-token");
  });

  it("resumes a session created on the same host and baselines usage from the remote store", async () => {
    state.sessionRows = '[{"id":"sess_remote1","input_tokens":60,"output_tokens":10}]';
    const ctx = makeCtx({}, { sessionId: "sess_remote1", remoteExecution: { transport: "ssh", host: "mac.example", port: 22, username: "peet", remoteCwd: "/Users/peet/ws" } });
    await execute(ctx);
    const argv = mainCall().args.slice(3);
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess_remote1");
    expect(argv).toContain("--no-restore-cwd");
  });

  it("starts a new session when the remote store no longer has it (Session not found)", async () => {
    state.sessionRows = "[]";
    const ctx = makeCtx({}, { sessionId: "sess_gone01", remoteExecution: { transport: "ssh", host: "mac.example", port: 22, username: "peet", remoteCwd: "/Users/peet/ws" } });
    await execute(ctx);
    expect(mainCall().args).not.toContain("--resume");
  });

  it("does not resume a session from another host or from the server", async () => {
    await execute(makeCtx({}, { sessionId: "sess_server1" }));
    expect(mainCall().args).not.toContain("--resume");
    await execute(makeCtx({}, { sessionId: "sess_other01", remoteExecution: { transport: "ssh", host: "other.example", port: 22, username: "peet", remoteCwd: "/x" } }));
    expect(calls.filter((c) => c.args.includes("--resume"))).toHaveLength(0);
  });

  it("kills the remote process tree on timeout", async () => {
    state.mainResult = { exitCode: null, signal: "SIGTERM", timedOut: true };
    const result = await execute(makeCtx());
    expect(result.timedOut).toBe(true);
    const kill = calls.find((c) => c.args.join(" ").includes("kill -TERM"));
    expect(kill?.args.slice(-2)).toEqual(["/tmp/paperclip-hermes-query-AbC123/pid", "3"]);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("does not kill anything on a clean exit", async () => {
    await execute(makeCtx());
    expect(calls.some((c) => c.args.join(" ").includes("kill -TERM"))).toBe(false);
  });
});

describe("hermes_local without an ssh target", () => {
  it("uses the local runner exactly as before", async () => {
    const ctx = makeCtx();
    (ctx as { executionTarget: unknown }).executionTarget = undefined;
    await execute(ctx);
    expect(prepare).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(localRun).toHaveBeenCalledTimes(1);
  });

  it("does not retry a remote run that printed the gateway line (PAR-9964)", async () => {
    state.mainResult = { exitCode: 1, signal: null, timedOut: false };
    state.mainStdout = "Error: Gateway starting: deadline\n";
    await execute(makeCtx());
    expect(calls.filter((c) => c.args.join(" ").includes('exec "$@"'))).toHaveLength(1);
    expect(localRun).not.toHaveBeenCalled();
  });
});
