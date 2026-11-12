import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSshRemoteStopScript,
  buildSshRunDirRemoveScript,
  buildSshSpawnTarget,
  parseSshRunRecord,
  SSH_REMOTE_STOP_TIMEOUT_MS,
  sshRemoteRunDirFor,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

// PAR-9399: stop the remote process group on ssh targets. The record itself
// (format v1, writer, parser) is PAR-9960; this file only reads it.

const RUN_ID = "11111111-2222-3333-4444-555555555555";
const WS = "/srv/paperclip/workspace";
const RUN_DIR = `${WS}/.paperclip-runs/${RUN_ID}`;

const spec = (ws = WS): SshRemoteExecutionSpec => ({
  host: "ssh.example.test",
  port: 22,
  username: "ssh-user",
  remoteCwd: ws,
  remoteWorkspacePath: ws,
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: true,
});

describe("run dir and stop scripts", () => {
  it("names the run dir <ws>/.paperclip-runs/<runId> and rejects odd run ids", () => {
    expect(sshRemoteRunDirFor(`${WS}/`, RUN_ID)).toBe(RUN_DIR);
    expect(sshRemoteRunDirFor(WS, "../x")).toBeNull();
    expect(sshRemoteRunDirFor(WS, "")).toBeNull();
    expect(sshRemoteRunDirFor("relative/ws", RUN_ID)).toBeNull();
  });

  it("builds the exact stopRemote command", () => {
    expect(buildSshRemoteStopScript(RUN_DIR, "TERM")).toBe(
      [
        "export LC_ALL=C",
        `f='${RUN_DIR}/record'`,
        'if [ ! -f "$f" ]; then echo missing; exit 0; fi',
        "bad() { echo unreadable; exit 0; }",
        "n=0; v=; pg=; want=; hv=; hp=; hl=",
        "while IFS= read -r l; do",
        "  n=$((n+1))",
        '  case "$l" in',
        '    v=*) [ -z "$hv" ] || bad; hv=1; v=${l#v=};;',
        '    pgid=*) [ -z "$hp" ] || bad; hp=1; pg=${l#pgid=};;',
        '    lstart=*) [ -z "$hl" ] || bad; hl=1; want=${l#lstart=};;',
        "    *) bad;;",
        "  esac",
        'done < "$f"',
        '[ -z "$l" ] || bad',
        '[ "$n" -eq 3 ] && [ "$v" = 1 ] || bad',
        "case \"$pg\" in ''|0?*|*[!0-9]*|????????????????*) bad;; esac",
        "case \"$want\" in ''|[[:space:]]*|*[[:space:]]) bad;; esac",
        'if [ "$pg" -le 1 ]; then echo refused; exit 0; fi',
        "self=$(ps -o pgid= -p $$ | tr -d ' ')",
        'if [ "$pg" = "$self" ]; then echo refused; exit 0; fi',
        'if ! kill -s 0 -- "-$pg" 2>/dev/null; then echo gone; exit 0; fi',
        "have=$(ps -o lstart= -p \"$pg\" 2>/dev/null | sed 's/^ *//;s/ *$//')",
        'if [ -z "$have" ]; then echo leader-gone; exit 0; fi',
        'if [ "$have" != "$want" ]; then echo mismatch; exit 0; fi',
        'if kill -s TERM -- "-$pg"; then echo signalled; else echo failed; fi',
      ].join("\n"),
    );
    expect(buildSshRemoteStopScript(RUN_DIR, "KILL")).toContain('kill -s KILL -- "-$pg"');
  });
});

