import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sshCalls: string[][] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((file: string, args: string[], _options: object, callback: (...a: unknown[]) => void) => {
      if (file !== "ssh") throw new Error(`Unexpected subprocess ${file}`);
      sshCalls.push(args);
      callback(null, "", "");
      return {};
    }),
  };
});

import {
  SSH_CONTROL_DIR_MAX_BYTES,
  buildSshSpawnTarget,
  createSshCommandManagedRuntimeRunner,
  cleanupSshConnectionReuse,
  prepareSshControlDir,
  runSshCommand,
  sshControlBaseDir,
  sshControlDirFor,
} from "./ssh.js";

const RUN_ID = "3f1d2c4b-5a6e-4f70-8b9c-0d1e2f3a4b5c";
const SPEC = {
  host: "mac.invalid", port: 22, username: "agent",
  remoteWorkspacePath: "/w", remoteCwd: "/w",
  privateKey: null, knownHosts: null, strictHostKeyChecking: true,
};
const REUSE_OPTION_NAMES = ["ControlMaster", "ControlPath", "ControlPersist", "ServerAliveInterval", "ServerAliveCountMax"];
const reuseOptions = (args: string[]) =>
  args.filter((arg) => REUSE_OPTION_NAMES.some((name) => arg.startsWith(`${name}=`)));

let baseDir: string;
beforeEach(async () => {
  sshCalls.length = 0;
  // Short on purpose: os.tmpdir() can be long; the real default is /tmp too.
  baseDir = path.join(await mkdtemp("/tmp/pcs-t"), "b");
  vi.stubEnv("PAPERCLIP_SSH_CONTROL_DIR", baseDir);
  vi.stubEnv("PAPERCLIP_SSH_CONNECTION_REUSE", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(path.dirname(baseDir), { recursive: true, force: true });
});

describe("ssh connection reuse argument lists (AC 1, AC 4)", () => {
  it("adds the control options to runSshCommand only", async () => {
    await runSshCommand(SPEC, "true", { connectionReuseRunId: RUN_ID });
    expect(reuseOptions(sshCalls[0]!)).toEqual([
      "ControlMaster=auto",
      `ControlPath=${sshControlDirFor(RUN_ID, baseDir)}/%C`,
      "ControlPersist=60",
      "ServerAliveInterval=15",
      "ServerAliveCountMax=3",
    ]);

    const spawn = await buildSshSpawnTarget({ spec: SPEC, command: "agent", args: [], env: {} });
    expect(reuseOptions(spawn.args)).toEqual([]);
    await spawn.cleanup();
  });

  it("PAPERCLIP_SSH_CONNECTION_REUSE=0 gives exactly today's list", async () => {
    await runSshCommand(SPEC, "echo hi", {});
    const today = sshCalls[0]!;
    vi.stubEnv("PAPERCLIP_SSH_CONNECTION_REUSE", "0");
    await runSshCommand(SPEC, "echo hi", { connectionReuseRunId: RUN_ID });
    expect(sshCalls[1]).toEqual(today);
    expect(reuseOptions(today)).toEqual([]);
  });

  it("the bridge's command runner passes the run id through", async () => {
    const runner = createSshCommandManagedRuntimeRunner({ spec: SPEC, connectionReuseRunId: RUN_ID });
    await runner.execute({ command: "true", timeoutMs: 1_000 });
    expect(reuseOptions(sshCalls[0]!)).toContain(`ControlPath=${sshControlDirFor(RUN_ID, baseDir)}/%C`);
  });

  it("falls back to a fresh connection for a run id that is not a plain id", async () => {
    await runSshCommand(SPEC, "true", { connectionReuseRunId: "../escape" });
    expect(reuseOptions(sshCalls[0]!)).toEqual([]);
  });
});

describe("ssh control directory (AC 2)", () => {
  it("is private, keyed by run id and short", async () => {
    const dir = await prepareSshControlDir(RUN_ID);
    expect(dir).toBe(path.join(baseDir, "Px0sS1puT3CLnA0eLzpLXA"));
    expect((await stat(dir!)).mode & 0o777).toBe(0o700);
    expect((await stat(baseDir)).mode & 0o777).toBe(0o700);

    vi.unstubAllEnvs();
    const realDefault = sshControlDirFor(RUN_ID, sshControlBaseDir());
    expect(Buffer.byteLength(`${realDefault}/`)).toBeLessThanOrEqual(SSH_CONTROL_DIR_MAX_BYTES);
    // ssh binds `<dir>/<%C: 40 hex>.<16 chars>` first; macOS holds 103 bytes.
    expect(Buffer.byteLength(`${realDefault}/${"f".repeat(40)}.${"x".repeat(16)}`)).toBeLessThanOrEqual(103);
  });

  it("is not used when the base is open to others", async () => {
    await mkdir(baseDir);
    await chmod(baseDir, 0o755);
    expect(await prepareSshControlDir(RUN_ID)).toBeNull();
  });

  it("run-end cleanup sends -O exit per socket and removes the dir", async () => {
    const dir = (await prepareSshControlDir(RUN_ID))!;
    await writeFile(path.join(dir, "abc123"), "");
    await cleanupSshConnectionReuse({ runId: RUN_ID });
    expect(sshCalls).toEqual([["-o", `ControlPath=${path.join(dir, "abc123")}`, "-O", "exit", "paperclip-control"]]);
    expect(await readdir(baseDir)).toEqual([]);
  });
});
