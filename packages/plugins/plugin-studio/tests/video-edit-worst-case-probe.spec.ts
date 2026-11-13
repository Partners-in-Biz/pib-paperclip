// Worst-case render probe (PAR-11243, plan PAR-11146 T1). Opt-in: set STUDIO_WORST_CASE=1 on pib-vps.
// Measures a render by sampling only the render's own process group, so other tenants of the box do not count as ours.
//
//   STUDIO_WORST_CASE=1                    run the probe (CI never does)
//   STUDIO_WORST_CASE_VARIANTS=both,key    comma list of base,key,mult,both (default: all four)
//   STUDIO_WORST_CASE_SECONDS=30           seconds per clip; the edit is 6 clips (default 30 = the 180 s edit; 5 = scaled)
//   STUDIO_WORST_CASE_SILENT=1             sources without sound
//   STUDIO_WORST_CASE_SPLIT=1              per intermediate pass: decode+filter cost, encode cost, intermediate decode cost
//   STUDIO_WORST_CASE_DIR=<dir>            scratch folder (default $PAPERCLIP_SCRATCH_DIR or the OS temp dir)
//   STUDIO_WORST_CASE_DEADLINE_SEC=3600    render deadline (production uses TIMEOUT_SEC)
//   STUDIO_WORST_CASE_OUT=<file>           also append the JSON lines to this file
//
// Chunk passes of one level run side by side: one sampler per process group, foreign load subtracts every live group.
// The sampler and its stub-/proc unit test are not behind the flag: they run in the normal suite.
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, linkSync, mkdirSync, appendFileSync, readdirSync, rmSync, mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { pidsInGroup } from "../src/video-edit/ffmpeg.js";
import { probeMedia } from "../src/video-edit/probe.js";
import { planRender } from "../src/video-edit/render-plan.js";
import { renderPasses } from "../src/video-edit/render-pipeline.js";
import { normalizeEdit } from "../src/video-edit/timeline.js";
import { pipTransform } from "../src/ui/editor/layer-panel.js";

// ---------------------------------------------------------------------------------------------------------------
// Sampler: reads only the pids of one process group, plus the machine-wide busy jiffies for the foreign-load figure.
// ---------------------------------------------------------------------------------------------------------------

export interface SamplerOptions {
  /** Root of the proc filesystem; a stub folder in tests. */
  procRoot?: string;
  /** Clock ticks per second (`getconf CLK_TCK`). */
  clkTck?: number;
  /** Poll period; 0 = no timer, call `sample()` yourself (tests). */
  intervalMs?: number;
  /** Seconds clock; injectable for tests. */
  now?: () => number;
  /**
   * Own jiffies of EVERY group of the render, this one included. With two passes live at once, the load of the other
   * group is not foreign: foreign load over this window is busy minus the growth of this sum. Default: this group only.
   */
  ownAll?: () => number;
}

export interface SampleResult {
  wallSec: number;
  /** utime + stime of every pid ever seen in the group (last value per pid, summed), in seconds. */
  cpuSec: number;
  /** Highest VmPeak of any one process of the group, MiB. */
  vmPeakMiB: number;
  /** Highest VmHWM (peak resident) of any one process of the group, MiB. */
  rssMiB: number;
  /** Cores of non-group load on the machine over the window. */
  foreignCores: number;
  /** Raw counters for combining windows. */
  ownJiffies: number;
  busyJiffies: number;
  /** busy - the growth of every live group of the render, over this window. */
  foreignJiffies: number;
  pids: number;
}

export function clkTck(): number {
  const r = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) && n > 0 ? n : 100;
}

/** user + nice + system + irq + softirq + steal of the aggregate "cpu" line of /proc/stat. */
export async function busyJiffies(procRoot = "/proc"): Promise<number> {
  const text = await readFile(`${procRoot}/stat`, "utf8");
  const line = text.split("\n").find((l) => /^cpu\s/.test(l));
  if (!line) throw new Error(`no cpu line in ${procRoot}/stat`);
  const f = line.trim().split(/\s+/).slice(1).map(Number);
  // fields: user nice system idle iowait irq softirq steal guest guest_nice
  return (f[0] ?? 0) + (f[1] ?? 0) + (f[2] ?? 0) + (f[5] ?? 0) + (f[6] ?? 0) + (f[7] ?? 0);
}