describe("stopRemote and cleanup with a fake remote runner", () => {
  it("is absent without a run dir", async () => {
    const target = await buildSshSpawnTarget({ spec: spec(), command: "node", args: [], env: {} });
    expect(target.stopRemote).toBeUndefined();
    await target.cleanup();
  });

  it("returns the remote outcome, never throws, and removes the run dir once", async () => {
    const calls: Array<{ script: string; timeoutMs: number }> = [];
    let reply: () => Promise<{ stdout: string; stderr: string }> = async () => ({ stdout: "signalled\n", stderr: "" });
    const target = await buildSshSpawnTarget({
      spec: spec(),
      command: "node",
      args: [],
      env: {},
      remoteRunDir: RUN_DIR,
      remoteRunner: (script, timeoutMs) => {
        calls.push({ script, timeoutMs });
        return reply();
      },
    });

    await expect(target.stopRemote!("TERM")).resolves.toBe("signalled");
    expect(calls[0]).toEqual({ script: buildSshRemoteStopScript(RUN_DIR, "TERM"), timeoutMs: SSH_REMOTE_STOP_TIMEOUT_MS });
    reply = async () => ({ stdout: "mismatch\n", stderr: "" });
    await expect(target.stopRemote!("KILL")).resolves.toBe("mismatch");
    reply = async () => ({ stdout: "Welcome banner\n", stderr: "" });
    await expect(target.stopRemote!("TERM")).resolves.toBe("error");
    reply = async () => {
      throw new Error("ssh: connect timed out");
    };
    await expect(target.stopRemote!("TERM")).resolves.toBe("error");

    calls.length = 0;
    reply = async () => ({ stdout: "removed\n", stderr: "" });
    await Promise.all([target.cleanup(), target.cleanup()]);
    expect(calls).toEqual([
      { script: buildSshRunDirRemoveScript(WS, RUN_DIR), timeoutMs: SSH_REMOTE_STOP_TIMEOUT_MS },
    ]);
    // After cleanup the auth files are gone, so no further remote call is made.
    await expect(target.stopRemote!("KILL")).resolves.toBe("error");
    expect(calls).toHaveLength(1);
  });

  it("still releases local auth when the remote removal fails", async () => {
    const target = await buildSshSpawnTarget({
      spec: { ...spec(), privateKey: "-----BEGIN KEY-----\nfake\n-----END KEY-----" },
      command: "node",
      args: [],
      env: {},
      remoteRunDir: RUN_DIR,
      remoteRunner: async () => {
        throw new Error("unreachable");
      },
    });
    const keyPath = target.args[target.args.indexOf("-i") + 1]!;
    await stat(keyPath);
    await expect(target.cleanup()).resolves.toBeUndefined();
    await expect(stat(keyPath)).rejects.toThrow();
  });
});

