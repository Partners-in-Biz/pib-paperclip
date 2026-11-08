import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  applyOpsAction,
  cancelRenderAction,
  createEditAction,
  getEditAction,
  IMAGE_SECONDS,
  listEditsAction,
  MAX_QUEUED_RENDERS,
  renderAction,
  renderStatusAction,
  type StartAsset,
} from "../src/video-edit/actions.js";
import type { ProbeResult } from "../src/video-edit/probe.js";
import { getRender } from "../src/video-edit/render-queue.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER_CO = "22222222-2222-4222-8222-222222222222";
const ACME = { kind: "company", id: "acme" };
const BETA = { kind: "company", id: "beta" };
const USER = { userId: "owner-1" };

const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

function makeCtx(): PluginContext {
  return {
    db: pg.db,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    state: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    projects: { get: async () => null },
  } as unknown as PluginContext;
}

async function addAsset(id: string, companyId: string, client: { kind: string; id: string } | null, kind = "video") {
  const ns = pg.db.namespace;
  await pg.db.execute(
    `INSERT INTO ${ns}.assets (id, company_id, client_kind, client_ref, name, kind, source) VALUES ($1, $2, $3, $4, $5, $6, 'upload')`,
    [id, companyId, client?.kind ?? null, client?.id ?? null, `${id}.bin`, kind],
  );
  await pg.db.execute(
    `INSERT INTO ${ns}.asset_versions (asset_id, version, company_id, r2_key, mime, bytes, sha256) VALUES ($1, 1, $2, $3, 'video/mp4', 10, 'x')`,
    [id, companyId, `studio/${companyId}/own/${id}/v1.mp4`],
  );
}

/** Test-only: moves an edit or asset to a client (creating one for a client needs the CRM, which this harness doesn't have). */
async function setClient(tableName: "video_edits" | "assets", id: string, client: { kind: string; id: string } | null) {
  await pg.db.execute(`UPDATE ${pg.db.namespace}.${tableName} SET client_kind = $1, client_ref = $2 WHERE id = $3`, [client?.kind ?? null, client?.id ?? null, id]);
}

const probeResult = (durationSec: number, hasVideo = true, hasAudio = true): ProbeResult => ({
  durationSec, width: 1080, height: 1920, fps: 30, videoCodec: hasVideo ? "h264" : null, audioCodec: hasAudio ? "aac" : null,
  hasVideo, hasAudio, formatName: "mp4", sizeBytes: 10,
});

function fakeProbe(lengths: Record<string, ProbeResult>) {
  const probed: string[] = [];
  return {
    probed,
    probe: async (asset: StartAsset) => {
      probed.push(asset.id);
      return lengths[asset.id] ?? probeResult(5);
    },
  };
}

const addClip = (assetId: string, clipId = "c2", start = 10) => ({ op: "addClip", trackId: "video", clip: { id: clipId, assetId, version: 1, in: 0, out: 2, start } });