/** utime + stime in jiffies from a `/proc/<pid>/stat` line (the name in parentheses may hold spaces and parens). */
export function parseStatJiffies(stat: string): number {
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // rest[0] is field 3 (state), so utime (field 14) is rest[11] and stime (field 15) is rest[12].
  return (Number(rest[11]) || 0) + (Number(rest[12]) || 0);
}

function statusKiB(status: string, key: "VmPeak" | "VmHWM"): number {
  return Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? 0);
}

export class GroupSampler {
  private readonly procRoot: string;
  private readonly tck: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly ownAll: (() => number) | undefined;
  private ownAll0 = 0;
  private readonly jiffies = new Map<number, number>();
  private vmPeakKiB = 0;
  private hwmKiB = 0;
  private busy0 = 0;
  private t0 = 0;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(readonly pgid: number, options: SamplerOptions = {}) {
    this.procRoot = options.procRoot ?? "/proc";
    this.tck = options.clkTck ?? clkTck();
    this.intervalMs = options.intervalMs ?? 250;
    this.now = options.now ?? (() => performance.now() / 1000);
    this.ownAll = options.ownAll;
  }

  /** Jiffies of every pid seen so far (last value per pid). */
  ownJiffies(): number {
    let own = 0;
    for (const j of this.jiffies.values()) own += j;
    return own;
  }

  async start(): Promise<void> {
    this.t0 = this.now();
    this.busy0 = await busyJiffies(this.procRoot);
    await this.sample();
    this.ownAll0 = this.ownAll?.() ?? 0;
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => {
        if (this.busy) return;
        this.busy = true;
        void this.sample().finally(() => { this.busy = false; });
      }, this.intervalMs);
    }
  }

  /** One read of the group. A pid that is gone keeps its last value. */
  async sample(): Promise<void> {
    for (const pid of await pidsInGroup(this.pgid, this.procRoot)) {
      const [stat, status] = await Promise.all([
        readFile(`${this.procRoot}/${pid}/stat`, "utf8").catch(() => ""),
        readFile(`${this.procRoot}/${pid}/status`, "utf8").catch(() => ""),
      ]);
      if (stat) this.jiffies.set(pid, parseStatJiffies(stat));
      if (status) {
        this.vmPeakKiB = Math.max(this.vmPeakKiB, statusKiB(status, "VmPeak"));
        this.hwmKiB = Math.max(this.hwmKiB, statusKiB(status, "VmHWM"));
      }
    }
  }

  async stop(): Promise<SampleResult> {
    if (this.timer) clearInterval(this.timer);
    while (this.busy) await new Promise((r) => setTimeout(r, 5));
    await this.sample();
    const wallSec = Math.max(this.now() - this.t0, 1e-6);
    const busyJiffiesDelta = (await busyJiffies(this.procRoot)) - this.busy0;
    const own = this.ownJiffies();
    // Every live group of the render is ours; the sum is read after this group's last sample.
    const renderOwn = this.ownAll ? Math.max(this.ownAll() - this.ownAll0, own) : own;
    return {
      wallSec,
      cpuSec: own / this.tck,
      vmPeakMiB: Math.round(this.vmPeakKiB / 1024),
      rssMiB: Math.round(this.hwmKiB / 1024),
      foreignCores: Math.max(0, busyJiffiesDelta - renderOwn) / this.tck / wallSec,
      ownJiffies: own,
      foreignJiffies: Math.max(0, busyJiffiesDelta - renderOwn),
      busyJiffies: busyJiffiesDelta,
      pids: this.jiffies.size,
    };
  }
}


// ---------------------------------------------------------------------------------------------------------------
// One sampler per live process group. A level's chunk passes run side by side (PASS_CONCURRENCY = 2), so the control
// hooks of renderPasses are called for two groups at once: `started` adds a sampler, `passEnded(pgid)` stops that one.
// ---------------------------------------------------------------------------------------------------------------

