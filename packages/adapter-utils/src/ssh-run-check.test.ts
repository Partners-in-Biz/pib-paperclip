import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildSshRunCheckScript, checkRemoteRun, type SshConnectionConfig } from "./ssh.js";

const config: SshConnectionConfig = {
  host: "mac.test", port: 22, username: "max", remoteWorkspacePath: "/Users/max/ws",
  privateKey: null, knownHosts: null, strictHostKeyChecking: true,
};
const runDir = "/Users/max/ws/.paperclip-runs/run-1";
const record = "v=1\npgid=4242\nlstart=Wed Nov 11 22:23:33 2026\n";
const H = "paperclip-run-check 1\n";
const withRecord = (members: number, leader: string, text = record) =>
  `${H}record\n${text}\x1f\npgid=4242\nmembers=${members} total=90\nleader=${leader}\nend\n`;
const now = () => new Date("2026-11-12T10:00:00.000Z");

async function check(stdout: string | Error, lease: Record<string, unknown> = { remoteRunDir: runDir, remoteSpawnStartedAt: "2026-11-12T09:00:00.000Z" }) {
  const run = vi.fn(async () => {
    if (stdout instanceof Error) throw stdout;
    return { stdout, stderr: "" };
  });
  return { result: await checkRemoteRun(config, lease, { run, now }), run };
}

describe("checkRemoteRun decision table", () => {
  it("missing record and no spawn marker is gone/never_spawned", async () => {
    const { result } = await check(`${H}norecord\nend\n`, { remoteRunDir: runDir });
    expect(result).toEqual({ result: "gone", basis: "never_spawned", checkedAt: "2026-11-12T10:00:00.000Z" });
  });

  it("missing or unreadable record with a spawn marker is unknown/no_record", async () => {
    expect((await check(`${H}norecord\nend\n`)).result).toMatchObject({ result: "unknown", basis: "no_record" });
    expect((await check(`${H}record\nv=2\npgid=4242\nlstart=x\n\x1f\nend\n`)).result)
      .toMatchObject({ result: "unknown", basis: "no_record" });
    expect((await check(`${H}record\nv=2\n\x1f\nend\n`, { remoteRunDir: runDir })).result)
      .toMatchObject({ result: "gone", basis: "never_spawned" });
  });

  it("a lease without remoteRunDir is unknown/legacy_lease with no ssh call", async () => {
    const { result, run } = await check(`${H}norecord\nend\n`, { remoteCwd: "/Users/max/ws" });
    expect(result).toMatchObject({ result: "unknown", basis: "legacy_lease" });
    expect(run).not.toHaveBeenCalled();
  });

  it("an empty group is gone/group_empty", async () => {
    expect((await check(withRecord(0, ""))).result)
      .toEqual({ result: "gone", basis: "group_empty", pgid: 4242, checkedAt: "2026-11-12T10:00:00.000Z" });
  });

  it("members live with the leader gone is alive/leader_gone_members_live", async () => {
    expect((await check(withRecord(2, ""))).result)
      .toMatchObject({ result: "alive", basis: "leader_gone_members_live", pgid: 4242 });
  });

  it("the recorded leader still running is alive/leader_live", async () => {
    expect((await check(withRecord(3, "Wed Nov 11 22:23:33 2026"))).result).toMatchObject({
      result: "alive", basis: "leader_live", pgid: 4242, leaderStart: "Wed Nov 11 22:23:33 2026" });
  });

  it("a leader with another start time is gone/group_reused", async () => {
    expect((await check(withRecord(1, "Thu Nov 12 08:00:00 2026"))).result).toMatchObject({
      result: "gone", basis: "group_reused", pgid: 4242, leaderStart: "Thu Nov 12 08:00:00 2026" });
  });

  it("ssh failure, timeout or unparsable output is unknown/check_failed", async () => {
    for (const out of [new Error("ETIMEDOUT"), "", "garbage\n", `${H}record\n${record}\x1f\n`,
      withRecord(1, "x").replace("pgid=4242\nmembers", "pgid=99\nmembers"),
      withRecord(0, "").replace("total=90", "total=0")]) {
      expect((await check(out)).result).toMatchObject({ result: "unknown", basis: "check_failed" });
    }
  });

  it("a remote refusal is unknown/refused", async () => {
    expect((await check(`${H}refused\nend\n`)).result).toMatchObject({ result: "unknown", basis: "refused" });
  });

  it("profile noise before the header is ignored", async () => {
    expect((await check(`welcome\n${withRecord(0, "")}`)).result).toMatchObject({ basis: "group_empty" });
  });

  it.each([
    "/Users/max/ws/../other/run-1",
    "/Users/max/ws-sibling/.paperclip-runs/run-1",
    "/Users/max/ws/./x",
    "/Users/max/ws",
    "relative/run-1",
  ])("refuses %s without an ssh call", async (remoteRunDir) => {
    const { result, run } = await check(`${H}norecord\nend\n`, { remoteRunDir });
    expect(result).toMatchObject({ result: "unknown", basis: "refused" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("check script on a real local shell", () => {
  it("sees a live group as leader_live and a stopped one as group_empty", async () => {
    const ws = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-check-"));
    const rd = path.join(ws, ".paperclip-runs", "run-1");
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      const lstart = execFileSync("ps", ["-o", "lstart=", "-p", String(child.pid)], { env: { ...process.env, LC_ALL: "C" } })
        .toString().trim();
      await mkdir(rd, { recursive: true });
      await writeFile(path.join(rd, "record"), `v=1\npgid=${child.pid}\nlstart=${lstart}\n`);
      const local = { ...config, remoteWorkspacePath: ws };
      const run = async (_c: SshConnectionConfig, script: string) => ({ stdout: execFileSync("sh", ["-c", script]).toString(), stderr: "" });
      expect(await checkRemoteRun(local, { remoteRunDir: rd }, { run })).toMatchObject({ result: "alive", basis: "leader_live", pgid: child.pid });
      process.kill(-child.pid!, "SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      expect(await checkRemoteRun(local, { remoteRunDir: rd }, { run })).toMatchObject({ result: "gone", basis: "group_empty" });
    } finally {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe("buildSshRunCheckScript", () => {
  it("reads the record and probes the group with portable ps forms", async () => {
    const { run } = await check(withRecord(0, ""));
    expect(run).toHaveBeenCalledWith(config, expect.any(String), { timeoutMs: 10_000 });
    const script = buildSshRunCheckScript(config.remoteWorkspacePath, runDir);
    expect(script).toContain("export LC_ALL=C");
    expect(script).toContain('cat "$rd/record"');
    expect(script).toContain("ps -A -o pgid=");
    expect(script).toContain('ps -o lstart= -p "$pg"');
    expect(script).not.toContain("ps -g");
  });
});
