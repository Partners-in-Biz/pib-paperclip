import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyExit, containedArgv, DEFAULT_AS_LIMIT_BYTES, FSIZE_BYTES, pidsInGroup, runContained, Tail } from "../src/video-edit/ffmpeg.js";
import { parseProbe, probeArgs, probeMedia } from "../src/video-edit/probe.js";
import { assertDiskSpace, downloadToWorkdir, MIN_FREE_BYTES, rendersRoot, sweepRenderWorkdirs, withRenderWorkdir } from "../src/video-edit/workdir.js";

function fakeChild(pid = 4242) {
  const child = new EventEmitter() as EventEmitter & { pid: number; stderr: PassThrough; stdout: PassThrough };
  child.pid = pid;
  child.stderr = new PassThrough();
  child.stdout = new PassThrough();
  return child;
}

function mocked(pid = 4242) {
  const child = fakeChild(pid);
  const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
  const killImpl = vi.fn();
  return { child, spawnImpl, killImpl };
}

describe("containedArgv", () => {
  it("wraps ffmpeg in timeout, prlimit and nice, as one args array", () => {
    expect(containedArgv(["-i", "/x.mp4", "/y.mp4"])).toEqual([
      "/usr/bin/timeout", "-k", "30", "1200",
      "/usr/bin/prlimit", `--as=${DEFAULT_AS_LIMIT_BYTES}`, `--fsize=${FSIZE_BYTES}`, "--",
      "/usr/bin/nice", "-n", "10",
      "ffmpeg", "-nostdin", "-hide_banner", "-threads", "4", "-i", "/x.mp4", "/y.mp4",
    ]);
    expect(DEFAULT_AS_LIMIT_BYTES).toBe(6 * 1024 ** 3);
    expect(FSIZE_BYTES).toBe(209715200);
  });
  it("takes a configurable AS limit and refuses a bad one", () => {
    expect(containedArgv([], { asLimitBytes: 1024 })).toContain("--as=1024");
    expect(() => containedArgv([], { asLimitBytes: -1 })).toThrow();
    expect(() => containedArgv([], { asLimitBytes: 1.5 })).toThrow();
  });
  it("uses ffprobe for probes", () => {
    const argv = containedArgv(["-i", "/x"], { tool: "ffprobe" });
    expect(argv.slice(11, 13)).toEqual(["ffprobe", "-hide_banner"]);
    expect(argv).not.toContain("-threads");
  });
});

describe("classifyExit", () => {
  const base = { exitCode: null, signal: null, cancelled: false, stderrTail: "" };
  it("sorts exits", () => {
    expect(classifyExit({ ...base, exitCode: 0 })).toBe("ok");
    expect(classifyExit({ ...base, exitCode: 124 })).toBe("timeout");
    expect(classifyExit({ ...base, signal: "SIGKILL", pastDeadline: true })).toBe("timeout");
    expect(classifyExit({ ...base, signal: "SIGKILL" })).toBe("rlimit");
    expect(classifyExit({ ...base, signal: "SIGXFSZ" })).toBe("rlimit");
    expect(classifyExit({ ...base, exitCode: 153 })).toBe("rlimit");
    expect(classifyExit({ ...base, exitCode: 1, stderrTail: "av_write_frame: File too large" })).toBe("rlimit");
    expect(classifyExit({ ...base, exitCode: 1, stderrTail: "Invalid data found" })).toBe("nonzero");
    expect(classifyExit({ ...base, exitCode: 0, cancelled: true })).toBe("cancelled");
  });
});

describe("Tail", () => {
  it("keeps only the last bytes", () => {
    const t = new Tail(4096);
    for (let i = 0; i < 100; i++) t.push(Buffer.from(`${String(i).padStart(3, "0")}${"x".repeat(97)}`));
    expect(t.bytes).toBe(4096);
    expect(t.toString().endsWith(`099${"x".repeat(97)}`)).toBe(true);
  });
});