export interface PassSpawn { argv: string[]; cwd: string }
export interface PassRecord {
  /** Pass folder relative to the render dir (`c0`, `l1`, ...), `final` for the render's own folder. */
  id: string;
  pgid: number;
  argv: string[];
  cwd: string;
  /** Seconds from the tracker's first start. */
  startSec: number;
  endSec: number;
  result: SampleResult;
  kept: Array<{ original: string; link: string }>;
}
export interface PassTrackerOptions {
  spawns: Map<number, PassSpawn>;
  dir: string;
  /** Folder for hard links of each pass folder (the split reruns need the intermediates); null = keep nothing. */
  keep: string | null;
  tck: number;
  procRoot?: string;
  intervalMs?: number;
  now?: () => number;
}

export class PassTracker {
  private readonly samplers = new Map<number, GroupSampler>();
  private readonly live = new Map<number, { sampler: GroupSampler; spawn: PassSpawn; startSec: number }>();
  private readonly pending: Array<Promise<void>> = [];
  private readonly now: () => number;
  private origin: number | null = null;
  readonly records: PassRecord[] = [];

  constructor(private readonly o: PassTrackerOptions) {
    this.now = o.now ?? (() => performance.now() / 1000);
  }

  /** utime + stime of every group of the render, live or ended. */
  ownAll = (): number => { let n = 0; for (const s of this.samplers.values()) n += s.ownJiffies(); return n; };

  liveCount(): number { return this.live.size; }

  async started(pgid: number): Promise<boolean> {
    const spawn = this.o.spawns.get(pgid);
    if (!spawn) throw new Error(`pgid ${pgid} was not spawned through the probe`);
    const sampler = new GroupSampler(pgid, { procRoot: this.o.procRoot, clkTck: this.o.tck, intervalMs: this.o.intervalMs, now: this.now, ownAll: this.ownAll });
    this.samplers.set(pgid, sampler);
    const t = this.now();
    this.origin ??= t;
    this.live.set(pgid, { sampler, spawn, startSec: t - this.origin });
    await sampler.start();
    return true;
  }

  /** Stops only the sampler of `pgid`. Cannot wait: the pass folder is held open with hard links now, the stop is collected by `settled`. */
  passEnded(pgid?: number): void {
    const cur = pgid === undefined ? undefined : this.live.get(pgid);
    if (!cur || pgid === undefined) return;
    this.live.delete(pgid);
    const endSec = this.now() - (this.origin ?? 0);
    const id = relative(this.o.dir, cur.spawn.cwd) || "final";
    const kept: PassRecord["kept"] = [];
    if (this.o.keep) {
      const used = new Set<string>();
      try {
        for (const name of readdirSync(cur.spawn.cwd)) {
          const original = join(cur.spawn.cwd, name);
          const link = dedupe(join(this.o.keep, `${id}-${name}`), used);
          try { linkSync(original, link); } catch { copyFileSync(original, link); }
          kept.push({ original, link });
        }
      } catch { /* a folder that is already gone has nothing to keep */ }
    }
    this.pending.push(cur.sampler.stop().then((result) => { this.records.push({ id, pgid, argv: cur.spawn.argv, cwd: cur.spawn.cwd, startSec: cur.startSec, endSec, result, kept }); }));
  }

  /** Re-reads every live group (tests; the timer does it in the probe). */
  async sampleAll(): Promise<void> { await Promise.all([...this.live.values()].map((l) => l.sampler.sample())); }

  async settled(): Promise<PassRecord[]> {
    await Promise.all(this.pending);
    return this.records.sort((a, b) => a.startSec - b.startSec || a.pgid - b.pgid);
  }
}

