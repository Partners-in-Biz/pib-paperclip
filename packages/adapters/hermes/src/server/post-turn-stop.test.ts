import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listDescendantProcessGroups,
  parseTurnReport,
  startPostTurnStopGuard,
} from "./post-turn-stop.js";

const dirs: string[] = [];
async function tmp() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "post-turn-stop-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

function until(check: () => boolean, ms = 5000) {
  return vi.waitFor(() => expect(check()).toBe(true), { timeout: ms, interval: 20 });
}

describe("parseTurnReport", () => {
  it("reads Hermes' record and rejects incomplete ones", () => {
    expect(parseTurnReport('{"pid": 7, "exit_code": 0, "error": "", "reply": "done"}')).toEqual({
      exitCode: 0,
      error: "",
      reply: "done",
    });
    expect(parseTurnReport("\uFEFF{\"exit_code\": 1}")).toEqual({ exitCode: 1, error: "", reply: "" });
    expect(parseTurnReport('{"pid": 7}')).toBeNull();
    expect(parseTurnReport("{not json")).toBeNull();
    expect(parseTurnReport("[1]")).toBeNull();
  });
});

describe("listDescendantProcessGroups", () => {
  it("returns the other process groups below the root, at any depth", async () => {
    const proc = await tmp();
    const stat = async (pid: number, comm: string, ppid: number, pgrp: number) => {
      await fsp.mkdir(path.join(proc, String(pid)));
      await fsp.writeFile(path.join(proc, String(pid), "stat"), `${pid} (${comm}) S ${ppid} ${pgrp} ${pgrp} 0 -1\n`);
    };
    await stat(100, "hermes", 1, 100);
    await stat(101, "bash", 100, 100); // foreground tool: same group as Hermes
    await stat(200, "vite (dev) server", 100, 200); // background job in its own session
    await stat(201, "esbuild", 200, 200);
    await stat(300, "node", 201, 300); // grandchild that left the group
    await stat(400, "unrelated", 1, 400);
    await fsp.mkdir(path.join(proc, "self"));

    expect((await listDescendantProcessGroups(100, proc)).sort()).toEqual([200, 300]);
  });

  it("is empty when /proc cannot be read", async () => {
    expect(await listDescendantProcessGroups(1, "/nonexistent-proc-root")).toEqual([]);
  });
});

describe("startPostTurnStopGuard", () => {
  it("stops the process a grace after the turn report, then kills it", async () => {
    const signals: string[] = [];
    let alive = true;
    const guard = await startPostTurnStopGuard({
      graceSec: 0.1,
      killGraceSec: 1,
      tmpRoot: await tmp(),
      getProcess: () => (alive ? { pid: 4242, signal: (signal) => signals.push(signal) } : null),
      listDescendantGroups: async () => [],
      onLog: async () => undefined,
    });
    expect(guard).not.toBeNull();
    await fsp.writeFile(`${guard!.reportPath}.tmp`, '{"pid": 1, "exit_code": 0, "error": "", "reply": "handoff"}');
    await fsp.rename(`${guard!.reportPath}.tmp`, guard!.reportPath);

    await until(() => signals.includes("SIGTERM"));
    await until(() => signals.includes("SIGKILL"), 3000);
    alive = false;
    const outcome = await guard!.finish();
    expect(outcome).toEqual({ report: { exitCode: 0, error: "", reply: "handoff" }, stopped: true, forceKilled: true });
    await expect(fsp.stat(path.dirname(guard!.reportPath))).rejects.toThrow();
  });

  it("leaves a process alone when it exits within the grace", async () => {
    const getProcess = vi.fn(() => ({ pid: 4242, signal: vi.fn() }));
    const guard = await startPostTurnStopGuard({
      graceSec: 5,
      killGraceSec: 1,
      tmpRoot: await tmp(),
      getProcess,
      onLog: async () => undefined,
    });
    await fsp.writeFile(guard!.reportPath, '{"pid": 1, "exit_code": 2, "error": "boom", "reply": ""}');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const outcome = await guard!.finish();
    expect(outcome).toEqual({ report: { exitCode: 2, error: "boom", reply: "" }, stopped: false, forceKilled: false });
    expect(getProcess).not.toHaveBeenCalled();
  });

  it("never stops a run whose Hermes writes no report (older Hermes)", async () => {
    const getProcess = vi.fn(() => ({ pid: 4242, signal: vi.fn() }));
    const guard = await startPostTurnStopGuard({
      graceSec: 0.05,
      killGraceSec: 1,
      tmpRoot: await tmp(),
      getProcess,
      onLog: async () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await guard!.finish()).toEqual({ report: null, stopped: false, forceKilled: false });
    expect(getProcess).not.toHaveBeenCalled();
  });

  it("returns null when the report folder cannot be made", async () => {
    const guard = await startPostTurnStopGuard({
      graceSec: 1,
      killGraceSec: 1,
      tmpRoot: "/nonexistent-root-for-post-turn-stop",
      getProcess: () => null,
      onLog: async () => undefined,
    });
    expect(guard).toBeNull();
  });
});
