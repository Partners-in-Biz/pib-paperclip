import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { StudioError } from "../src/errors.js";
import { cancelRender, enqueueRender, getRender } from "../src/video-edit/render-queue.js";
import { classifyRenderError, createRenderRunner, failureFromRun, RenderFailure, type RenderExecutor } from "../src/video-edit/runner.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const DOC = { schemaVersion: 1, project: { size: "9:16", fps: 30 }, tracks: [] };

const available = await embeddedAvailable();
let pg: Pg;
let ctx: PluginContext;
let scratch: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  if (!available) return;
  pg = await startPg();
  ctx = { db: pg.db, logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } } as unknown as PluginContext;
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

beforeEach(async () => {
  if (available) await pg.reset();
  scratch = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "runner-spec-"));
});

afterEach(async () => {
  // Only processes this test started, by pid.
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  await rm(scratch, { recursive: true, force: true });
});

const enqueue = (editId = "edit-1") => enqueueRender(ctx, { companyId: CO, editId, editRevision: 1, doc: DOC, preset: "9:16" });

/** A stand-in for ffmpeg: a detached node process (own process group) whose command line names `workdir`. */
function fakeFfmpeg(workdir: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", "-i", join(workdir, "in.mp4"), join(workdir, "out.mp4")], { detached: true, stdio: "ignore" });
  children.push(child);
  return child;
}

const exited = (child: ChildProcess, ms = 5000) =>
  new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });

async function markStale(id: string, fields: { pid?: number | null; workdir?: string | null; attempts?: number } = {}) {
  await pg.db.execute(
    `UPDATE ${pg.db.namespace}.video_renders SET heartbeat_at = now() - interval '10 minutes', pid = $2, workdir = $3, attempts = COALESCE($4, attempts) WHERE id = $1`,
    [id, fields.pid ?? null, fields.workdir ?? null, fields.attempts ?? null],
  );
}

describe("failure classification", () => {
  it("sorts errors into deterministic and infra", () => {
    expect(classifyRenderError(new StudioError("bad file", "probe_failed")).kind).toBe("deterministic");
    expect(classifyRenderError(new StudioError("no", "unsupported_feature:wipe")).kind).toBe("deterministic");
    expect(classifyRenderError(new StudioError("full", "disk_low")).kind).toBe("infra");
    expect(classifyRenderError(new Error("socket hang up")).kind).toBe("infra");
    expect(classifyRenderError(new RenderFailure("x", "deterministic", "verify_failed")).code).toBe("verify_failed");
    const run = { exitCode: 1, signal: null, stderrTail: "err", stdout: "", durationMs: 1 };
    expect(failureFromRun({ ...run, outcome: "ok" })).toBeNull();
    expect(failureFromRun({ ...run, outcome: "nonzero" })?.kind).toBe("deterministic");
    expect(failureFromRun({ ...run, outcome: "timeout" })?.kind).toBe("infra");
    expect(failureFromRun({ ...run, outcome: "rlimit" })).toMatchObject({ kind: "infra", stderrTail: "err" });
  });
});