describe.skipIf(!available)("Video edit actions against real Postgres", () => {
  let ctx: PluginContext;
  beforeEach(async () => {
    await pg.reset();
    ctx = makeCtx();
  });

  it("creates an edit from assets, back to back, with probed lengths; sound-only files go on an audio track", async () => {
    await addAsset("vid", CO, null);
    await addAsset("pic", CO, null, "image");
    await addAsset("song", CO, null);
    const { probe, probed } = fakeProbe({ vid: probeResult(4.25), song: probeResult(30, false, true) });
    const edit = await createEditAction(ctx, CO, { title: "From library", assetIds: ["vid", "pic", "song"] }, USER, { probe });
    expect(probed).toEqual(["vid", "song"]); // a picture is never probed
    expect(edit).toMatchObject({ revision: 1, clips: 3, sourceAssetId: "vid", duration: 30 });
    const [video, audio] = edit.doc.tracks;
    expect(video).toMatchObject({ id: "video", kind: "video" });
    expect(video!.clips.map((c) => [("assetId" in c && c.assetId), c.start, "out" in c && c.out])).toEqual([["vid", 0, 4.25], ["pic", 4.25, IMAGE_SECONDS]]);
    expect(audio).toMatchObject({ id: "audio", kind: "audio", clips: [{ assetId: "song", start: 0, out: 30 }] });
    expect((await listEditsAction(ctx, CO, {})).edits.map((e) => e.id)).toEqual([edit.id]);
    expect(await getEditAction(ctx, CO, { editId: edit.id })).toMatchObject({ id: edit.id, revision: 1 });
  });

  it("names the edit after the first asset when no title is given", async () => {
    await addAsset("named", CO, null);
    const { probe } = fakeProbe({ named: probeResult(3) });
    const edit = await createEditAction(ctx, CO, { assetIds: ["named"] }, USER, { probe });
    expect(edit.title).toBe("named");
  });

  it("caps a start-from-assets timeline at 180 s and refuses assets that do not fit at all", async () => {
    await addAsset("long", CO, null);
    await addAsset("more", CO, null);
    const { probe } = fakeProbe({ long: probeResult(500) });
    const edit = await createEditAction(ctx, CO, { title: "Long", assetIds: ["long"] }, USER, { probe });
    expect(edit.duration).toBe(180);
    await expect(createEditAction(ctx, CO, { title: "Too long", assetIds: ["long", "more"] }, USER, { probe })).rejects.toMatchObject({ code: "too_long" });
  });

  it("refuses an asset of another company before probing it", async () => {
    await addAsset("mine", CO, null);
    await addAsset("theirs", OTHER_CO, null);
    const { probe, probed } = fakeProbe({});
    await expect(createEditAction(ctx, CO, { title: "X", assetIds: ["mine", "theirs"] }, USER, { probe })).rejects.toMatchObject({ code: "bad_edit", message: expect.stringContaining("theirs") });
    expect(probed).toEqual([]);
    // A doc naming it is refused too.
    await expect(createEditAction(ctx, CO, { title: "X", doc: { tracks: [{ id: "video", kind: "video", clips: [{ id: "c", assetId: "theirs", version: 1, in: 0, out: 1, start: 0 }] }] } }, USER)).rejects.toMatchObject({ code: "bad_edit" });
    expect((await listEditsAction(ctx, CO, {})).edits).toEqual([]);
  });

  it("refuses a client's asset in own work before probing it", async () => {
    await addAsset("acme-clip", CO, ACME);
    const { probe, probed } = fakeProbe({});
    await expect(createEditAction(ctx, CO, { title: "X", assetIds: ["acme-clip"] }, USER, { probe })).rejects.toMatchObject({ message: expect.stringContaining("another client") });
    expect(probed).toEqual([]);
  });

  it("apply-ops: saves all ops at once, refuses other-company and other-client assets, and a stale revision is edit_conflict", async () => {
    await addAsset("a1", CO, ACME);
    await addAsset("a2", CO, ACME);
    await addAsset("b1", CO, BETA);
    await addAsset("own", CO, null);
    await addAsset("far", OTHER_CO, ACME);
    const edit = await createEditAction(ctx, CO, { title: "Acme ad" }, USER);
    await setClient("video_edits", edit.id, ACME);

    const first = await applyOpsAction(ctx, CO, { editId: edit.id, baseRevision: 1, ops: [{ op: "addTrack", track: { id: "video", kind: "video" } }, addClip("a1", "c1", 0), addClip("a2", "c2", 2)] }, USER);
    expect(first).toMatchObject({ id: edit.id, revision: 2, duration: 4 });

    for (const foreign of ["b1", "own", "far"]) {
      await expect(applyOpsAction(ctx, CO, { editId: edit.id, baseRevision: 2, ops: [addClip(foreign, "c3", 4)] }, USER)).rejects.toMatchObject({ code: "bad_edit" });
    }
    // A bad op later in the list applies nothing.
    await expect(applyOpsAction(ctx, CO, { editId: edit.id, baseRevision: 2, ops: [addClip("a1", "c3", 4), { op: "delete", clipId: "nope" }] }, USER)).rejects.toMatchObject({ code: "bad_edit" });
    expect((await getEditAction(ctx, CO, { editId: edit.id })).revision).toBe(2);

    await expect(applyOpsAction(ctx, CO, { editId: edit.id, baseRevision: 1, ops: [addClip("a1", "c3", 4)] }, USER)).rejects.toMatchObject({ code: "edit_conflict" });
    await expect(applyOpsAction(ctx, OTHER_CO, { editId: edit.id, baseRevision: 2, ops: [] }, USER)).rejects.toMatchObject({ code: "unknown_edit" });
  });

  it("render snapshots the saved doc; status, cancel, stale revision and asset moved to another client", async () => {
    await addAsset("v", CO, null);
    const { probe } = fakeProbe({ v: probeResult(6) });
    const edit = await createEditAction(ctx, CO, { title: "Cut", assetIds: ["v"] }, USER, { probe });

    await expect(renderAction(ctx, CO, { editId: edit.id, baseRevision: 5 }, USER)).rejects.toMatchObject({ code: "edit_conflict" });
    const queued = await renderAction(ctx, CO, { editId: edit.id, baseRevision: 1 }, USER);
    expect(queued).toMatchObject({ editId: edit.id, editRevision: 1, preset: "9:16", status: "queued", assetId: null, hasPreview: false });
    expect(queued).not.toHaveProperty("doc");

    // A later save does not change the queued render.
    await applyOpsAction(ctx, CO, { editId: edit.id, baseRevision: 1, ops: [{ op: "trim", clipId: "clip-1", out: 3 }] }, USER);
    const job = await getRender(ctx, CO, queued.id);
    expect((job.doc as { tracks: Array<{ clips: Array<{ out: number }> }> }).tracks[0]!.clips[0]!.out).toBe(6);

    expect(await renderStatusAction(ctx, CO, { renderId: queued.id })).toMatchObject({ id: queued.id, status: "queued" });
    await expect(renderStatusAction(ctx, OTHER_CO, { renderId: queued.id })).rejects.toBeTruthy();
    await expect(cancelRenderAction(ctx, OTHER_CO, { renderId: queued.id }, USER)).rejects.toBeTruthy();
    expect(await cancelRenderAction(ctx, CO, { renderId: queued.id }, USER)).toMatchObject({ cancelled: true, render: { status: "cancelled" } });
    expect(await cancelRenderAction(ctx, CO, { renderId: queued.id }, USER)).toMatchObject({ cancelled: false });

    // The asset moved to a client after the save: the render is refused.
    await setClient("assets", "v", ACME);
    await expect(renderAction(ctx, CO, { editId: edit.id }, USER)).rejects.toMatchObject({ message: expect.stringContaining("another client") });
  });

  it("refuses an empty edit and more than the queue cap", async () => {
    await addAsset("v", CO, null);
    const empty = await createEditAction(ctx, CO, { title: "Empty" }, USER);
    await expect(renderAction(ctx, CO, { editId: empty.id }, USER)).rejects.toMatchObject({ code: "bad_edit" });
    const edit = await createEditAction(ctx, CO, { title: "Cut", assetIds: ["v"] }, USER, fakeProbe({}));
    for (let i = 0; i < MAX_QUEUED_RENDERS; i++) await renderAction(ctx, CO, { editId: edit.id }, USER);
    await expect(renderAction(ctx, CO, { editId: edit.id }, USER)).rejects.toMatchObject({ code: "render_busy" });
  });
});
