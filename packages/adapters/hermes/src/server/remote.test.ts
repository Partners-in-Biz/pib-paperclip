/**
 * The remote helpers are plain `sh` / `python3` scripts. Here "the remote host"
 * is this machine: the run function spawns the command locally, which is what
 * the ssh driver does on the far side.
 */

import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRemoteSessionReader,
  killRemoteTree,
  removeRemoteDir,
  stageRemoteQuery,
  wrapWithPidFile,
  type RemoteRun,
} from "./remote.js";
import { readSessionLineage } from "./session-metering.js";

const run: RemoteRun = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) =>
      resolve({ exitCode: code, signal, timedOut: false, stdout, stderr, pid: child.pid ?? null, startedAt: "" }),
    );
    child.stdin.on("error", () => undefined); // commands that never read stdin close the pipe
    child.stdin.end(options.stdin ?? "");
  });

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

describe("stageRemoteQuery", () => {
  it("writes the prompt to a private 0600 file in a 0700 dir and removes it", async () => {
    const prompt = "x".repeat(300_000) + "\nsecret-looking $(not run) `nor this`";
    const staged = await stageRemoteQuery(run, prompt);
    cleanup.push(staged.dir);
    expect(await fsp.readFile(staged.queryFile, "utf8")).toBe(prompt);
    expect((await fsp.stat(staged.queryFile)).mode & 0o777).toBe(0o600);
    expect((await fsp.stat(staged.dir)).mode & 0o777).toBe(0o700);
    await removeRemoteDir(run, staged.dir);
    await expect(fsp.stat(staged.dir)).rejects.toThrow();
  });

  it("refuses to delete a directory it did not create", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "not-ours-"));
    cleanup.push(dir);
    await removeRemoteDir(run, dir);
    await expect(fsp.stat(dir)).resolves.toBeTruthy();
  });
});

describe("killRemoteTree", () => {
  it("kills the wrapped command and its children", async () => {
    const staged = await stageRemoteQuery(run, "p");
    cleanup.push(staged.dir);
    const wrapped = wrapWithPidFile(staged.pidFile, "sh", ["-c", "sleep 60 & sleep 60; true"]);
    const child = spawn(wrapped.command, wrapped.args, { stdio: "ignore" });
    const exited = new Promise((resolve) => child.on("close", resolve));
    for (let i = 0; i < 50 && !(await fsp.stat(staged.pidFile).catch(() => null)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const pid = Number((await fsp.readFile(staged.pidFile, "utf8")).trim());
    expect(pid).toBe(child.pid);
    await killRemoteTree(run, staged.pidFile, 0);
    await exited;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("does nothing when there is no pid file", async () => {
    await expect(killRemoteTree(run, "/nonexistent/pid", 0)).resolves.toBeUndefined();
  });
});

describe("remote session reader", () => {
  async function makeHome() {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "par7017-home-"));
    cleanup.push(home);
    const db = new DatabaseSync(path.join(home, "state.db"));
    db.exec(
      "CREATE TABLE sessions (id TEXT, parent_session_id TEXT, source TEXT, input_tokens REAL, output_tokens REAL, cache_read_tokens REAL, cache_write_tokens REAL, estimated_cost_usd REAL, actual_cost_usd REAL)",
    );
    db.prepare("INSERT INTO sessions (id, parent_session_id, input_tokens, output_tokens, estimated_cost_usd) VALUES (?,?,?,?,?)").run("sess_child1", "sess_root01", 5, 6, 0.1);
    db.prepare("INSERT INTO sessions (id, input_tokens, output_tokens, estimated_cost_usd) VALUES (?,?,?,?)").run("sess_root01", 10, 20, 0.2);
    db.close();
    return home;
  }

  it("returns the same rows as the local reader", async () => {
    const home = await makeHome();
    const remote = await readSessionLineage({ HERMES_HOME: home }, "sess_child1", undefined, createRemoteSessionReader(run));
    const local = await readSessionLineage({ HERMES_HOME: home }, "sess_child1");
    expect(remote).toEqual(local);
    expect(remote?.map((r) => r.id)).toEqual(["sess_child1", "sess_root01"]);
  });

  it("stops at the baseline row", async () => {
    const home = await makeHome();
    const rows = await readSessionLineage({ HERMES_HOME: home }, "sess_child1", "sess_child1", createRemoteSessionReader(run));
    expect(rows?.map((r) => r.id)).toEqual(["sess_child1"]);
  });

  it("returns [] for an unknown session and null for a missing store", async () => {
    const home = await makeHome();
    const reader = createRemoteSessionReader(run);
    expect(await readSessionLineage({ HERMES_HOME: home }, "sess_nope01", undefined, reader)).toEqual([]);
    expect(await readSessionLineage({ HERMES_HOME: "/nonexistent-home" }, "sess_child1", undefined, reader)).toBeNull();
  });

  it("rejects ids that are not session ids without running anything", async () => {
    let called = false;
    const reader = createRemoteSessionReader(async (...a) => {
      called = true;
      return run(...a);
    });
    expect(await reader("", "x; rm -rf /")).toBeNull();
    expect(called).toBe(false);
  });
});
