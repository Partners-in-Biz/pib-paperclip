import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildSshEnvLabFixtureConfig,
  cleanupSshConnectionReuse,
  getSshEnvLabSupport,
  runSshCommand,
  sshControlDirFor,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshConnectionConfig,
  type SshEnvLabFixtureState,
} from "./ssh.js";

// Merge gates 1 and 2 of PAR-9403, against a real local sshd.
const support = await getSshEnvLabSupport();
const live = support.supported ? describe : describe.skip;
const RUN_ID = "7c0ffee0-1234-4abc-8def-0123456789ab";

function controlCheck(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ssh", ["-o", `ControlPath=${socketPath}`, "-O", "check", "x"], { timeout: 5_000 }, (error) =>
      resolve(!error));
  });
}

live(`ssh connection reuse against a real sshd${support.supported ? "" : ` (skipped: ${support.reason})`}`, () => {
  let fixtureRoot: string;
  let fixture: SshEnvLabFixtureState;
  let config: SshConnectionConfig;
  let baseDir: string;

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-reuse-"));
    fixture = await startSshEnvLabFixture({ statePath: path.join(fixtureRoot, "state.json") });
    config = await buildSshEnvLabFixtureConfig(fixture);
    baseDir = path.join(await mkdtemp("/tmp/pcs-l"), "b");
    vi.stubEnv("PAPERCLIP_SSH_CONTROL_DIR", baseDir);
  }, 30_000);
  afterEach(async () => {
    await cleanupSshConnectionReuse({ runId: RUN_ID });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (fixture) await stopSshEnvLabFixture(fixture);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(path.dirname(baseDir), { recursive: true, force: true });
  });

  it("gate 1: the call that starts the master returns in under 2 s, not after ControlPersist", async () => {
    const startedAt = Date.now();
    const first = await runSshCommand(config, "echo first", { connectionReuseRunId: RUN_ID, timeoutMs: 10_000 });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(first.stdout.trim()).toBe("first");

    const dir = sshControlDirFor(RUN_ID, baseDir)!;
    const sockets = await readdir(dir);
    expect(sockets).toHaveLength(1);
    expect(await controlCheck(path.join(dir, sockets[0]!))).toBe(true);

    const second = await runSshCommand(config, "echo second", { connectionReuseRunId: RUN_ID });
    expect(second.stdout.trim()).toBe("second");
    expect(await readdir(dir)).toEqual(sockets);

    await cleanupSshConnectionReuse({ runId: RUN_ID });
    expect(await controlCheck(path.join(dir, sockets[0]!))).toBe(false);
    expect(await readdir(baseDir)).toEqual([]);
  }, 20_000);

  it("cold start: two concurrent first ops race to create the master and both succeed", async () => {
    const [a, b] = await Promise.all([
      runSshCommand(config, "echo a", { connectionReuseRunId: RUN_ID, timeoutMs: 10_000 }),
      runSshCommand(config, "echo b", { connectionReuseRunId: RUN_ID, timeoutMs: 10_000 }),
    ]);
    expect([a.stdout.trim(), b.stdout.trim()]).toEqual(["a", "b"]);
    // One master won; the loser ran on its own connection or joined the winner.
    const dir = sshControlDirFor(RUN_ID, baseDir)!;
    const sockets = await readdir(dir);
    expect(sockets).toHaveLength(1);
    expect(await controlCheck(path.join(dir, sockets[0]!))).toBe(true);
    const next = await runSshCommand(config, "echo next", { connectionReuseRunId: RUN_ID });
    expect(next.stdout.trim()).toBe("next");
  }, 20_000);

  it("gate 2: operations over MaxSessions (default 10) still complete", async () => {
    await runSshCommand(config, "true", { connectionReuseRunId: RUN_ID });
    const count = 13;
    const results = await Promise.all(Array.from({ length: count }, (_, index) =>
      runSshCommand(config, `sleep 1; echo op-${index}`, { connectionReuseRunId: RUN_ID, timeoutMs: 15_000 })));
    expect(results.map((result) => result.stdout.trim()))
      .toEqual(Array.from({ length: count }, (_, index) => `op-${index}`));
    // The ops over the limit were refused by the master and ran on their own connection.
    expect(results.filter((result) => result.stderr.includes("Session open refused")).length)
      .toBeGreaterThan(0);
  }, 30_000);
});