describe("runContained (mocked spawn)", () => {
  it("spawns detached with a clean env and no shell", async () => {
    const { child, spawnImpl, killImpl } = mocked();
    const run = runContained(["-version"], { spawnImpl, killImpl });
    const [cmd, args, opts] = spawnImpl.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe("/usr/bin/timeout");
    expect(args[0]).toBe("-k");
    expect(opts.detached).toBe(true);
    expect(opts.shell).toBeUndefined();
    expect(Object.keys(opts.env as object).sort()).toEqual(["LC_ALL", "MALLOC_ARENA_MAX", "PATH"]);
    expect(run.pgid).toBe(4242);
    child.stderr.write("ffmpeg version 6.1\n");
    child.emit("close", 0, null);
    const res = await run.done;
    expect(res.outcome).toBe("ok");
    expect(res.stderrTail).toContain("6.1");
    // the group gets a final SIGKILL so nothing in it outlives the run
    expect(killImpl).toHaveBeenCalledWith(-4242, "SIGKILL");
  });

  it("cancel sends SIGTERM to the group, then SIGKILL after 10 s", async () => {
    vi.useFakeTimers();
    try {
      const { child, spawnImpl, killImpl } = mocked(777);
      const run = runContained([], { spawnImpl, killImpl });
      run.cancel();
      expect(killImpl).toHaveBeenCalledWith(-777, "SIGTERM");
      expect(killImpl).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(9_999);
      expect(killImpl).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(killImpl).toHaveBeenLastCalledWith(-777, "SIGKILL");
      child.emit("close", null, "SIGKILL");
      expect((await run.done).outcome).toBe("cancelled");
      for (const [pid] of killImpl.mock.calls) expect(pid).toBe(-777);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never signals pid 0/1 or a positive pid, and ignores ESRCH", async () => {
    const { child, spawnImpl } = mocked(0);
    const killImpl = vi.fn(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const run = runContained([], { spawnImpl, killImpl });
    run.cancel();
    child.emit("close", 0, null);
    await run.done;
    expect(killImpl).not.toHaveBeenCalled();

    const m = mocked(55);
    const run2 = runContained([], { spawnImpl: m.spawnImpl, killImpl });
    m.child.emit("close", 1, null);
    expect((await run2.done).outcome).toBe("nonzero");
    expect(killImpl).toHaveBeenCalledWith(-55, "SIGKILL");
  });

  it("reports a spawn error as nonzero", async () => {
    const { child, spawnImpl, killImpl } = mocked();
    const run = runContained([], { spawnImpl, killImpl });
    child.emit("error", new Error("ENOENT"));
    const res = await run.done;
    expect(res.outcome).toBe("nonzero");
    expect(res.stderrTail).toContain("spawn failed");
  });

  it("probeMedia parses stdout and hides the signed URL in errors", async () => {
    const { child, spawnImpl, killImpl } = mocked();
    const url = "https://acct.r2.cloudflarestorage.com/b/studio/x.mp4?X-Amz-Signature=secret";
    const p = probeMedia(url, { spawnImpl, killImpl });
    const args = (spawnImpl.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).toContain("https,tls,tcp");
    child.stderr.write(`${url}: Server returned 403 Forbidden`);
    child.emit("close", 1, null);
    const err = await p.catch((e: Error) => e);
    expect(String(err)).not.toContain("secret");
    expect(String(err)).toContain("<input>");
  });
});

describe("probe parsing", () => {
  it("reads duration, size, fps, codecs and audio", () => {
    const r = parseProbe(JSON.stringify({
      format: { duration: "3.5", format_name: "mov,mp4", size: "1000" },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30000/1001" },
        { codec_type: "audio", codec_name: "aac" },
      ],
    }));
    expect(r).toMatchObject({ durationSec: 3.5, width: 1080, height: 1920, fps: 29.97, videoCodec: "h264", audioCodec: "aac", hasAudio: true, hasVideo: true, sizeBytes: 1000 });
  });
  it("treats a cover picture as no video, and refuses empty data", () => {
    const r = parseProbe(JSON.stringify({ format: { duration: "10" }, streams: [{ codec_type: "audio", codec_name: "mp3" }, { codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } }] }));
    expect(r.hasVideo).toBe(false);
    expect(r.width).toBeNull();
    expect(() => parseProbe("not json")).toThrow(/readable/);
    expect(() => parseProbe(JSON.stringify({ streams: [] }))).toThrow();
  });
  it("only takes an absolute path or https", () => {
    expect(probeArgs("/a/b.mp4")).toContain("file:/a/b.mp4");
    expect(() => probeArgs("http://x/y")).toThrow();
    expect(() => probeArgs("rel.mp4")).toThrow();
    expect(() => probeArgs("concat:/a|/b")).toThrow();
  });
});