function dedupe(path: string, set: Set<string>): string {
  let p = path; let n = 0;
  while (set.has(p)) p = `${path}.${++n}`;
  set.add(p);
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Unit test (always runs): stub /proc root.
// ---------------------------------------------------------------------------------------------------------------

function stubProc(root: string, procs: Array<{ pid: number; pgrp: number; utime: number; stime: number; vmPeakKiB: number; hwmKiB: number; state?: string }>, cpu: number[]): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "stat"), `cpu  ${cpu.join(" ")}\ncpu0 1 1 1 1 1 1 1 1 0 0\nintr 1\n`);
  for (const p of procs) {
    const dir = join(root, String(p.pid));
    mkdirSync(dir, { recursive: true });
    // Field 2 holds spaces and a paren on purpose; fields 4+ follow state ppid pgrp ... utime(14) stime(15).
    const after = [p.state ?? "S", 1, p.pgrp, 0, 0, 0, 0, 0, 0, 0, 0, p.utime, p.stime, 0, 0, 20, 0, 1, 0, 0].join(" ");
    writeFileSync(join(dir, "stat"), `${p.pid} (ff mpeg) x) ${after}\n`);
    writeFileSync(join(dir, "status"), `Name:\tffmpeg\nVmPeak:\t${p.vmPeakKiB} kB\nVmSize:\t1 kB\nVmHWM:\t${p.hwmKiB} kB\nVmRSS:\t1 kB\n`);
  }
}

