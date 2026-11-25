import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { childArgv, startFfmpeg } from "../src/ml/io.js";
import { RUNNER_SLOTS, Semaphore, runnerSlots, startRunner } from "../src/ml/slots.js";
import { CANCEL_GRACE_MS, containedArgv, containedEnv, killIfOurs, pidsInGroup, runContained } from "../src/video-edit/ffmpeg.js";

function fakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & { pid: number; stdin: PassThrough; stderr: PassThrough; stdout: PassThrough };
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.stdout = new PassThrough();
  return child;
}

const RUNNER = "/srv/studio/dist/ml/runner.mjs";

describe("runContained tool node", () => {
  it("wraps process.execPath and runner.mjs in timeout, prlimit and nice (golden argv)", () => {
    expect(containedArgv(["track", "/w/r-1"], { tool: "node", runnerPath: RUNNER, timeoutSec: 300 })).toEqual([
      "/usr/bin/timeout", "-k", "30", "300",
      "/usr/bin/prlimit", "--as=6442450944", "--fsize=209715200", "--",
      "/usr/bin/nice", "-n", "10",
      process.execPath, RUNNER, "track", "/w/r-1",
    ]);
  });

  it("leaves the ffmpeg and ffprobe argv unchanged (golden)", () => {
    const line = ["/usr/bin/timeout", "-k", "30", "1200", "/usr/bin/prlimit", "--as=6442450944", "--fsize=209715200", "--", "/usr/bin/nice", "-n", "10"];
    expect(containedArgv(["-i", "/x"])).toEqual([...line, "ffmpeg", "-nostdin", "-hide_banner", "-threads", "4", "-i", "/x"]);
    expect(containedArgv(["-i", "/x"], { tool: "ffprobe" })).toEqual([...line, "ffprobe", "-hide_banner", "-i", "/x"]);
  });

  it("gives node PATH, LANG and PIB_ML_* only, never a secret", () => {
    const from = { PATH: "/usr/bin", LANG: "C.UTF-8", PIB_ML_THREADS: "4", PAPERCLIP_API_KEY: "secret", NODE_OPTIONS: "--require x", HOME: "/home/p", AWS_SECRET_ACCESS_KEY: "s" };
    expect(containedEnv({ tool: "node", env: { PIB_ML_MODE: "track" } }, from)).toEqual({ PATH: "/usr/bin", LANG: "C.UTF-8", PIB_ML_THREADS: "4", PIB_ML_MODE: "track" });
    expect(() => containedEnv({ tool: "node", env: { NODE_OPTIONS: "--inspect" } }, from)).toThrow(/not allowed/);
    expect(containedEnv({}, from)).toEqual({ PATH: "/usr/bin", LC_ALL: "C", MALLOC_ARENA_MAX: "4" });
    expect(() => containedEnv({ tool: "ffmpeg", env: { PIB_ML_X: "1" } }, from)).toThrow();
  });

  it("spawns detached with the allowlisted env", async () => {
    vi.stubEnv("PIB_TEST_SECRET", "nope");
    vi.stubEnv("PIB_ML_DEBUG", "1");
    try {
      const child = fakeChild(5151);
      const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
      const run = runContained(["--selftest"], { tool: "node", runnerPath: RUNNER, spawnImpl, killImpl: vi.fn() });
      const [cmd, args, opts] = spawnImpl.mock.calls[0] as unknown as [string, string[], { detached: boolean; env: Record<string, string> }];
      expect(cmd).toBe("/usr/bin/timeout");
      expect(args.slice(-3)).toEqual([process.execPath, RUNNER, "--selftest"]);
      expect(opts.detached).toBe(true);
      expect(opts.env.PIB_ML_DEBUG).toBe("1");
      expect(Object.keys(opts.env).every((k) => k === "PATH" || k === "LANG" || k.startsWith("PIB_ML_"))).toBe(true);
      child.emit("close", 0, null);
      expect((await run.done).outcome).toBe("ok");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("ml/io runner-side ffmpeg", () => {
  it("starts each child under its own prlimit (golden argv)", () => {
    expect(childArgv(["-i", "/w/in.mp4", "-f", "rawvideo", "pipe:1"])).toEqual([
      "/usr/bin/prlimit", "--as=2147483648", "--fsize=209715200", "--", "ffmpeg", "-hide_banner", "-i", "/w/in.mp4", "-f", "rawvideo", "pipe:1",
    ]);
    expect(() => childArgv([], { asLimitBytes: 0 })).toThrow();
  });

  it("is not detached, so it stays in the runner's process group", async () => {
    const child = fakeChild(6161);
    const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
    const ff = startFfmpeg(["-i", "pipe:0", "-f", "null", "-"], { stdin: true, spawnImpl });
    const [cmd, , opts] = spawnImpl.mock.calls[0] as unknown as [string, string[], { detached: boolean; stdio: string[] }];
    expect(cmd).toBe("/usr/bin/prlimit");
    expect(opts.detached).toBe(false);
    expect(opts.stdio).toEqual(["pipe", "ignore", "pipe"]);
    child.stderr.write("boom");
    child.emit("close", 1, null);
    expect(await ff.done).toMatchObject({ exitCode: 1, stderrTail: "boom" });
  });
});

describe("ml/slots", () => {
  it("has one shared semaphore of 2", () => {
    expect(RUNNER_SLOTS).toBe(2);
    expect(runnerSlots).toBeInstanceOf(Semaphore);
  });

  it("makes a third runner start wait until one ends", async () => {
    const slots = new Semaphore(RUNNER_SLOTS);
    const children = [fakeChild(7001), fakeChild(7002), fakeChild(7003)];
    let n = 0;
    const spawnImpl = vi.fn(() => children[n++] as unknown as ChildProcess);
    const opts = { runnerPath: RUNNER, spawnImpl, killImpl: vi.fn(), slots };
    const a = await startRunner(["track"], opts);
    const b = await startRunner(["matte"], opts);
    let third: Awaited<ReturnType<typeof startRunner>> | null = null;
    const c = startRunner(["track"], opts).then((h) => (third = h));
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(third).toBeNull();
    expect(slots.waiting).toBe(1);
    children[0]!.emit("close", 0, null);
    await a.done;
    await c;
    expect(spawnImpl).toHaveBeenCalledTimes(3);
    expect(third!.pgid).toBe(7003);
    expect(slots.active).toBe(2);
    children[1]!.emit("close", 0, null);
    children[2]!.emit("close", 0, null);
    await Promise.all([b.done, third!.done]);
    expect(slots.active).toBe(0);
  });

  it("an aborted waiter leaves the queue; a failed start frees its slot", async () => {
    const slots = new Semaphore(1);
    const hold = slots.tryAcquire()!;
    expect(slots.tryAcquire()).toBeNull();
    const ac = new AbortController();
    const waiter = slots.acquire(ac.signal);
    ac.abort(new Error("cancelled"));
    await expect(waiter).rejects.toThrow("cancelled");
    expect(slots.waiting).toBe(0);
    hold();
    hold();
    expect(slots.active).toBe(0);
    await expect(startRunner([], { runnerPath: RUNNER, slots, env: { BAD: "1" } })).rejects.toThrow(/not allowed/);
    expect(slots.active).toBe(0);
  });
});

describe("killIfOurs", () => {
  let proc: string;
  beforeAll(async () => {
    proc = await mkdtemp(join(tmpdir(), "studio-ml-proc-"));
    await mkdir(join(proc, "4321"));
    await writeFile(join(proc, "4321", "cmdline"), ["/usr/bin/timeout", "-k", "30", process.execPath, "/d/runner.mjs", "matte", "/var/studio/r-abcd/in.mp4", ""].join("\0"));
  });
  afterAll(async () => {
    await rm(proc, { recursive: true, force: true });
  });

  it("kills the group only when the cmdline names the work folder", async () => {
    const killImpl = vi.fn();
    expect(await killIfOurs(4321, "/var/studio/r-abcd", { procRoot: proc, killImpl })).toBe(true);
    expect(killImpl).toHaveBeenCalledWith(-4321, "SIGKILL");
  });

  it("does not kill on a mismatching cmdline, a prefix-only match, a gone pid or a short path", async () => {
    const killImpl = vi.fn();
    expect(await killIfOurs(4321, "/var/studio/r-other", { procRoot: proc, killImpl })).toBe(false);
    expect(await killIfOurs(4321, "/var/studio/r-abc", { procRoot: proc, killImpl })).toBe(false);
    expect(await killIfOurs(9999, "/var/studio/r-abcd", { procRoot: proc, killImpl })).toBe(false);
    expect(await killIfOurs(4321, "/var", { procRoot: proc, killImpl })).toBe(false);
    expect(await killIfOurs(1, "/var/studio/r-abcd", { procRoot: proc, killImpl })).toBe(false);
    expect(killImpl).not.toHaveBeenCalled();
  });
});

const hasFfmpeg = ["/usr/bin/timeout", "/usr/bin/prlimit", "/usr/bin/nice", "/usr/bin/pgrep"].every(existsSync) && spawnSync("ffmpeg", ["-version"]).status === 0;

/** `pgrep -g <pgid>` output, after up to 3 s for the reaper. */
async function pgrepGroup(pgid: number, wantEmpty = true): Promise<string> {
  let out = "";
  for (let i = 0; i < 30; i++) {
    out = spawnSync("/usr/bin/pgrep", ["-g", String(pgid)], { encoding: "utf8" }).stdout.trim();
    if (!out === wantEmpty) return out;
    await new Promise((r) => setTimeout(r, 100));
  }
  return out;
}

describe.skipIf(!hasFfmpeg)("runner containment (real processes, pib-vps)", () => {
  let dir: string;
  let runnerPath: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-ml-t2-"));
    runnerPath = join(dir, "ml-pipe-runner.mjs");
    await esbuild.build({
      entryPoints: [fileURLToPath(new URL("./fixtures/ml-pipe-runner.ts", import.meta.url))],
      outfile: runnerPath,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      logLevel: "silent",
    });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Waits until the group holds timeout, the runner and both ffmpeg children. */
  async function fullGroup(pgid: number): Promise<number[]> {
    let pids: number[] = [];
    for (let i = 0; i < 100 && pids.length < 4; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pids = await pidsInGroup(pgid);
    }
    const names = await Promise.all(pids.map(async (p) => `${p}:${(await readFile(`/proc/${p}/comm`, "utf8").catch(() => "?")).trim()}`));
    console.log(`[T2] pgid ${pgid} before: ${names.join(" ")}`);
    expect(pids).toHaveLength(4);
    return pids;
  }

  it("(a) a 2 s timeout ends the runner and both ffmpeg children: pgrep -g empty", async () => {
    const run = await startRunner([dir], { runnerPath, timeoutSec: 2 });
    await fullGroup(run.pgid);
    const res = await run.done;
    const left = await pgrepGroup(run.pgid);
    console.log(`[T2](a) argv: ${run.argv.join(" ")}\n[T2](a) outcome=${res.outcome} exit=${res.exitCode} ms=${res.durationMs}; pgrep -g ${run.pgid}: "${left}"`);
    expect(res.outcome).toBe("timeout");
    expect(left).toBe("");
  }, 30_000);

  it("(b) cancel kills all three within the 10 s grace", async () => {
    const run = await startRunner([dir], { runnerPath, timeoutSec: 120 });
    await fullGroup(run.pgid);
    const t0 = Date.now();
    run.cancel();
    const res = await run.done;
    const left = await pgrepGroup(run.pgid);
    const ms = Date.now() - t0;
    console.log(`[T2](b) outcome=${res.outcome} cancel-to-empty ms=${ms}; pgrep -g ${run.pgid}: "${left}"`);
    expect(res.outcome).toBe("cancelled");
    expect(left).toBe("");
    expect(ms).toBeLessThan(CANCEL_GRACE_MS);
  }, 30_000);

  it("(c) runner SIGKILLed while its children write to pipes: after the final group kill pgrep -g is empty", async () => {
    const run = await startRunner([dir], { runnerPath, timeoutSec: 120 });
    const pids = await fullGroup(run.pgid);
    const cmdlines = await Promise.all(pids.map(async (p) => [p, await readFile(`/proc/${p}/cmdline`, "utf8")] as const));
    const runner = cmdlines.find(([p, c]) => p !== run.pgid && c.startsWith(`${process.execPath}\0`))![0];
    await new Promise((r) => setTimeout(r, 500));
    process.kill(runner, "SIGKILL");
    const res = await run.done;
    const left = await pgrepGroup(run.pgid);
    console.log(`[T2](c) runner ${runner} SIGKILLed; outcome=${res.outcome} exit=${res.exitCode}; pgrep -g ${run.pgid}: "${left}"`);
    expect(left).toBe("");
  }, 30_000);

  it("killIfOurs kills a live runner group only for its own work folder", async () => {
    const run = runContained([dir], { tool: "node", runnerPath, timeoutSec: 120 });
    await fullGroup(run.pgid);
    expect(await killIfOurs(run.pgid, join(tmpdir(), "studio-ml-other"))).toBe(false);
    expect(await pgrepGroup(run.pgid, false)).not.toBe("");
    expect(await killIfOurs(run.pgid, dir)).toBe(true);
    await run.done;
    const left = await pgrepGroup(run.pgid);
    console.log(`[T2] killIfOurs(${run.pgid}, workdir): pgrep -g ${run.pgid}: "${left}"`);
    expect(left).toBe("");
  }, 30_000);
});
