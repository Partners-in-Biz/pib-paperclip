import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runContained } from "../src/video-edit/ffmpeg.js";
import { ease, exprNum, toFfmpegExpr, valueAt, type KeyframeEase, type KeyframeLike } from "../src/video-edit/keyframes.js";

const k = (t: number, value: number, e: KeyframeEase = "linear"): KeyframeLike => ({ t, value, ease: e });
const EASES: KeyframeEase[] = ["linear", "easeIn", "easeOut", "easeInOut", "hold"];

/** 50 keys over 0..4.9 s, eases cycling, values in the volume range 0..2. */
const fifty: KeyframeLike[] = Array.from({ length: 50 }, (_, i) => k(i * 0.1, Math.round((1 + Math.sin(i * 1.7)) * 1000) / 1000, EASES[i % 5]));

describe("valueAt", () => {
  it("returns base with no keys", () => {
    expect(valueAt(undefined, 1, 0.5)).toBe(0.5);
    expect(valueAt([], 1, 1)).toBe(1);
  });

  it("is constant with one key, before and after it", () => {
    for (const t of [0, 1, 2, 10]) expect(valueAt([k(1, 7)], t, 0)).toBe(7);
  });

  it.each([
    ["linear", 0.25, 2.5],
    ["easeIn", 0.0625, 0.625],
    ["easeOut", 0.4375, 4.375],
    ["easeInOut", 0.15625, 1.5625],
    ["hold", 0, 0],
  ] as const)("%s: ease(0.25) = %s, value from 0 to 10 at 25%% = %s", (e, p, v) => {
    expect(ease(e, 0.25)).toBeCloseTo(p, 12);
    const kfs = [k(1, 0, e), k(3, 10)];
    expect(valueAt(kfs, 1.5, 99)).toBeCloseTo(v, 12);
    expect(valueAt(kfs, 1, 99)).toBe(0);
    expect(valueAt(kfs, 3, 99)).toBe(10);
    expect(valueAt(kfs, 0, 99)).toBe(0);
    expect(valueAt(kfs, 5, 99)).toBe(10);
  });

  it("every ease starts at 0 and ends at 1", () => {
    for (const e of EASES.filter((x) => x !== "hold")) {
      expect(ease(e, 0)).toBe(0);
      expect(ease(e, 1)).toBe(1);
    }
  });

  it("hold steps exactly at the next key", () => {
    const kfs = [k(0, 1, "hold"), k(1, 2, "hold"), k(2, 3)];
    expect(valueAt(kfs, 0.999999, 0)).toBe(1);
    expect(valueAt(kfs, 1, 0)).toBe(2);
    expect(valueAt(kfs, 1.999999, 0)).toBe(2);
    expect(valueAt(kfs, 2, 0)).toBe(3);
  });

  it("50 keys: every key's own value at its time, eased between", () => {
    for (const kf of fifty) expect(valueAt(fifty, kf.t, -1)).toBe(kf.value);
    const a = fifty[3]!; // easeInOut, halfway
    const b = fifty[4]!;
    expect(valueAt(fifty, (a.t + b.t) / 2, -1)).toBeCloseTo(a.value + (b.value - a.value) * 0.5, 9);
  });
});

describe("toFfmpegExpr", () => {
  it("prints numbers with fixed precision", () => {
    expect(exprNum(1)).toBe("1");
    expect(exprNum(0.1 + 0.2)).toBe("0.3");
    expect(exprNum(-2.5)).toBe("(-2.5)");
    expect(exprNum(-0.0000001)).toBe("0");
    expect(exprNum(1 / 3)).toBe("0.333333");
    expect(() => exprNum(Number.NaN)).toThrow();
    expect(() => exprNum(Infinity)).toThrow();
  });

  it("is the base or the one key's value for 0 and 1 keys", () => {
    expect(toFfmpegExpr([], 1, 3)).toBe("1");
    expect(toFfmpegExpr([k(2, -4)], 1, 3)).toBe("(-4)");
  });

  it("builds nested if(lt()) with the offset added to key times", () => {
    expect(toFfmpegExpr([k(0, 0, "easeIn"), k(2, 1, "hold"), k(3, 5)], 0, 1.5)).toBe(
      "if(lt(t,1.5),0,if(lt(t,3.5),0+1*((t-1.5)/2)*((t-1.5)/2),if(lt(t,4.5),1,5)))",
    );
    expect(toFfmpegExpr([k(0, 2), k(1, -1, "easeOut")], 0, 0, "T")).toBe("if(lt(T,0),2,if(lt(T,1),2+(-3)*((T-0)/1),(-1)))");
    expect(() => toFfmpegExpr([k(0, 0), k(1, 1)], 0, 0, "t);x")).toThrow();
  });
});

const hasFfmpeg = ["/usr/bin/timeout", "/usr/bin/prlimit", "/usr/bin/nice"].every(existsSync) && spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("toFfmpegExpr in real ffmpeg", () => {
  it("a 50-key volume=eval=frame curve matches valueAt within 1e-3", async () => {
    const offset = 0.25;
    const rate = 1000; // one sample per frame, so frame i is at t = i / 1000 s
    const expr = toFfmpegExpr(fifty, 1, offset);
    const samples: number[] = [];
    const dir = mkdtempSync(join(tmpdir(), "studio-keyframes-"));
    try {
      // astats reads back each one-sample frame's level; ametadata writes it with its pts_time to a text file.
      const res = await runContained([
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", `aevalsrc=exprs=1:sample_rate=${rate}:nb_samples=1:duration=5.5`,
        "-af", `volume=eval=frame:precision=float:volume='${expr}',astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.Max_level:file=levels.txt`,
        "-f", "null", "-",
      ], { cwd: dir, timeoutSec: 120 }).done;
      expect(res.stderrTail).toBe("");
      expect(res.outcome).toBe("ok");
      const text = readFileSync(join(dir, "levels.txt"), "utf8");
      const times = [...text.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
      const levels = [...text.matchAll(/Max_level=(-?[\d.]+)/g)].map((m) => Number(m[1]));
      samples.push(...levels);
      expect(times.length).toBe(5500);
      expect(levels.length).toBe(5500);
      expect(times[1234]).toBeCloseTo(1.234, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const at = (seconds: number) => samples[Math.round(seconds * rate)]!;
    // Three sampled times: mid easeOut (key 12), mid easeInOut (key 13), mid hold (key 44); local 1.234, 1.337, 4.447.
    for (const sec of [1.484, 1.587, 4.697]) expect(Math.abs(at(sec) - valueAt(fifty, sec - offset, 1))).toBeLessThan(1e-3);
    // And every sample away from a key boundary (where float time rounding can pick either side of a hold step).
    let checked = 0;
    for (let i = 0; i < samples.length; i++) {
      const local = i / rate - offset;
      if (fifty.some((kf) => Math.abs(kf.t - local) < 1e-6)) continue;
      expect(Math.abs(samples[i]! - valueAt(fifty, local, 1))).toBeLessThan(1e-3);
      checked++;
    }
    expect(checked).toBeGreaterThan(5400);
  }, 60_000);
});