// The scripts run here with real local shells against real processes. The
// spawn script (with PAR-9960's record writer) runs in a detached shell, so
// the agent leads its own process group as under sshd (PAR-9392 item 1).
// The stop and remove scripts reach the remote as `sh -c`, so they run in sh;
// bash is also checked for hosts whose sh is bash.
const shells = ["sh", "bash"].filter((shell) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${shell}`]).length > 0;
  } catch {
    return false;
  }
});

describe.skipIf(process.platform === "win32").each(shells)("remote scripts under %s", (shell) => {
  let root: string;
  let ws: string;
  let runDir: string;
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  const setup = async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "par9399-")));
    ws = path.join(root, "ws");
    runDir = sshRemoteRunDirFor(ws, RUN_ID)!;
    await mkdir(path.join(root, "home"), { recursive: true });
    await mkdir(ws);
  };
  const runScript = (script: string) =>
    new Promise<string>((resolve, reject) => {
      execFile(shell, ["-c", script], { timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
    });
  const record = () => readFile(path.join(runDir, "record"), "utf8").catch(() => "");
  const startRun = async (command: string, args: string[]) => {
    await setup();
    const target = await buildSshSpawnTarget({ spec: spec(ws), command, args, env: {}, remoteRunDir: runDir });
    const child = spawn(shell, ["-c", String(target.args.at(-1))], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(root, "home") },
      detached: true,
      stdio: "ignore",
    });
    children.push(child);
    for (let i = 0; i < 100; i += 1) {
      const parsed = parseSshRunRecord(await record());
      if (parsed.status === "readable") return { child, pgid: parsed.pgid };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("the spawn script never wrote a readable record");
  };
  const exited = (child: ChildProcess) =>
    new Promise<NodeJS.Signals | null>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(child.signalCode);
      else child.once("exit", (_code, signal) => resolve(signal));
    });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const stop = (signal: "TERM" | "KILL") => runScript(buildSshRemoteStopScript(runDir, signal));
  const remove = () => runScript(buildSshRunDirRemoveScript(ws, runDir));

  it("stops the group named by a PAR-9960 record, then removes the run dir", async () => {
    const { child, pgid } = await startRun("sleep", ["30"]);
    expect(pgid).toBe(child.pid);

    await expect(stop("TERM")).resolves.toBe("signalled");
    await expect(exited(child)).resolves.toBe("SIGTERM");
    await expect(stop("KILL")).resolves.toBe("gone");

    await expect(remove()).resolves.toBe("removed");
    await expect(stat(runDir)).rejects.toThrow();
    await expect(stat(ws)).resolves.toBeDefined();
    await expect(remove()).resolves.toBe("absent");
  });

  it("sends no signal when the leader start time does not match (reused id)", async () => {
    const { child, pgid } = await startRun("sleep", ["30"]);
    await writeFile(path.join(runDir, "record"), `v=1\npgid=${pgid}\nlstart=Thu Jan  1 00:00:00 1970\n`);
    await expect(stop("KILL")).resolves.toBe("mismatch");
    expect(alive(child.pid!)).toBe(true);
  });

  it("refuses group 0, 1 and its own group", async () => {
    await setup();
    await mkdir(runDir, { recursive: true });
    for (const pgid of ["0", "1"]) {
      await writeFile(path.join(runDir, "record"), `v=1\npgid=${pgid}\nlstart=x\n`);
      await expect(stop("KILL")).resolves.toBe("refused");
    }
    // The stop shell inherits this test process's group.
    const ownGroup = await runScript(`ps -o pgid= -p ${process.pid} | tr -d ' '`);
    await writeFile(path.join(runDir, "record"), `v=1\npgid=${ownGroup}\nlstart=x\n`);
    await expect(stop("KILL")).resolves.toBe("refused");
  });

  it("reports a previous-release run (no record, old files) as missing and a bad record as unreadable", async () => {
    await setup();
    await expect(stop("TERM")).resolves.toBe("missing");
    // The withdrawn TMPDIR layout wrote `pgid` and `lstart` files, never `record`.
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "pgid"), "4242\n");
    await writeFile(path.join(runDir, "lstart"), "x\n");
    await expect(stop("TERM")).resolves.toBe("missing");

    const good = "v=1\npgid=4242\nlstart=Wed Nov 11 22:23:33 2026\n";
    for (const text of [
      good.replace("v=1", "v=2"),
      good.replace("4242", "42a"),
      good.replace("4242", ""),
      "v=1\npgid=4242\nlstart=\n",
      "v=1\npgid=4242\nlstart= x\n",
      good.slice(0, -1),
      `${good}x=1\n`,
      "v=1\nv=1\npgid=4242\n",
      "",
    ]) {
      expect(parseSshRunRecord(text).status).toBe("unreadable");
      await writeFile(path.join(runDir, "record"), text);
      await expect(stop("TERM"), JSON.stringify(text)).resolves.toBe("unreadable");
    }
  });

  it("reports a group whose leader is gone without signalling", async () => {
    // The leader exits but a background child keeps the group alive.
    const { child, pgid } = await startRun("sh", ["-c", "sleep 30 & exit 0"]);
    await exited(child);
    await expect(stop("TERM")).resolves.toBe("leader-gone");
    expect(() => process.kill(-pgid, 0)).not.toThrow();
  });

  it("removes nothing outside <ws>/.paperclip-runs/<name>", async () => {
    await setup();
    const outside = path.join(root, "outside");
    await mkdir(path.join(outside, RUN_ID), { recursive: true });
    await symlink(outside, path.join(ws, ".paperclip-runs"));
    await expect(remove()).resolves.toBe("refused");
    await expect(stat(path.join(outside, RUN_ID))).resolves.toBeDefined();

    await rm(path.join(ws, ".paperclip-runs"));
    await mkdir(path.join(ws, ".paperclip-runs"));
    await symlink(path.join(outside, RUN_ID), runDir);
    await expect(remove()).resolves.toBe("refused");
    await expect(stat(path.join(outside, RUN_ID))).resolves.toBeDefined();

    for (const dir of [`${ws}/.paperclip-runs/..`, `${ws}/.paperclip-runs/`, ws, `${ws}/other/${RUN_ID}`]) {
      await expect(runScript(buildSshRunDirRemoveScript(ws, dir)), dir).resolves.toBe("refused");
    }
    await expect(stat(ws)).resolves.toBeDefined();
  });
});