describe("GroupSampler (stub /proc)", () => {
  it("ignores a pid outside the group and computes foreign load", async () => {
    const root = mkdtempSync(join(tmpdir(), "worst-case-proc-"));
    try {
      // idle 1000 is not busy; busy = user+nice+system+irq+softirq+steal = 100+0+50+0+0+0 = 150.
      stubProc(root, [
        { pid: 100, pgrp: 100, utime: 10, stime: 5, vmPeakKiB: 2048 * 1024, hwmKiB: 512 * 1024 },
        { pid: 101, pgrp: 100, utime: 20, stime: 0, vmPeakKiB: 1024 * 1024, hwmKiB: 256 * 1024 },
        { pid: 200, pgrp: 999, utime: 5000, stime: 5000, vmPeakKiB: 9999 * 1024, hwmKiB: 9999 * 1024 },
        { pid: 102, pgrp: 100, utime: 7777, stime: 0, vmPeakKiB: 1, hwmKiB: 1, state: "Z" },
      ], [100, 0, 50, 1000, 0, 0, 0, 0, 0, 0]);
      let t = 10;
      const s = new GroupSampler(100, { procRoot: root, clkTck: 100, intervalMs: 0, now: () => t });
      await s.start();

      // 10 s later: pid 100 grew by 300 jiffies, pid 101 is gone (keeps its last 20), pid 103 joined, the foreign pid burned more.
      t = 20;
      stubProc(root, [
        { pid: 100, pgrp: 100, utime: 210, stime: 105, vmPeakKiB: 3072 * 1024, hwmKiB: 600 * 1024 },
        { pid: 103, pgrp: 100, utime: 50, stime: 25, vmPeakKiB: 100 * 1024, hwmKiB: 90 * 1024 },
        { pid: 200, pgrp: 999, utime: 9000, stime: 9000, vmPeakKiB: 9999 * 1024, hwmKiB: 9999 * 1024 },
      ], [100 + 2500 + 100, 0, 50 + 500, 3000, 0, 0, 0, 0, 0, 0]);
      rmSync(join(root, "101"), { recursive: true });
      await s.sample();
      const r = await s.stop();

      // own = pid100 315 + pid101 last 20 + pid103 75 = 410 jiffies; the Z pid and pid 200 never count.
      expect(r.pids).toBe(3);
      expect(r.ownJiffies).toBe(410);
      expect(r.cpuSec).toBeCloseTo(4.1, 6);
      expect(r.vmPeakMiB).toBe(3072);
      expect(r.rssMiB).toBe(600);
      // busy delta = (2700 + 550) - 150 = 3100; foreign = (3100 - 410) / 100 / 10 s = 2.69 cores.
      expect(r.busyJiffies).toBe(3100);
      expect(r.foreignCores).toBeCloseTo(2.69, 6);
      expect(r.wallSec).toBe(10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps one sampler per live group: two passes at once get only their own pids, and foreign load subtracts both", async () => {
    const root = mkdtempSync(join(tmpdir(), "worst-case-proc-"));
    try {
      const dir = join(root, "render");
      const spawns = new Map<number, PassSpawn>([
        [100, { argv: ["ffmpeg", "a"], cwd: join(dir, "c0") }],
        [200, { argv: ["ffmpeg", "b"], cwd: join(dir, "c1") }],
      ]);
      const proc = join(root, "proc");
      let t = 0;
      const tracker = new PassTracker({ spawns, dir, keep: null, tck: 100, procRoot: proc, intervalMs: 0, now: () => t });
      const mib = 1024;
      // t=0: both passes spawn; pid 300 is somebody else's (group 999). The cpu line is user nice system idle ...
      stubProc(proc, [
        { pid: 100, pgrp: 100, utime: 0, stime: 0, vmPeakKiB: 100 * mib, hwmKiB: 10 * mib },
        { pid: 200, pgrp: 200, utime: 0, stime: 0, vmPeakKiB: 200 * mib, hwmKiB: 20 * mib },
        { pid: 300, pgrp: 999, utime: 0, stime: 0, vmPeakKiB: 1, hwmKiB: 1 },
      ], [0, 0, 0, 1000, 0, 0, 0, 0, 0, 0]);
      await tracker.started(100);
      await tracker.started(200);
      // The second `started` must not replace the first group's sampler.
      expect(tracker.liveCount()).toBe(2);

      // t=10: group 100 burned 600 jiffies, group 200 400, the foreign pid 200. Group 100's pass ends.
      t = 10;
      stubProc(proc, [
        { pid: 100, pgrp: 100, utime: 500, stime: 100, vmPeakKiB: 2048 * mib, hwmKiB: 512 * mib },
        { pid: 200, pgrp: 200, utime: 300, stime: 100, vmPeakKiB: 3000 * mib, hwmKiB: 700 * mib },
        { pid: 300, pgrp: 999, utime: 200, stime: 0, vmPeakKiB: 1, hwmKiB: 1 },
      ], [1200, 0, 0, 1000, 0, 0, 0, 0, 0, 0]);
      await tracker.sampleAll();
      tracker.passEnded(100);
      await tracker.settled();
      expect(tracker.liveCount()).toBe(1);

      // t=20: group 100 is gone (its jiffies were spent); group 200 reached 800, the foreign pid 400. Group 200 ends.
      t = 20;
      rmSync(join(proc, "100"), { recursive: true });
      stubProc(proc, [
        { pid: 200, pgrp: 200, utime: 700, stime: 100, vmPeakKiB: 3000 * mib, hwmKiB: 700 * mib },
        { pid: 300, pgrp: 999, utime: 400, stime: 0, vmPeakKiB: 1, hwmKiB: 1 },
      ], [1800, 0, 0, 1000, 0, 0, 0, 0, 0, 0]);
      await tracker.sampleAll();
      tracker.passEnded(200);
      const [a, b] = await tracker.settled();

      expect([a!.id, a!.pgid, a!.startSec, a!.endSec]).toEqual(["c0", 100, 0, 10]);
      expect([b!.id, b!.pgid, b!.startSec, b!.endSec]).toEqual(["c1", 200, 0, 20]);
      // Each pass has its own pids only (a one-`current` probe would hand group 100's pid to group 200's record).
      expect([a!.result.pids, a!.result.ownJiffies, a!.result.cpuSec]).toEqual([1, 600, 6]);
      expect([b!.result.pids, b!.result.ownJiffies, b!.result.cpuSec]).toEqual([1, 800, 8]);
      expect([a!.result.vmPeakMiB, a!.result.rssMiB]).toEqual([2048, 512]);
      expect([b!.result.vmPeakMiB, b!.result.rssMiB]).toEqual([3000, 700]);
      // Pass a: busy 1200, both groups grew 600 + 400 = 1000, so foreign 200 jiffies / 100 / 10 s = 0.2 cores (one group only would say 0.6).
      expect(a!.result.foreignCores).toBeCloseTo(0.2, 6);
      // Pass b: busy 1800, both groups grew 600 + 800 = 1400, so foreign 400 / 100 / 20 s = 0.2 cores (one group only would say 0.5).
      expect(b!.result.foreignCores).toBeCloseTo(0.2, 6);
      expect(tracker.ownAll()).toBe(1400);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads utime and stime past a process name with spaces and parens", () => {
    expect(parseStatJiffies("42 (a b) c) S 1 42 42 0 0 0 0 0 0 0 7 11 0 0 20 0 1 0 0")).toBe(18);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The probe (opt-in).
// ---------------------------------------------------------------------------------------------------------------

const W = 1080;
const H = 1920;
const FPS = 30;
const CLIPS = 6;
type Variant = "base" | "key" | "mult" | "both";
const ALL_VARIANTS: Variant[] = ["base", "key", "mult", "both"];


/** ffmpeg to build a source; throws with its stderr. */
function sh(cwd: string, args: string[]): void {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { cwd });
  if (r.status !== 0) throw new Error(r.stderr.toString());
}

function buildSources(dir: string, secs: number, silent: boolean): Array<{ name: string; file: string }> {
  const out: Array<{ name: string; file: string }> = [];
  for (const name of ["wb", "wo", "wg"]) {
    const file = `${name}.mp4`;
    if (!existsSync(join(dir, file))) {
      const vf = name === "wg" ? "drawbox=x=300:y=600:w=480:h=700:color=0xD03030:t=fill," : "";
      const col = name === "wg" ? "0x00B140" : name === "wb" ? "0x3090C0" : "0xD06040";
      sh(dir, [
        "-f", "lavfi", "-i", `color=c=${col}:s=${W}x${H}:r=${FPS}:d=${secs}`,
        ...(silent ? [] : ["-f", "lavfi", "-i", `sine=f=440:d=${secs}`]),
        "-vf", `${vf}noise=alls=20:allf=t`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p",
        ...(silent ? ["-an"] : ["-c:a", "aac", "-shortest"]),
        file,
      ]);
    }
    out.push({ name, file });
  }
  return out;
}

/** Sources as production builds them: kind, hasAudio and the planner's dims all from probeMedia. */
async function probedSources(dir: string, built: Array<{ name: string; file: string }>): Promise<CompileInputs> {
  const sources: CompileInputs = {};
  for (const { name, file } of built) {
    const p = await probeMedia(join(dir, file));
    sources[inputKey(name, 1)] = { path: join(dir, file), kind: "video", hasAudio: p.hasAudio, width: p.width ?? undefined, height: p.height ?? undefined, fps: p.fps ?? undefined };
  }
  return sources;
}

function buildDoc(variant: Variant, secs: number) {
  const clip = (id: string, assetId: string, start: number, extra: Record<string, unknown> = {}) => ({ id, assetId, version: 1, start, in: 0, out: secs, ...extra });
  const feats = { look: { id: "teal-orange", intensity: 0.6 }, adjust: { brightness: 0.1, contrast: 1.2, saturation: 0.8, temperature: 4000, blur: 10, vignette: 0.5 } };
  const t = pipTransform({ width: W, height: H }, "bottom-right", "M");
  const frame = { borderWidth: 6, borderColor: "#FF0000", cornerRadius: 20 };
  const base: unknown[] = [];
  const mult: unknown[] = [];
  const key: unknown[] = [];
  for (let i = 0; i < CLIPS; i++) {
    base.push(clip("b" + i, "wb", i * secs, { ...feats }));
    mult.push(clip("m" + i, "wo", i * secs, { blendMode: "multiply", transform: t, frame, fadeIn: 0.5, adjust: { brightness: 0.1, vignette: 0.3 }, look: { id: "mono" } }));
    key.push(clip("k" + i, "wg", i * secs, { chromaKey: { color: "#00B140", similarity: 0.15, blend: 0.05, spill: 0.3 }, transform: { ...t, x: -t.x }, frame: { cornerRadius: 20, borderWidth: 4, borderColor: "#FFFFFF" } }));
  }
  const tracks: unknown[] = [{ id: "v-main", kind: "video", clips: base }];
  if (variant === "mult" || variant === "both") tracks.push({ id: "om", kind: "overlay", clips: mult });
  if (variant === "key" || variant === "both") tracks.push({ id: "ok", kind: "overlay", clips: key });
  return normalizeEdit({ project: { size: "9:16", fps: FPS }, tracks });
}

/** Runs `argv` once in its own process group under a sampler. */
async function timedCommand(argv: string[], cwd: string, tck: number): Promise<SampleResult> {
  const child: ChildProcess = spawn(argv[0]!, argv.slice(1), { cwd, detached: true, stdio: ["ignore", "ignore", "pipe"] } satisfies SpawnOptions);
  let err = "";
  child.stderr?.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-1500); });
  const exited = new Promise<number | null>((res) => child.once("close", (code) => res(code)));
  const sampler = new GroupSampler(child.pid!, { clkTck: tck });
  await sampler.start();
  const code = await exited;
  const result = await sampler.stop();
  if (code !== 0) throw new Error(`split command failed (${code}): ${argv.slice(-6).join(" ")}\n${err}`);
  return result;
}

/** `argv` with its output (the last argument) replaced by a null muxer. */
function toNull(argv: string[]): string[] {
  return [...argv.slice(0, -1), "-f", "null", "-"];
}

const enabled = Boolean(process.env.STUDIO_WORST_CASE);

describe.skipIf(!enabled)("worst-case render probe (opt-in)", () => {
  const secs = Number(process.env.STUDIO_WORST_CASE_SECONDS ?? 30);
  const silent = process.env.STUDIO_WORST_CASE_SILENT === "1";
  const split = process.env.STUDIO_WORST_CASE_SPLIT === "1";
  const variants = (process.env.STUDIO_WORST_CASE_VARIANTS ?? ALL_VARIANTS.join(",")).split(",").map((v) => v.trim()).filter(Boolean) as Variant[];
  const root = process.env.STUDIO_WORST_CASE_DIR ?? join(process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "studio-worst-case");
  const srcDir = join(root, `src-${secs}s-${silent ? "silent" : "sound"}`);
  const deadlineSec = Number(process.env.STUDIO_WORST_CASE_DEADLINE_SEC ?? 3600);
  const tck = clkTck();
  const round = (n: number, d = 2) => Number(n.toFixed(d));

  afterAll(() => { rmSync(srcDir, { recursive: true, force: true }); });

  for (const variant of variants) {
    it(`variant ${variant}`, async () => {
      expect(ALL_VARIANTS).toContain(variant);
      mkdirSync(srcDir, { recursive: true });
      const sources = await probedSources(srcDir, buildSources(srcDir, secs, silent));
      const doc = buildDoc(variant, secs);
      const dir = join(root, `render-${variant}`);
      const keep = join(root, `keep-${variant}`);
      for (const d of [dir, keep]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }

      // The render's own spawns, by pid: the split reruns each pass's argv and the pass folder is gone by then.
      const spawns = new Map<number, PassSpawn>();
      const spawnImpl = (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
        const child = spawn(cmd, args, opts);
        if (child.pid) spawns.set(child.pid, { argv: [cmd, ...args], cwd: String(opts.cwd ?? dir) });
        return child;
      };

      // Run group of each pass, as renderPasses batches them: consecutive chunks of one level run together (two at a
      // time); every other pass is a group of its own, and the final pass comes last. (A layer has level 0 but runs
      // after the chunk levels, so grouping by plan level alone would stretch level 0 over later passes.)
      const plan = planRender(doc, sources, { workdir: dir });
      const levelOf = new Map<string, number>();
      let groups = 0;
      if (plan.kind === "multi") {
        plan.passes.forEach((p, i) => {
          const prev = plan.passes[i - 1];
          if (!(p.kind === "chunk" && prev?.kind === "chunk" && prev.level === p.level)) groups++;
          levelOf.set(p.id, groups - 1);
        });
      }
      levelOf.set("final", groups);

      // One sampler per pgid: a level's chunk passes run side by side, so two groups are live at once.
      const tracker = new PassTracker({ spawns, dir, keep, tck });
      const control = {
        signal: new AbortController().signal,
        started: ({ pgid }: { pgid: number; workdir: string }) => tracker.started(pgid),
        passEnded: (pgid?: number) => tracker.passEnded(pgid),
      } as unknown as Parameters<typeof renderPasses>[3];

      const startedAt = new Date();
      const busy0 = await busyJiffies();
      const t0 = performance.now() / 1000;
      const report = await renderPasses(doc, sources, dir, control, { deadlineSec, run: { spawnImpl } });
      const wallSec = performance.now() / 1000 - t0;
      const endedAt = new Date();
      const busyDelta = (await busyJiffies()) - busy0;
      const records = await tracker.settled();
      expect(records.map((r) => r.id).sort()).toEqual([...report.passes, "final"].sort());

      const out = await probeMedia(join(dir, "out.mp4"));
      expect(Math.abs(out.durationSec - CLIPS * secs)).toBeLessThanOrEqual(1 / FPS + 1e-3);

      const passes = [];
      for (const rec of records) {
        const entry: Record<string, unknown> = {
          id: rec.id,
          runGroup: levelOf.get(rec.id) ?? null,
          pgid: rec.pgid,
          startSec: round(rec.startSec, 1),
          endSec: round(rec.endSec, 1),
          wallSec: round(rec.result.wallSec, 1),
          cpuSec: round(rec.result.cpuSec, 1),
          vmPeakMiB: rec.result.vmPeakMiB,
          rssMiB: rec.result.rssMiB,
          foreignCores: round(rec.result.foreignCores),
        };
        // Split mode works per pass: each rerun is one pass, alone on its own, after the render is over.
        if (split && rec.id !== "final") {
          // Put the pass folder back (hard links), then time its argv with a null output and the decode of its intermediate.
          for (const k of rec.kept) { mkdirSync(dirname(k.original), { recursive: true }); if (!existsSync(k.original)) linkSync(k.link, k.original); }
          const output = resolve(rec.cwd, rec.argv[rec.argv.length - 1]!.replace(/^file:/, ""));
          const a = await timedCommand(toNull(rec.argv), rec.cwd, tck);
          const b = await timedCommand(["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-i", output, "-f", "null", "-"], rec.cwd, tck);
          entry.split = { decodeFilterCpuSec: round(a.cpuSec, 1), encodeCpuSec: round(rec.result.cpuSec - a.cpuSec, 1), intermediateDecodeCpuSec: round(b.cpuSec, 1) };
        }
        passes.push(entry);
      }
      // Per level: wall from its first start to its last end (two chunk passes side by side count once).
      const levels = [...new Set(records.map((r) => levelOf.get(r.id) ?? 0))].sort((x, y) => x - y).map((level) => {
        const rs = records.filter((r) => (levelOf.get(r.id) ?? 0) === level);
        return {
          level, passes: rs.map((r) => r.id),
          wallSec: round(Math.max(...rs.map((r) => r.endSec)) - Math.min(...rs.map((r) => r.startSec)), 1),
          cpuSec: round(rs.reduce((s, r) => s + r.result.cpuSec, 0), 1),
        };
      });
      const cpuSec = records.reduce((s, r) => s + r.result.cpuSec, 0);
      // Over the whole render window: machine busy time minus every group of the render.
      const foreignJiffies = Math.max(0, busyDelta - tracker.ownAll());
      const line = {
        variant, sound: !silent, plan: report.plan, weight: report.weight, passes, levels,
        startUtc: startedAt.toISOString(), endUtc: endedAt.toISOString(), peakLivePasses: Math.max(...records.map((r) => records.filter((o) => o.startSec < r.endSec && o.endSec > r.startSec).length)),
        wallSec: round(wallSec, 1), cpuSec: round(cpuSec, 1), ownCores: round(cpuSec / wallSec),
        foreignCoresMean: round(foreignJiffies / tck / Math.max(wallSec, 1e-6)), outDurationSec: round(out.durationSec, 3),
      };
      console.log(JSON.stringify(line));
      if (process.env.STUDIO_WORST_CASE_OUT) appendFileSync(process.env.STUDIO_WORST_CASE_OUT, JSON.stringify(line) + "\n");
      for (const d of [dir, keep]) rmSync(d, { recursive: true, force: true });
    }, 3_600_000);
  }
});
