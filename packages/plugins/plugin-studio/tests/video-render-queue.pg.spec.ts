import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  cancelRender,
  claimNextRender,
  enqueueRender,
  finishRender,
  getRender,
  heartbeatRender,
  isActiveSlotConflict,
  listStaleRenders,
  requeueRender,
} from "../src/video-edit/render-queue.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER_CO = "22222222-2222-4222-8222-222222222222";
const DOC = { schemaVersion: 1, project: { size: "9:16", fps: 30 }, tracks: [] };

const available = await embeddedAvailable();
let pg: Pg;
let ctxs: PluginContext[] = [];

const ctxOn = (db: Pg["db"]) => ({ db, logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } }) as unknown as PluginContext;

beforeAll(async () => {
  if (!available) return;
  pg = await startPg();
  // Four connections: parallel claims really run at the same time in Postgres, not one after another on one socket.
  ctxs = [ctxOn(pg.db), ctxOn(await pg.connect()), ctxOn(await pg.connect()), ctxOn(await pg.connect())];
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

const enqueue = (ctx: PluginContext, editId = "edit-1", companyId = CO) => enqueueRender(ctx, { companyId, editId, editRevision: 3, doc: DOC, preset: "9:16" });

async function setHeartbeat(id: string, secondsAgo: number) {
  await pg.db.execute(`UPDATE ${pg.db.namespace}.video_renders SET heartbeat_at = now() - make_interval(secs => $1) WHERE id = $2`, [secondsAgo, id]);
}

async function activeCount(): Promise<number> {
  const rows = await pg.db.query(`SELECT count(*)::int AS n FROM ${pg.db.namespace}.video_renders WHERE status IN ('rendering', 'uploading')`);
  return Number(rows[0].n);
}

describe.skipIf(!available)("Render queue against real Postgres", () => {
  it("enqueueRender stores the normalized doc: v1 stays v1, v2 stays v2, an unreadable doc is refused (PAR-8442)", async () => {
    const ctx = ctxs[0];
    const stored = async (doc: unknown) => {
      const job = await enqueueRender(ctx, { companyId: CO, editId: `e-${Math.random()}`, editRevision: 1, doc, preset: "9:16" });
      const [row] = await (pg.db.query as (sql: string, params: unknown[]) => Promise<{ doc: unknown }[]>)(`SELECT doc FROM ${pg.db.namespace}.video_renders WHERE id = $1`, [job.id]);
      await cancelRender(ctx, CO, job.id);
      return typeof row.doc === "string" ? JSON.parse(row.doc) : row.doc;
    };
    expect(await stored({ project: { size: "1:1" }, tracks: [], junk: true })).toEqual({ schemaVersion: 1, project: { size: "1:1", width: 1080, height: 1080, fps: 30 }, tracks: [] });
    const clip = { id: "c", assetId: "a", version: 1, in: 0, out: 2, start: 0, keyframes: { scale: [{ t: 0, value: 1 }, { t: 2, value: 2 }] } };
    expect(await stored({ ...DOC, schemaVersion: 2, tracks: [{ id: "v", kind: "video", clips: [clip] }] })).toMatchObject({ schemaVersion: 2, tracks: [{ clips: [{ keyframes: { scale: [{}, {}] } }] }] });
    const styled = { ...clip, keyframes: undefined, adjust: { brightness: 0.2, contrast: 1 }, look: { id: "mono" } };
    expect(await stored({ ...DOC, schemaVersion: 1, tracks: [{ id: "v", kind: "video", clips: [styled] }] })).toMatchObject({ schemaVersion: 3, tracks: [{ clips: [{ adjust: { brightness: 0.2 }, look: { pack: "pib-basic", id: "mono", intensity: 1 } }] }] });
    const layered = { ...clip, keyframes: undefined, blendMode: "multiply", chromaKey: { color: "#00ff00" }, frame: { cornerRadius: 10 } };
    expect(await stored({ ...DOC, schemaVersion: 1, tracks: [{ id: "o", kind: "overlay", clips: [layered] }] })).toMatchObject({ schemaVersion: 4, tracks: [{ clips: [{ blendMode: "multiply", chromaKey: { color: "#00FF00", similarity: 0.1 }, frame: { borderWidth: 0, borderColor: "#FFFFFF", cornerRadius: 10 } }] }] });
    expect(await stored({ ...DOC, schemaVersion: 4, tracks: [{ id: "o", kind: "overlay", clips: [{ ...layered, blendMode: "normal", chromaKey: null, frame: null }] }] })).toMatchObject({ schemaVersion: 1 });
    await expect(enqueueRender(ctx, { companyId: CO, editId: "e", editRevision: 1, doc: { schemaVersion: 5 }, preset: "9:16" })).rejects.toMatchObject({ reason: "unsupported_version", code: "bad_edit" });
  });

  let ctx: PluginContext;
  beforeEach(async () => {
    await pg.reset();
    ctx = ctxs[0];
  });

  it("enqueues a snapshot and claims the oldest queued job; nothing else is claimed while it is active", async () => {
    const first = await enqueue(ctx, "edit-a");
    expect(first).toMatchObject({ status: "queued", attempts: 0, editRevision: 3, preset: "9:16", doc: DOC, client: null });
    const second = await enqueue(ctx, "edit-b");

    const claimed = await claimNextRender(ctx);
    expect(claimed).toMatchObject({ id: first.id, status: "rendering", attempts: 1 });
    expect(claimed!.claimToken).toMatch(/[0-9a-f-]{36}/);
    expect(claimed!.heartbeatAt).not.toBeNull();
    expect(claimed!.startedAt).not.toBeNull();

    expect(await claimNextRender(ctx)).toBeNull();
    expect((await getRender(ctx, CO, second.id)).status).toBe("queued");
    await expect(enqueueRender(ctx, { companyId: CO, editId: "e", editRevision: 0, doc: DOC, preset: "9:16" })).rejects.toMatchObject({ code: "bad_render" });
  });

  it("two claims in parallel on separate connections: exactly one wins, for one and for many queued jobs", async () => {
    for (const queued of [1, 2, 5]) {
      await pg.reset();
      for (let i = 0; i < queued; i++) await enqueue(ctx, `edit-${i}`);
      for (let round = 0; round < 5; round++) {
        await pg.db.execute(`UPDATE ${pg.db.namespace}.video_renders SET status = 'queued', claim_token = NULL`);
        const results = await Promise.all([claimNextRender(ctxs[0]), claimNextRender(ctxs[1]), claimNextRender(ctxs[2]), claimNextRender(ctxs[3])]);
        const winners = results.filter((r) => r !== null);
        expect(winners, `queued=${queued} round=${round}`).toHaveLength(1);
        expect(await activeCount()).toBe(1);
        const owner = await pg.db.query(`SELECT claim_token FROM ${pg.db.namespace}.video_renders WHERE status = 'rendering'`);
        expect(owner[0].claim_token).toBe(winners[0]!.claimToken);
      }
    }
  });

  it("the database itself refuses a second active job (the unique index, not the claim query, is the guarantee)", async () => {
    const a = await enqueue(ctx, "edit-a");
    const b = await enqueue(ctx, "edit-b");
    await pg.db.execute(`UPDATE ${pg.db.namespace}.video_renders SET status = 'rendering' WHERE id = $1`, [a.id]);
    const err = await pg.db.execute(`UPDATE ${pg.db.namespace}.video_renders SET status = 'uploading' WHERE id = $1`, [b.id]).catch((e: unknown) => e);
    expect(isActiveSlotConflict(err)).toBe(true);
    expect(isActiveSlotConflict(new Error("duplicate key value violates unique constraint \"video_renders_one_active\""))).toBe(true);
    expect(isActiveSlotConflict(new Error("connection reset"))).toBe(false);
  });

  it("heartbeats with the claim token only, moves to uploading, and finishes once", async () => {
    await enqueue(ctx);
    const job = (await claimNextRender(ctx))!;
    expect(await heartbeatRender(ctx, job.id, "not-the-token")).toBe(false);
    expect(await heartbeatRender(ctx, job.id, job.claimToken, { pid: 4242, workdir: "/srv/studio/renders/r1" })).toBe(true);
    expect(await heartbeatRender(ctx, job.id, job.claimToken, { stage: "uploading" })).toBe(true);
    expect(await getRender(ctx, CO, job.id)).toMatchObject({ status: "uploading", pid: 4242, workdir: "/srv/studio/renders/r1" });
    await expect(heartbeatRender(ctx, job.id, job.claimToken, { pid: -1 })).rejects.toMatchObject({ code: "bad_render" });

    expect(await finishRender(ctx, job.id, job.claimToken, { status: "succeeded", assetId: "asset-out", previewR2Key: "studio/k/v1.mp4" })).toBe(true);
    expect(await getRender(ctx, CO, job.id)).toMatchObject({ status: "succeeded", assetId: "asset-out", previewR2Key: "studio/k/v1.mp4", error: null });
    expect((await getRender(ctx, CO, job.id)).finishedAt).not.toBeNull();
    expect(await finishRender(ctx, job.id, job.claimToken, { status: "failed", errorKind: "infra", error: "late" })).toBe(false);
    expect(await heartbeatRender(ctx, job.id, job.claimToken)).toBe(false);
  });

  it("fails with an error kind and a capped stderr tail, freeing the slot; bad kinds are refused", async () => {
    await enqueue(ctx, "edit-a");
    const next = await enqueue(ctx, "edit-b");
    const job = (await claimNextRender(ctx))!;
    await expect(finishRender(ctx, job.id, job.claimToken, { status: "failed", errorKind: "flaky" as never, error: "x" })).rejects.toMatchObject({ code: "bad_render" });
    expect(await finishRender(ctx, job.id, job.claimToken, { status: "failed", errorKind: "deterministic", error: "unsupported_feature:keyframes", stderrTail: "e".repeat(10_000) + "END" })).toBe(true);
    const failed = await getRender(ctx, CO, job.id);
    expect(failed).toMatchObject({ status: "failed", errorKind: "deterministic", error: "unsupported_feature:keyframes" });
    expect(failed.stderrTail).toHaveLength(4_096);
    expect(failed.stderrTail!.endsWith("END")).toBe(true);
    expect((await claimNextRender(ctx))!.id).toBe(next.id);
  });

  it("requeues an infra failure with its attempts kept, and the next claim counts a second attempt", async () => {
    await enqueue(ctx);
    const job = (await claimNextRender(ctx))!;
    expect(await requeueRender(ctx, job.id, "wrong", { error: "x" })).toBe(false);
    expect(await requeueRender(ctx, job.id, job.claimToken, { error: "worker restarted" })).toBe(true);
    expect(await getRender(ctx, CO, job.id)).toMatchObject({ status: "queued", attempts: 1, errorKind: "infra", error: "worker restarted", pid: null, heartbeatAt: null });
    expect(await heartbeatRender(ctx, job.id, job.claimToken)).toBe(false);
    const again = (await claimNextRender(ctx))!;
    expect(again).toMatchObject({ id: job.id, attempts: 2, errorKind: null, error: null });
    expect(again.claimToken).not.toBe(job.claimToken);
  });

  it("lists active jobs by heartbeat age only", async () => {
    await enqueue(ctx, "edit-a");
    await enqueue(ctx, "edit-b");
    const job = (await claimNextRender(ctx))!;
    expect(await listStaleRenders(ctx, 60)).toEqual([]);
    await setHeartbeat(job.id, 90);
    const stale = await listStaleRenders(ctx, 60);
    expect(stale.map((s) => [s.id, s.claimToken])).toEqual([[job.id, job.claimToken]]);
    expect(await listStaleRenders(ctx, 120)).toEqual([]);
    await heartbeatRender(ctx, job.id, job.claimToken);
    expect(await listStaleRenders(ctx, 60)).toEqual([]);
    // Ended jobs are never stale, however old.
    await setHeartbeat(job.id, 900);
    await finishRender(ctx, job.id, job.claimToken, { status: "failed", errorKind: "infra", error: "x" });
    await setHeartbeat(job.id, 900);
    expect(await listStaleRenders(ctx, 60)).toEqual([]);
    await expect(listStaleRenders(ctx, 0)).rejects.toMatchObject({ code: "bad_render" });
  });

  it("cancels a queued job: it is never claimed", async () => {
    const job = await enqueue(ctx);
    const out = await cancelRender(ctx, CO, job.id);
    expect(out).toMatchObject({ cancelled: true, running: null, render: { status: "cancelled" } });
    expect(out.render.finishedAt).not.toBeNull();
    expect(await claimNextRender(ctx)).toBeNull();
    expect(await cancelRender(ctx, CO, job.id)).toMatchObject({ cancelled: false, render: { status: "cancelled" } });
  });

  it("cancels a running job: returns its process for the kill, frees the slot, and the runner's next write is refused", async () => {
    await enqueue(ctx, "edit-a");
    const next = await enqueue(ctx, "edit-b");
    const job = (await claimNextRender(ctx))!;
    await heartbeatRender(ctx, job.id, job.claimToken, { pid: 777, workdir: "/srv/studio/renders/r9" });

    await expect(cancelRender(ctx, OTHER_CO, job.id)).rejects.toMatchObject({ code: "unknown_render" });
    const out = await cancelRender(ctx, CO, job.id);
    expect(out).toMatchObject({ cancelled: true, running: { pid: 777, workdir: "/srv/studio/renders/r9" }, render: { status: "cancelled" } });
    expect(await heartbeatRender(ctx, job.id, job.claimToken)).toBe(false);
    expect(await finishRender(ctx, job.id, job.claimToken, { status: "succeeded", assetId: "a" })).toBe(false);
    expect((await getRender(ctx, CO, job.id)).status).toBe("cancelled");
    expect((await claimNextRender(ctx))!.id).toBe(next.id);
  });

  it("does not cancel a finished job, and keeps renders inside their company", async () => {
    const theirs = await enqueue(ctx, "edit-x", OTHER_CO);
    await expect(getRender(ctx, CO, theirs.id)).rejects.toMatchObject({ code: "unknown_render" });
    const job = (await claimNextRender(ctx))!;
    await finishRender(ctx, job.id, job.claimToken, { status: "succeeded", assetId: "asset-1" });
    expect(await cancelRender(ctx, OTHER_CO, job.id)).toMatchObject({ cancelled: false, running: null, render: { status: "succeeded" } });
  });
});
