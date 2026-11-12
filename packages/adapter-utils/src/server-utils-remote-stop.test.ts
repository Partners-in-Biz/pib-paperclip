import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SshRemoteStopOutcome, SshRemoteStopSignal } from "./ssh.js";

// PAR-9399: runChildProcess stops the remote group on ssh targets first. The
// ssh client is a fake `ssh` on PATH that runs its last argument with sh, and
// buildSshSpawnTarget is replaced so stopRemote/cleanup are observable.

const sshMock = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("./ssh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ssh.js")>()),
  buildSshSpawnTarget: sshMock.build,
}));

const { runChildProcess, runningProcesses } = await import("./server-utils.js");

const remoteSpec = {
  host: "ssh.example.test",
  port: 22,
  username: "u",
  remoteCwd: "/srv/ws",
  remoteWorkspacePath: "/srv/ws",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: false,
};

let fakeBin: string;
beforeAll(async () => {
  fakeBin = await mkdtemp(path.join(os.tmpdir(), "par9399-ssh-"));
  await writeFile(path.join(fakeBin, "ssh"), '#!/bin/sh\neval "$1"\n');
  await chmod(path.join(fakeBin, "ssh"), 0o755);
});
afterAll(async () => {
  await rm(fakeBin, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  sshMock.build.mockReset();
});

type Remote = {
  calls: string[];
  stopRemote: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
};

// `onStop` decides what the fake remote does for each signal.
function fakeRemote(
  script: string,
  onStop: (signal: SshRemoteStopSignal, pid: number) => SshRemoteStopOutcome,
  options: { withStopRemote?: boolean } = {},
): Remote {
  const calls: string[] = [];
  let pid = 0;
  const remote: Remote = {
    calls,
    stopRemote: vi.fn(async (signal: SshRemoteStopSignal) => {
      calls.push(`stopRemote:${signal}`);
      return onStop(signal, pid);
    }),
    cleanup: vi.fn(async () => {
      calls.push("cleanup");
    }),
  };
  sshMock.build.mockImplementation(async () => ({
    command: "ssh",
    args: [script],
    cleanup: remote.cleanup,
    ...(options.withStopRemote === false ? {} : { stopRemote: remote.stopRemote }),
  }));
  (remote as Remote & { setPid: (p: number) => void }).setPid = (p) => {
    pid = p;
  };
  return remote;
}

const realKill = process.kill.bind(process);
function spyKills() {
  const kills: Array<[number, string]> = [];
  vi.spyOn(process, "kill").mockImplementation(((target: number, signal?: string | number) => {
    if (signal !== 0 && signal !== undefined) kills.push([target, String(signal)]);
    return realKill(target, signal as NodeJS.Signals);
  }) as typeof process.kill);
  return kills;
}

async function run(remote: Remote | null, opts: { timeoutSec?: number; terminal?: boolean; graceSec?: number } = {}) {
  const runId = randomUUID();
  let pid = 0;
  const result = await runChildProcess(runId, "agent", [], {
    cwd: process.cwd(),
    env: { PATH: `${fakeBin}:${process.env.PATH}` },
    timeoutSec: opts.timeoutSec ?? 10,
    graceSec: opts.graceSec ?? 1,
    onLog: async () => {},
    onSpawn: async (meta) => {
      pid = meta.pid;
      (remote as (Remote & { setPid?: (p: number) => void }) | null)?.setPid?.(meta.pid);
    },
    remoteExecution: remoteSpec,
    ...(opts.terminal
      ? { terminalResultCleanup: { hasTerminalResult: ({ stdout }) => stdout.includes("RESULT"), graceMs: 0 } }
      : {}),
  });
  return { result, pid, runId };
}

const stopsGroup = (signal: SshRemoteStopSignal, pid: number): SshRemoteStopOutcome => {
  realKill(-pid, signal === "TERM" ? "SIGTERM" : "SIGKILL");
  return "signalled";
};

describe.skipIf(process.platform === "win32")("runChildProcess remote stop (ssh targets)", () => {
  it("result cleanup stops the remote group first and sends no local signal when that works", async () => {
    const remote = fakeRemote("echo RESULT; exec sleep 30", stopsGroup);
    const kills = spyKills();
    const { result } = await run(remote, { terminal: true });

    expect(remote.calls).toEqual(["stopRemote:TERM", "cleanup"]);
    expect(kills).toEqual([]);
    expect(result.terminalResultCleanup).toMatchObject({ stopped: true, signal: "SIGTERM", forceKilled: false });
  });

  it("passes the host run dir <remoteWorkspacePath>/.paperclip-runs/<runId> to the builder", async () => {
    fakeRemote("exit 0", stopsGroup);
    const { runId } = await run(null);
    expect(sshMock.build).toHaveBeenCalledWith(
      expect.objectContaining({ remoteRunDir: `/srv/ws/.paperclip-runs/${runId}` }),
    );
  });

  // "missing"/"unreadable": a run started by the previous release has no
  // record (or an old-format one); it is stopped by the local signal as before.
  it.each<SshRemoteStopOutcome>(["error", "missing", "unreadable"])(
    "falls back to the local signal when stopRemote reports %s",
    async (outcome) => {
      const remote = fakeRemote("echo RESULT; exec sleep 30", () => outcome);
      const kills = spyKills();
      const { result, pid } = await run(remote, { terminal: true });

      expect(remote.calls).toEqual(["stopRemote:TERM", "cleanup"]);
      expect(kills).toEqual([[-pid, "SIGTERM"]]);
      expect(result.signal).toBe("SIGTERM");
    },
  );

  it("runs the target cleanup when spawn throws", async () => {
    const remote = fakeRemote("exit 0", stopsGroup);
    sshMock.build.mockImplementation(async () => ({
      command: "ssh",
      args: ["bad\0arg"],
      cleanup: remote.cleanup,
      stopRemote: remote.stopRemote,
    }));
    await expect(run(remote)).rejects.toThrow();
    expect(remote.calls).toEqual(["cleanup"]);
  });

  it("timeout path: TERM, then KILL and the local signal after graceSec", async () => {
    // The fake remote ignores TERM, as a stuck background task would.
    const remote = fakeRemote("trap '' TERM; while :; do sleep 0.1; done", (signal, pid) =>
      signal === "KILL" ? stopsGroup(signal, pid) : "signalled",
    );
    const kills = spyKills();
    const { result, pid } = await run(remote, { timeoutSec: 1 });

    expect(result.timedOut).toBe(true);
    expect(remote.calls).toEqual(["stopRemote:TERM", "stopRemote:KILL", "cleanup"]);
    // The remote KILL already ended the client, so the local SIGKILL may find
    // the group gone; it is still attempted.
    expect(kills.every(([target, signal]) => target === -pid && signal === "SIGKILL")).toBe(true);
  }, 15_000);

  it("clears the KILL timer when the process closes", async () => {
    const remote = fakeRemote("exec sleep 30", stopsGroup);
    const kills = spyKills();
    await run(remote, { timeoutSec: 1, graceSec: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(remote.calls).toEqual(["stopRemote:TERM", "cleanup"]);
    expect(kills).toEqual([]);
  }, 15_000);

  it("removes the remote dir on every run end: exit, failure, cancel", async () => {
    for (const script of ["exit 0", "exit 3"]) {
      const remote = fakeRemote(script, stopsGroup);
      await run(remote);
      expect(remote.calls).toEqual(["cleanup"]);
    }

    // Cancel: the server signals the tracked entry, which now carries stopRemote.
    const remote = fakeRemote("exec sleep 30", stopsGroup);
    const pending = run(remote);
    let tracked: { stopRemote?: unknown; processGroupId: number | null } | undefined;
    for (let i = 0; i < 100 && !tracked; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      tracked = [...runningProcesses.values()].find((entry) => entry.stopRemote === remote.stopRemote);
    }
    expect(tracked).toBeDefined();
    realKill(-tracked!.processGroupId!, "SIGTERM");
    await pending;
    expect(remote.calls).toEqual(["cleanup"]);
  }, 15_000);
});

describe.skipIf(process.platform === "win32")("runChildProcess local targets (no stopRemote)", () => {
  it("keeps the local TERM-then-KILL sequence on timeout", async () => {
    const remote = fakeRemote("trap '' TERM; while :; do sleep 0.1; done", stopsGroup, { withStopRemote: false });
    const kills = spyKills();
    const { result, pid } = await run(remote, { timeoutSec: 1 });

    expect(result.timedOut).toBe(true);
    expect(remote.stopRemote).not.toHaveBeenCalled();
    expect(kills).toEqual([
      [-pid, "SIGTERM"],
      [-pid, "SIGKILL"],
    ]);
  }, 15_000);

  it("sends no SIGKILL after the process has closed", async () => {
    const remote = fakeRemote("exec sleep 30", stopsGroup, { withStopRemote: false });
    const kills = spyKills();
    const { pid } = await run(remote, { timeoutSec: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(kills).toEqual([[-pid, "SIGTERM"]]);
  }, 15_000);
});
