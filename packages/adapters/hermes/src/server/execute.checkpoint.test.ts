import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    })),
  };
});

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    runId: "test-run-checkpoint",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "/usr/bin/hermes",
      timeoutSec: 60,
      graceSec: 5,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "issue_commented",
      paperclipWake: null,
    },
    onLog: vi.fn(async () => undefined),
    onSessionCheckpoint: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("hermes early session checkpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("checkpoints the stream-json init session id even when the process is killed", async () => {
    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(async (_id, _cmd, _args, opts) => {
      await opts.onLog(
        "stdout",
        '{"type":"system","subtype":"init","session_id":"20261028_145531_817f3d"}\n',
      );
      return {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        stdout: "",
        stderr: "killed",
        pid: 42,
        startedAt: "2026-10-28T17:00:00.000Z",
      };
    });

    const ctx = makeCtx();
    const result = await execute(ctx as never);
    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)?.[2] as string[];
    expect(args).toContain("--format");
    expect(args).toContain("stream-json");
    expect(ctx.onSessionCheckpoint).toHaveBeenCalledWith({
      sessionId: "20261028_145531_817f3d",
    });
    expect(result.sessionParams).toEqual({ sessionId: "20261028_145531_817f3d" });
  });

  it("keeps the first init session id and ignores ids echoed later or on other streams", async () => {
    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(async (_id, _cmd, _args, opts) => {
      await opts.onLog(
        "stdout",
        [
          '{"type":"system","subtype":"init","session_id":"20261028_145531_817f3d"}',
          '{"type":"tool_result","session_id":"20261028_150000_aaaaaa"}',
          '{"type":"system","subtype":"init","session_id":"20261028_150001_bbbbbb"}',
          "session_id: 20261028_150002_cccccc",
          "",
        ].join("\n"),
      );
      await opts.onLog("stderr", "session_id: 20261028_150003_dddddd\n");
      return {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: 42,
        startedAt: "2026-10-28T17:00:00.000Z",
      };
    });

    const ctx = makeCtx();
    await execute(ctx as never);
    expect(ctx.onSessionCheckpoint).toHaveBeenCalledTimes(1);
    expect(ctx.onSessionCheckpoint).toHaveBeenCalledWith({ sessionId: "20261028_145531_817f3d" });
  });

  it("extracts clean prose from stream-json stdout instead of storing raw NDJSON", async () => {
    const sid = "local-6cc3df5141efe83b3aa6667ebd23463c4f12df93d8683ff60106c4147285d41c";
    const ndjson = [
      `{"type":"system","subtype":"init","session_id":"${sid}"}`,
      '{"type":"text","text":"I can\'t run it now.","timestamp":1795669181852}',
      '{"type":"text","text":" Neither can Sipho.","timestamp":1795669181853}',
      `{"type":"result","session_id":"${sid}","exit_code":0,"text":"I can't run it now. Neither can Sipho.","tokens":{"input":100,"output":20,"total":120,"cache_read":80,"cache_write":10},"duration_ms":500,"timestamp":1795669182016}`,
    ].join("\n");
    vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: ndjson,
      stderr: "",
      pid: 42,
      startedAt: "2026-11-26T07:00:00.000Z",
    }));

    const ctx = makeCtx();
    const result = await execute(ctx as never);
    expect(result.summary).toBe("I can't run it now. Neither can Sipho.");
    expect(result.resultJson?.result).toBe("I can't run it now. Neither can Sipho.");
    expect(result.sessionParams).toEqual({ sessionId: sid });
  });

  describe("PAPERCLIP_SESSION_CHECKPOINT=0", () => {
    beforeEach(() => {
      vi.stubEnv("PAPERCLIP_SESSION_CHECKPOINT", "0");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("does not request stream-json, checkpoint, or reshape stdout", async () => {
      vi.mocked(serverUtils.runChildProcess).mockImplementationOnce(async (_id, _cmd, _args, opts) => {
        await opts.onLog(
          "stdout",
          '{"type":"system","subtype":"init","session_id":"20261028_145531_817f3d"}\n\npartial',
        );
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: 42,
          startedAt: "2026-10-28T17:00:00.000Z",
        };
      });

      const ctx = makeCtx({
        context: {
          issueId: "issue-1",
          wakeReason: "issue_commented",
          paperclipWake: null,
          paperclipSessionHandoffMarkdown: "Paperclip session handoff:\n- Rotation reason: raw input",
        },
      });
      await execute(ctx as never);
      const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)?.[2] as string[];
      expect(args).not.toContain("--format");
      expect(ctx.onSessionCheckpoint).not.toHaveBeenCalled();
      expect(ctx.onLog).toHaveBeenCalledWith(
        "stdout",
        '{"type":"system","subtype":"init","session_id":"20261028_145531_817f3d"}\n\npartial',
      );
    });
  });
});
