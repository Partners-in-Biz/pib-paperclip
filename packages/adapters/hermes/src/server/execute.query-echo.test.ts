/**
 * Hermes must not keep a leading `Query:` echo as the run summary.
 * -Q is always passed. An echo-only stdout does not become summary or result.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

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

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { cleanResponse, execute, STRIP_HERMES_QUERY_ECHO } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    runId: "test-run-echo",
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
      ...overrides,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "issue_assigned",
      paperclipWake: null,
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

describe("Hermes Query echo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports the revert switch on", () => {
    expect(STRIP_HERMES_QUERY_ECHO).toBe(true);
  });

  it("cleanResponse drops a leading Query: line and keeps a real answer", () => {
    expect(cleanResponse("Query: You are the SEO Specialist.\n")).toBe("");
    expect(
      cleanResponse("Query: You are the SEO Specialist.\n\nUpdated the title tag on the hunt page."),
    ).toBe("Updated the title tag on the hunt page.");
    expect(cleanResponse("Updated the title tag on the hunt page.")).toBe(
      "Updated the title tag on the hunt page.",
    );
    expect(cleanResponse("The page mentions Query: in the title.")).toBe(
      "The page mentions Query: in the title.",
    );
  });

  it("passes -Q on the default path", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Updated the title tag on the hunt page.\n",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    await execute(makeCtx() as never);
    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)?.[2] as string[];
    expect(args.slice(0, 4)).toEqual(["chat", "-q", expect.any(String), "-Q"]);
    expect(args).toContain("-Q");
  });

  it("passes -Q even when quiet is explicitly false", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    await execute(makeCtx({ quiet: false }) as never);
    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)?.[2] as string[];
    expect(args).toContain("-Q");
  });

  it("does not store an echo-only stdout as summary or result", async () => {
    const echo = "Query: You are the SEO Specialist. Rewrite the hunt page title.";
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: `${echo}\n`,
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const result = await execute(makeCtx() as never);
    expect(result.summary).toBeUndefined();
    expect(result.resultJson).toMatchObject({
      result: "",
      agentPromptEchoWithheld: true,
    });
    expect(String((result.resultJson as { result?: string }).result)).not.toMatch(/^Query:/);
  });

  it("keeps a real answer after a Query: line when session_id is missing", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Query: You are the SEO Specialist.\n\nUpdated the title tag on the hunt page.\n",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const result = await execute(makeCtx() as never);
    expect(result.summary).toBe("Updated the title tag on the hunt page.");
    expect(result.resultJson).toMatchObject({
      result: "Updated the title tag on the hunt page.",
    });
  });
});