describe("render workdir", () => {
  let home: string;
  const prev = process.env.PAPERCLIP_HOME;
  const prevWorkdir = process.env.PIB_STUDIO_WORKDIR;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "studio-a6-"));
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PIB_STUDIO_WORKDIR;
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = prev;
    if (prevWorkdir !== undefined) process.env.PIB_STUDIO_WORKDIR = prevWorkdir;
    await rm(home, { recursive: true, force: true });
  });

  const GB = 1024 ** 3;
  const disk = (freeBytes: number) => async () => ({ bavail: freeBytes / 4096, bsize: 4096 });

  it("needs 8 GB free and 4x the input", async () => {
    await expect(assertDiskSpace("/", 0, disk(MIN_FREE_BYTES - 4096))).rejects.toMatchObject({ code: "disk_low" });
    await expect(assertDiskSpace("/", 0, disk(MIN_FREE_BYTES))).resolves.toBe(MIN_FREE_BYTES);
    await expect(assertDiskSpace("/", 3 * GB, disk(10 * GB))).rejects.toMatchObject({ code: "disk_low" });
    await expect(assertDiskSpace("/", 2 * GB, disk(10 * GB))).resolves.toBe(10 * GB);
  });

  it("makes a private folder under <localRoot>/renders and removes it even on failure", async () => {
    expect(rendersRoot().startsWith(home)).toBe(true);
    let seen = "";
    await expect(withRenderWorkdir("rnd_1", 10, async (dir) => {
      seen = dir;
      await writeFile(join(dir, "out.mp4"), "x");
      throw new Error("boom");
    }, disk(20 * GB))).rejects.toThrow("boom");
    expect(seen.startsWith(join(rendersRoot(), "r-rnd_1-"))).toBe(true);
    expect(existsSync(seen)).toBe(false);
    expect((await stat(rendersRoot())).mode & 0o777).toBe(0o700);
    await expect(withRenderWorkdir("../x", 0, async () => 1, disk(20 * GB))).rejects.toMatchObject({ code: "unsafe_key" });
    await expect(withRenderWorkdir("ok", 0, async () => 1, disk(1 * GB))).rejects.toMatchObject({ code: "disk_low" });
  });

  it("sweeps old folders but not ones a live process names", async () => {
    const root = rendersRoot();
    const old = join(root, "r-old-aaaaaa");
    const busy = join(root, "r-busy-bbbbbb");
    const fresh = join(root, "r-new-cccccc");
    for (const d of [old, busy, fresh]) await mkdir(d, { recursive: true });
    const past = new Date(Date.now() - 5 * 3600_000);
    await utimes(old, past, past);
    await utimes(busy, past, past);
    const proc = join(home, "proc");
    await mkdir(join(proc, "123"), { recursive: true });
    await writeFile(join(proc, "123", "cmdline"), `ffmpeg\0-i\0${busy}/in.mp4\0`);
    expect(await sweepRenderWorkdirs(undefined, undefined, proc)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(busy)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  it("downloads a signed GET to disk with a byte cap", async () => {
    const dir = await mkdtemp(join(home, "dl-"));
    const ok = vi.fn(async () => new Response(new Uint8Array(10)));
    expect(await downloadToWorkdir("https://x/y", dir, "in.mp4", 100, ok as unknown as typeof fetch)).toEqual({ path: join(dir, "in.mp4"), bytes: 10 });
    const big = vi.fn(async () => new Response(new Uint8Array(200)));
    await expect(downloadToWorkdir("https://x/y", dir, "big.mp4", 100, big as unknown as typeof fetch)).rejects.toMatchObject({ code: "too_large" });
    expect(existsSync(join(dir, "big.mp4"))).toBe(false);
    await expect(downloadToWorkdir("https://x/y", dir, "../e.mp4", 100, ok as unknown as typeof fetch)).rejects.toMatchObject({ code: "unsafe_key" });
    const bad = vi.fn(async () => new Response("no", { status: 403 }));
    await expect(downloadToWorkdir("https://x/y", dir, "c.mp4", 100, bad as unknown as typeof fetch)).rejects.toThrow("HTTP 403");
  });
});

// Real ffmpeg: runs on the pib-vps self-hosted plugins CI, skipped where ffmpeg/timeout/prlimit are missing.
const hasFfmpeg = ["/usr/bin/timeout", "/usr/bin/prlimit", "/usr/bin/nice"].every(existsSync) && spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("runContained (real ffmpeg)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-a6-ff-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const endless = ["-f", "lavfi", "-re", "-i", "testsrc=size=320x240:rate=25", "-f", "null", "-"];

  it("renders and probes a testsrc + sine clip", async () => {
    const out = join(dir, "clip.mp4");
    const res = await runContained(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", "-shortest", out]).done;
    expect(res.outcome, res.stderrTail).toBe("ok");
    const p = await probeMedia(out);
    expect(p).toMatchObject({ width: 320, height: 240, fps: 25, videoCodec: "h264", audioCodec: "aac", hasAudio: true });
    expect(p.durationSec).toBeGreaterThan(0.9);
  }, 60_000);

  it("timeout kills a run that runs too long, and leaves no process", async () => {
    const run = runContained(endless, { timeoutSec: 2, killAfterSec: 1 });
    const res = await run.done;
    expect(res.outcome).toBe("timeout");
    expect(res.durationMs).toBeLessThan(10_000);
    expect(await pidsInGroup(run.pgid)).toEqual([]);
  }, 30_000);

  it("FSIZE kills a forced large output", async () => {
    const out = join(dir, "big.raw");
    const run = runContained(["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25", "-t", "60", "-f", "rawvideo", "-y", out], { fsizeBytes: 5_000_000 });
    const res = await run.done;
    expect(res.outcome, `${res.exitCode} ${res.signal} ${res.stderrTail}`).toBe("rlimit");
    expect((await stat(out)).size).toBeLessThanOrEqual(5_000_000);
    expect(await pidsInGroup(run.pgid)).toEqual([]);
  }, 30_000);

  it("cancel kills the whole process group (checked in /proc)", async () => {
    const run = runContained(endless, { timeoutSec: 120 });
    let pids: number[] = [];
    for (let i = 0; i < 50 && pids.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pids = await pidsInGroup(run.pgid);
    }
    expect(pids).toContain(run.pgid);
    expect(pids.length).toBeGreaterThanOrEqual(2); // timeout + ffmpeg
    run.cancel();
    const res = await run.done;
    expect(res.outcome).toBe("cancelled");
    expect(await pidsInGroup(run.pgid)).toEqual([]);
  }, 30_000);
});
