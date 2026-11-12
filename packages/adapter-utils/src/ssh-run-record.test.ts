import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSshSpawnTarget, parseSshRunRecord } from "./ssh.js";

const BASE_SCRIPT = [
  'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
  'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
  'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
  'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
  "cd '/srv/ws'",
  "exec env FOO='bar' 'node' '--version'",
].join(" && ");

function spec(ws: string) {
  return {
    host: "ssh.example.test",
    port: 22,
    username: "u",
    remoteCwd: ws,
    remoteWorkspacePath: ws,
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: true,
  };
}

async function remoteScript(ws: string, remoteRunDir?: string, command = "node", args = ["--version"]) {
  const target = await buildSshSpawnTarget({ spec: spec(ws), command, args, env: { FOO: "bar" }, remoteRunDir });
  await target.cleanup();
  return String(target.args.at(-1));
}

describe("buildSshSpawnTarget run record script", () => {
  it("leaves the script byte-for-byte unchanged without remoteRunDir", async () => {
    expect(await remoteScript("/srv/ws")).toBe(`sh -c '${BASE_SCRIPT.replace(/'/g, `'"'"'`)}'`);
  });

  it("adds confinement, umask, mkdir, the atomic write and the exclude line before exec", async () => {
    const script = await remoteScript("/srv/ws", "/srv/ws/.paperclip-runs/run-1");
    for (const part of ["refuse", "exit 125", "umask 077", "mkdir -p", "record.tmp.$$", "mv -f", "/.paperclip-runs/", "info/exclude", "LC_ALL=C"]) {
      expect(script).toContain(part);
    }
    expect(script.indexOf("umask 077")).toBeLessThan(script.indexOf("exec env"));
  });
});

describe("run record script executed by a local sh", () => {
  let root: string;
  let ws: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ssh-run-record-")));
    ws = path.join(root, "ws");
    mkdirSync(ws);
    mkdirSync(path.join(root, "home"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function run(remoteRunDir: string) {
    const script = await remoteScript(ws, remoteRunDir, "sh", ["-c", "echo ran"]);
    return spawnSync("sh", ["-c", script], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(root, "home") },
      encoding: "utf8",
    });
  }

  it("writes a readable 0700 record, then execs, and adds the git exclude once", async () => {
    execFileSync("git", ["init", "-q", ws]);
    const rd = path.join(ws, ".paperclip-runs", "run-1");
    for (let i = 0; i < 2; i += 1) {
      const result = await run(rd);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("ran\n");
    }
    expect(statSync(rd).mode & 0o777).toBe(0o700);
    const parsed = parseSshRunRecord(readFileSync(path.join(rd, "record"), "utf8"));
    expect(parsed.status).toBe("readable");
    const exclude = readFileSync(path.join(ws, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === "/.paperclip-runs/")).toHaveLength(1);
    expect(readdirSync(rd)).toEqual(["record"]);
  });

  it("skips the exclude silently when the workspace is not a git top level", async () => {
    const result = await run(path.join(ws, ".paperclip-runs", "run-1"));
    expect(result.status).toBe(0);
    expect(existsSync(path.join(ws, ".git"))).toBe(false);
  });

  it.each([
    ["dot-dot", (ws: string) => `${ws}/.paperclip-runs/../../escape`],
    ["sibling with the same prefix", (ws: string) => `${ws}-other/.paperclip-runs/run-1`],
    ["relative", () => "ws/.paperclip-runs/run-1"],
    ["the workspace itself", (ws: string) => ws],
  ])("refuses a run dir outside the workspace (%s) before mkdir", async (_name, dir) => {
    const result = await run(dir(ws));
    expect(result.status).toBe(125);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(existsSync(path.join(root, "escape"))).toBe(false);
    expect(existsSync(`${ws}-other`)).toBe(false);
  });

  it("refuses a run dir that escapes through a symlink before mkdir", async () => {
    mkdirSync(path.join(root, "outside"));
    symlinkSync(path.join(root, "outside"), path.join(ws, ".paperclip-runs"));
    const result = await run(path.join(ws, ".paperclip-runs", "run-1"));
    expect(result.status).toBe(125);
    expect(existsSync(path.join(root, "outside", "run-1"))).toBe(false);
  });
});

describe("parseSshRunRecord", () => {
  const good = "v=1\npgid=4242\nlstart=Wed Nov 11 22:23:33 2026\n";

  it("accepts the three-line record", () => {
    expect(parseSshRunRecord(good)).toEqual({ status: "readable", pgid: 4242, lstart: "Wed Nov 11 22:23:33 2026" });
  });

  it.each([
    ["missing v", "pgid=4242\nlstart=x\n"],
    ["missing pgid", "v=1\nlstart=x\n"],
    ["missing lstart", "v=1\npgid=4242\n"],
    ["unknown v", good.replace("v=1", "v=2")],
    ["pgid not an integer", good.replace("4242", "42a")],
    ["pgid negative", good.replace("4242", "-5")],
    ["pgid 1", good.replace("4242", "1")],
    ["pgid 0", good.replace("4242", "0")],
    ["pgid empty", good.replace("4242", "")],
    ["empty lstart", "v=1\npgid=4242\nlstart=\n"],
    ["blank lstart", "v=1\npgid=4242\nlstart=   \n"],
    ["no final newline", good.slice(0, -1)],
    ["extra line", `${good}x=1\n`],
    ["duplicate key", "v=1\nv=1\npgid=4242\n"],
    ["empty", ""],
    ["not a string", 42],
  ])("reports %s as unreadable", (_name, text) => {
    expect(parseSshRunRecord(text)).toEqual({ status: "unreadable" });
  });
});
