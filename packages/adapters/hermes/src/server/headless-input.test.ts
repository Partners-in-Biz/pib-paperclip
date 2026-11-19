import { describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return { ...actual, runChildProcess: vi.fn() };
});

import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
import { execute } from "./execute.js";
import { detectInputRequired } from "./headless-input.js";

const DETACH = "Input required; detached without cancelling. Resume this session interactively.\n";
const AGENTS = "/x/agents/abc/instructions/AGENTS.md";
const stream = (...recs: object[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("detectInputRequired", () => {
  it("returns null without the detach line", () => {
    expect(detectInputRequired("ok", "")).toBeNull();
  });
  it("names the blocked protected-file write", () => {
    const out = stream(
      { type: "tool_use", name: "terminal", input: { command: "ls" } },
      { type: "tool_use", name: "patch", input: { path: AGENTS } },
    );
    const msg = detectInputRequired(out, DETACH)!;
    expect(msg).toContain("protected instruction file write");
    expect(msg).toContain(AGENTS);
  });
  it("falls back to a generic message when no write tool preceded it", () => {
    const out = stream({ type: "tool_use", name: "patch", input: { path: AGENTS } }, { type: "tool_use", name: "terminal" });
    expect(detectInputRequired(out, DETACH)).toContain("could not be identified");
  });
});

describe("execute() input-required path", () => {
  it("reports hermes_input_required naming the blocked path", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValue({
      exitCode: 3,
      signal: null,
      timedOut: false,
      stdout: stream({ type: "tool_use", name: "patch", input: { path: AGENTS } }),
      stderr: DETACH,
    } as any);
    const res = await execute({
      runId: "r1",
      agent: { id: "a1", companyId: "c1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "/usr/bin/hermes", timeoutSec: 60, graceSec: 5 },
      context: { issueId: "i1", wakeReason: "manual", paperclipWake: null },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn: vi.fn(async () => undefined),
    } as any);
    expect(res.errorCode).toBe("hermes_input_required");
    expect(res.errorMessage).toContain(AGENTS);
    const env = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![3].env as Record<string, string>;
    expect(env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toContain("do not patch or write AGENTS.md");
  });
});