describe.skipIf(!available)("Render runner against real Postgres (fake ffmpeg)", () => {
  it("two ticks claim one render while it runs, then finish it", async () => {
    const a = await enqueue("edit-a");
    const b = await enqueue("edit-b");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const executor: RenderExecutor = async (_ctx, job, control) => {
      calls.push(job.id);
      const dir = join(scratch, `r-${job.id}`);
      const child = fakeFfmpeg(dir);
      expect(await control.started({ pgid: child.pid!, workdir: dir })).toBe(true);
      await gate;
      child.kill("SIGKILL");
      return { assetId: `asset-${job.id}` };
    };
    const runner = createRenderRunner(ctx, { executor, heartbeatMs: 50 });

    const [t1, t2] = await Promise.all([runner.tick(), runner.tick()]);
    const t3 = await runner.tick();
    // Overlapping ticks share one pass; the later tick sees the running render and claims nothing.
    expect(t1.claimed).toBe(a.id);
    expect(t2.claimed).toBe(a.id);
    expect(t3).toMatchObject({ claimed: null, running: a.id });
    const active = await pg.db.query(`SELECT id FROM ${pg.db.namespace}.video_renders WHERE status IN ('rendering', 'uploading')`);
    expect(active.map((r: { id: string }) => r.id)).toEqual([a.id]);
    expect(calls).toEqual([a.id]);
    expect(runner.running()[0]).toMatchObject({ id: a.id, workdir: join(scratch, `r-${a.id}`) });
    expect(await getRender(ctx, CO, a.id)).toMatchObject({ status: "rendering", workdir: join(scratch, `r-${a.id}`) });

    release();
    await runner.settled();
    expect(await getRender(ctx, CO, a.id)).toMatchObject({ status: "succeeded", assetId: `asset-${a.id}`, attempts: 1 });
    expect((await getRender(ctx, CO, b.id)).status).toBe("queued");
    expect((await runner.tick()).claimed).toBe(b.id);
    release();
    await runner.settled();
  });

  it("a deterministic failure is not retried", async () => {
    const job = await enqueue();
    let calls = 0;
    const runner = createRenderRunner(ctx, {
      executor: async () => {
        calls += 1;
        throw new StudioError("Codec prores is not supported", "unsupported_codec");
      },
    });
    await runner.tick();
    await runner.settled();
    expect(await getRender(ctx, CO, job.id)).toMatchObject({ status: "failed", errorKind: "deterministic", attempts: 1, error: "Codec prores is not supported" });
    expect((await runner.tick()).claimed).toBeNull();
    expect(calls).toBe(1);
  });

  it("an infra failure is retried exactly once", async () => {
    const job = await enqueue();
    let calls = 0;
    const runner = createRenderRunner(ctx, {
      executor: async () => {
        calls += 1;
        throw failureFromRun({ outcome: "timeout", exitCode: 124, signal: null, stderrTail: "frame=10", stdout: "", durationMs: 1 })!;
      },
    });
    await runner.tick();
    await runner.settled();
    expect(await getRender(ctx, CO, job.id)).toMatchObject({ status: "queued", errorKind: "infra", attempts: 1, stderrTail: "frame=10" });
    await runner.tick();
    await runner.settled();
    expect(await getRender(ctx, CO, job.id)).toMatchObject({ status: "failed", errorKind: "infra", attempts: 2 });
    expect((await runner.tick()).claimed).toBeNull();
    expect(calls).toBe(2);
  });

  it("after a worker restart, kills the stale render's process group and re-queues it once", async () => {
    const job = await enqueue();
    // The old worker claimed it and started ffmpeg, then died: the process lives on, the heartbeat stops.
    const before = createRenderRunner(ctx, { executor: async () => new Promise(() => undefined) });
    await before.tick();
    const dir = join(scratch, `r-${job.id}-old`);
    const ffmpeg = fakeFfmpeg(dir);
    await markStale(job.id, { pid: ffmpeg.pid!, workdir: dir });

    // The new worker: recovery runs before any claim and picks the job up again.
    let calls = 0;
    const after = createRenderRunner(ctx, {
      executor: async () => {
        calls += 1;
        return { assetId: "asset-1" };
      },
    });
    const t = await after.tick();
    expect(t.recovered).toBe(1);
    expect(await exited(ffmpeg)).toBe(true);
    expect(ffmpeg.signalCode).toBe("SIGKILL");
    expect(t.claimed).toBe(job.id);
    await after.settled();
    expect(await getRender(ctx, CO, job.id)).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(calls).toBe(1);
  });

  it("PAR-11217: recovery also kills a pass that ran beside the recorded one (any group leader naming the work folder)", async () => {
    const job = await enqueue();
    await createRenderRunner(ctx, { executor: async () => new Promise(() => undefined) }).tick();
    const dir = join(scratch, `r-${job.id}-pair`);
    const recorded = fakeFfmpeg(dir);
    const beside = fakeFfmpeg(dir);
    const neighbour = fakeFfmpeg(`${dir}-old`); // a prefix of its name is not the folder
    await markStale(job.id, { pid: recorded.pid!, workdir: dir });
    const runner = createRenderRunner(ctx);
    expect(await runner.recover()).toBe(1);
    expect(await exited(recorded)).toBe(true);
    expect(await exited(beside)).toBe(true);
    expect(beside.signalCode).toBe("SIGKILL");
    expect(await exited(neighbour, 300)).toBe(false);
  });

  it("PAR-11217: two passes live at once: a lost claim kills both groups, and an ended pass is no longer signalled", async () => {
    const job = await enqueue();
    const kills: Array<[number, string]> = [];
    const executor: RenderExecutor = async (_ctx, j, control) => {
      await control.started({ pgid: 717171, workdir: join(scratch, `r-${j.id}`) });
      await control.started({ pgid: 818181, workdir: join(scratch, `r-${j.id}`) });
      await control.started({ pgid: 919191, workdir: join(scratch, `r-${j.id}`) });
      control.passEnded(717171);
      await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve()));
      throw new RenderFailure("stopped", "infra", "cancelled");
    };
    const runner = createRenderRunner(ctx, { executor, heartbeatMs: 30, killGraceMs: 20, killImpl: (pid, sig) => void kills.push([pid, sig]) });
    await runner.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.running()[0]).toMatchObject({ id: job.id, pgid: 919191 });
    await cancelRender(ctx, CO, job.id);
    await runner.settled();
    expect(kills.filter(([, sig]) => sig === "SIGTERM").sort()).toEqual([[-818181, "SIGTERM"], [-919191, "SIGTERM"]]);
    expect(kills.some(([pid]) => pid === -717171)).toBe(false);
  });

  it("recovery never kills a process whose command line does not name the work folder; a second stale run fails", async () => {
    const job = await enqueue();
    await createRenderRunner(ctx, { executor: async () => new Promise(() => undefined) }).tick();
    const bystander = fakeFfmpeg(join(scratch, "someone-else"));
    await markStale(job.id, { pid: bystander.pid!, workdir: join(scratch, `r-${job.id}-gone`), attempts: 2 });

    const runner = createRenderRunner(ctx);
    expect(await runner.recover()).toBe(1);
    expect(await exited(bystander, 300)).toBe(false);
    expect(await getRender(ctx, CO, job.id)).toMatchObject({ status: "failed", errorKind: "infra", attempts: 2 });
    // Without an executor the runner only recovers; it claims nothing.
    await enqueue("edit-2");
    expect((await runner.tick()).claimed).toBeNull();
  });

  it("a lost claim (cancel) aborts the executor and kills its process group", async () => {
    const job = await enqueue();
    const kills: Array<[number, string]> = [];
    let aborted = false;
    const executor: RenderExecutor = async (_ctx, j, control) => {
      await control.started({ pgid: 424242, workdir: join(scratch, `r-${j.id}`) });
      await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve()));
      aborted = true;
      throw new RenderFailure("stopped", "infra", "cancelled");
    };
    const runner = createRenderRunner(ctx, { executor, heartbeatMs: 30, killGraceMs: 20, killImpl: (pid, sig) => void kills.push([pid, sig]) });
    await runner.tick();
    await cancelRender(ctx, CO, job.id);
    await runner.settled();
    expect(aborted).toBe(true);
    expect(kills[0]).toEqual([-424242, "SIGTERM"]);
    expect(await getRender(ctx, CO, job.id)).toMatchObject({ status: "cancelled" });
    expect(runner.running()).toEqual([]);
  });

  it("passEnded() forgets the pass's group: a cancel between passes signals nothing, the next pass's group is the one killed", async () => {
    const job = await enqueue();
    const kills: Array<[number, string]> = [];
    let ended!: () => void;
    const between = new Promise<void>((resolve) => (ended = resolve));
    const executor: RenderExecutor = async (_ctx, j, control) => {
      await control.started({ pgid: 424242, workdir: join(scratch, `r-${j.id}`) });
      control.passEnded();
      ended();
      await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve()));
      throw new RenderFailure("stopped", "infra", "cancelled");
    };
    const runner = createRenderRunner(ctx, { executor, heartbeatMs: 30, killGraceMs: 20, killImpl: (pid, sig) => void kills.push([pid, sig]) });
    await runner.tick();
    await between;
    await cancelRender(ctx, CO, job.id);
    await runner.settled();
    expect(kills).toEqual([]);
    // The row keeps the last pid for recovery (which checks the cmdline before it kills).
    expect(await getRender(ctx, CO, job.id)).toMatchObject({ status: "cancelled" });

    const next = await enqueue("edit-2");
    const exec2: RenderExecutor = async (_ctx, j, control) => {
      await control.started({ pgid: 515151, workdir: join(scratch, `r-${j.id}`) });
      control.passEnded();
      await control.started({ pgid: 616161, workdir: join(scratch, `r-${j.id}`) });
      await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve()));
      throw new RenderFailure("stopped", "infra", "cancelled");
    };
    const runner2 = createRenderRunner(ctx, { executor: exec2, heartbeatMs: 30, killGraceMs: 20, killImpl: (pid, sig) => void kills.push([pid, sig]) });
    await runner2.tick();
    await new Promise((r) => setTimeout(r, 50));
    await cancelRender(ctx, CO, next.id);
    await runner2.settled();
    expect(kills.map(([pid]) => pid)).not.toContain(-515151);
    expect(kills[0]).toEqual([-616161, "SIGTERM"]);
  });
});
