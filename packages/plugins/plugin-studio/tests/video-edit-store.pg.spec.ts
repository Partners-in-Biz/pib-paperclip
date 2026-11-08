import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  archiveVideoEdit,
  createVideoEdit,
  deleteVideoEdit,
  getVideoEdit,
  listEditVersions,
  listVideoEdits,
  MAX_EDIT_VERSIONS,
  restoreEditVersion,
  saveEditVersion,
  saveVideoEdit,
} from "../src/video-edit/store.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER_CO = "22222222-2222-4222-8222-222222222222";
const USER = { userId: "owner-1" };
const AGENT = { agentId: "agent-1" };

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

async function addAsset(id: string, companyId: string, client: { kind: string; id: string } | null) {
  await pg.db.execute(
    `INSERT INTO ${pg.db.namespace}.assets (id, company_id, client_kind, client_ref, name, kind, source) VALUES ($1, $2, $3, $4, 'x.mp4', 'video', 'upload')`,
    [id, companyId, client?.kind ?? null, client?.id ?? null],
  );
}

/** Test-only: moves an edit to a client (creating one for a client needs the CRM, which this harness doesn't have). */
async function setClient(editId: string, client: { kind: string; id: string }) {
  await pg.db.execute(`UPDATE ${pg.db.namespace}.video_edits SET client_kind = $1, client_ref = $2, client_name = 'Acme' WHERE id = $3`, [client.kind, client.id, editId]);
}

const timeline = (assetId: string, out = 4) => ({
  schemaVersion: 1,
  project: { size: "9:16", fps: 30 },
  tracks: [{ id: "v", kind: "video", clips: [{ id: "c", assetId, version: 1, in: 0, out, start: 0 }] }],
});

describe.skipIf(!available)("Video edit store against real Postgres", () => {
  let ctx: PluginContext;
  beforeEach(async () => {
    await pg.reset();
    ctx = makeCtx();
  });

  it("creates, saves and reopens an edit; a stale save is refused with edit_conflict", async () => {
    await addAsset("asset-own", CO, null);
    const made = await createVideoEdit(ctx, CO, { title: "  First cut " }, USER);
    expect(made).toMatchObject({ title: "First cut", revision: 1, clips: 0, client: null, size: "9:16", duration: 0 });

    expect(await saveVideoEdit(ctx, CO, { editId: made.id, baseRevision: 1, doc: timeline("asset-own") }, AGENT)).toEqual({ id: made.id, revision: 2 });
    const back = await getVideoEdit(ctx, CO, made.id);
    expect(back).toMatchObject({ revision: 2, clips: 1, duration: 4 });
    expect(back.doc.tracks[0].clips[0]).toMatchObject({ assetId: "asset-own", out: 4 });

    // A second tab still on revision 1.
    const stale = saveVideoEdit(ctx, CO, { editId: made.id, baseRevision: 1, doc: timeline("asset-own", 2) }, USER);
    await expect(stale).rejects.toMatchObject({ code: "edit_conflict" });
    await expect(saveVideoEdit(ctx, CO, { editId: made.id, baseRevision: 1, doc: timeline("asset-own", 2) }, USER)).rejects.toThrow(/now revision 2/);
    expect((await getVideoEdit(ctx, CO, made.id)).duration).toBe(4);

    // Two saves racing from the same base: exactly one wins.
    const race = await Promise.allSettled([
      saveVideoEdit(ctx, CO, { editId: made.id, baseRevision: 2, doc: timeline("asset-own", 3) }, USER),
      saveVideoEdit(ctx, CO, { editId: made.id, baseRevision: 2, doc: timeline("asset-own", 1) }, AGENT),
    ]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await getVideoEdit(ctx, CO, made.id)).revision).toBe(3);

    await expect(saveVideoEdit(ctx, CO, { editId: made.id, doc: timeline("asset-own") }, USER)).rejects.toThrow(/baseRevision/);
    await expect(saveVideoEdit(ctx, CO, { editId: made.id, baseRevision: 3, doc: { tracks: "x" } }, USER)).rejects.toMatchObject({ code: "bad_edit" });
  });

  it("keeps companies apart", async () => {
    await addAsset("asset-other-co", OTHER_CO, null);
    const made = await createVideoEdit(ctx, CO, { title: "Mine" }, USER);
    await expect(getVideoEdit(ctx, OTHER_CO, made.id)).rejects.toMatchObject({ code: "unknown_edit" });
    await expect(saveVideoEdit(ctx, OTHER_CO, { editId: made.id, baseRevision: 1, doc: { tracks: [] } }, USER)).rejects.toThrow(/not found/);
    await expect(archiveVideoEdit(ctx, OTHER_CO, made.id)).rejects.toThrow(/not found/);
    await expect(saveEditVersion(ctx, OTHER_CO, { editId: made.id, name: "v" }, USER)).rejects.toThrow(/not found/);
    await expect(listEditVersions(ctx, OTHER_CO, made.id)).rejects.toThrow(/not found/);
    expect(await listVideoEdits(ctx, OTHER_CO, {})).toEqual([]);
    // Another company's asset can't go on the timeline.
    await expect(saveVideoEdit(ctx, CO, { editId: made.id, baseRevision: 1, doc: timeline("asset-other-co") }, USER)).rejects.toThrow(/not in this company/);
    await expect(createVideoEdit(ctx, CO, { title: "x", sourceAssetId: "asset-other-co" }, USER)).rejects.toThrow(/not in this company/);
    await expect(createVideoEdit(ctx, CO, { title: "x", projectId: "project-elsewhere" }, USER)).rejects.toThrow(/Project project-elsewhere/);
    expect(await listVideoEdits(ctx, CO, {})).toHaveLength(1);
  });

  it("keeps clients apart: assets must match the edit's client, and the list filters by client", async () => {
    await addAsset("asset-acme", CO, { kind: "company", id: "acme" });
    await addAsset("asset-own", CO, null);
    const own = await createVideoEdit(ctx, CO, { title: "Own work" }, USER);
    const acme = await createVideoEdit(ctx, CO, { title: "Acme ad" }, USER);
    await setClient(acme.id, { kind: "company", id: "acme" });

    await expect(saveVideoEdit(ctx, CO, { editId: own.id, baseRevision: 1, doc: timeline("asset-acme") }, USER)).rejects.toThrow(/another client/);
    await expect(saveVideoEdit(ctx, CO, { editId: acme.id, baseRevision: 1, doc: timeline("asset-own") }, USER)).rejects.toThrow(/another client/);
    expect(await saveVideoEdit(ctx, CO, { editId: acme.id, baseRevision: 1, doc: timeline("asset-acme") }, USER)).toEqual({ id: acme.id, revision: 2 });
    await expect(createVideoEdit(ctx, CO, { title: "x", sourceAssetId: "asset-acme" }, USER)).rejects.toThrow(/another client/);
    await expect(createVideoEdit(ctx, CO, { title: "x", client: "nonsense" }, USER)).rejects.toMatchObject({ code: "bad_client" });

    expect((await listVideoEdits(ctx, CO, { client: "own" })).map((e) => e.title)).toEqual(["Own work"]);
    const acmeList = await listVideoEdits(ctx, CO, { client: "company:acme" });
    expect(acmeList.map((e) => [e.title, e.client])).toEqual([["Acme ad", { kind: "company", id: "acme", name: "Acme" }]]);
    expect(await listVideoEdits(ctx, CO, { client: "contact:acme" })).toEqual([]);
    expect(await listVideoEdits(ctx, CO, {})).toHaveLength(2);

    await archiveVideoEdit(ctx, CO, acme.id);
    expect(await listVideoEdits(ctx, CO, { client: "company:acme" })).toEqual([]);
    await expect(getVideoEdit(ctx, CO, acme.id)).rejects.toThrow(/not found/);
    await expect(saveVideoEdit(ctx, CO, { editId: acme.id, baseRevision: 2, doc: { tracks: [] } }, USER)).rejects.toThrow(/not found/);
  });

  it("deletes an edit and its versions; refuses while a render is active or for another client/company; keeps rendered assets", async () => {
    await addAsset("asset-own", CO, null);
    await addAsset("asset-rendered", CO, null);
    const own = await createVideoEdit(ctx, CO, { title: "Own work" }, USER);
    const acme = await createVideoEdit(ctx, CO, { title: "Acme ad" }, USER);
    await setClient(acme.id, { kind: "company", id: "acme" });
    await saveEditVersion(ctx, CO, { editId: own.id, name: "v1" }, USER);
    const ns = pg.db.namespace;
    const addRender = (id: string, editId: string, status: string, assetId: string | null = null) =>
      pg.db.execute(`INSERT INTO ${ns}.video_renders (id, company_id, edit_id, edit_revision, doc, preset, status, asset_id) VALUES ($1, $2, $3, 1, '{}'::jsonb, '9:16', $4, $5)`, [id, CO, editId, status, assetId]);

    await expect(deleteVideoEdit(ctx, OTHER_CO, own.id)).rejects.toMatchObject({ code: "unknown_edit" });
    await expect(deleteVideoEdit(ctx, CO, acme.id, "own")).rejects.toMatchObject({ code: "wrong_client" });
    await expect(deleteVideoEdit(ctx, CO, own.id, "company:acme")).rejects.toMatchObject({ code: "wrong_client" });
    expect(await listVideoEdits(ctx, CO, {})).toHaveLength(2);

    for (const [i, status] of ["queued", "rendering", "uploading"].entries()) {
      await addRender(`r${i}`, own.id, status);
      await expect(deleteVideoEdit(ctx, CO, own.id)).rejects.toMatchObject({ code: "render_active" });
      await pg.db.execute(`UPDATE ${ns}.video_renders SET status = 'cancelled' WHERE id = $1`, [`r${i}`]);
    }
    expect(await listEditVersions(ctx, CO, own.id)).toHaveLength(1);

    await addRender("done", own.id, "succeeded", "asset-rendered");
    expect(await deleteVideoEdit(ctx, CO, own.id, "own")).toEqual({ id: own.id, deleted: true });
    expect(await pg.db.query(`SELECT id FROM ${ns}.video_edit_versions WHERE edit_id = $1`, [own.id])).toEqual([]);
    await expect(getVideoEdit(ctx, CO, own.id)).rejects.toThrow(/not found/);
    await expect(deleteVideoEdit(ctx, CO, own.id)).rejects.toMatchObject({ code: "unknown_edit" });
    const kept = await pg.db.query(`SELECT id FROM ${ns}.assets WHERE id = 'asset-rendered'`);
    expect(kept).toHaveLength(1);
    expect((await listVideoEdits(ctx, CO, {})).map((e) => e.title)).toEqual(["Acme ad"]);
    expect(await deleteVideoEdit(ctx, CO, acme.id, "company:acme")).toMatchObject({ deleted: true });
  });

  it("saves versions of the saved timeline, at most MAX_EDIT_VERSIONS per edit", async () => {
    const made = await createVideoEdit(ctx, CO, { title: "Versions" }, USER);
    const v = await saveEditVersion(ctx, CO, { editId: made.id, name: "  Empty " }, AGENT);
    expect(v).toMatchObject({ name: "Empty", revision: 1 });
    await expect(saveEditVersion(ctx, CO, { editId: made.id, name: "   " }, USER)).rejects.toThrow(/name/);

    // Fill up to the cap directly, then the next one is refused.
    for (let i = 1; i < MAX_EDIT_VERSIONS; i++) {
      await pg.db.execute(
        `INSERT INTO ${pg.db.namespace}.video_edit_versions (id, company_id, edit_id, name, doc, revision) VALUES ($1, $2, $3, $4, '{}'::jsonb, 1)`,
        [`v-${i}`, CO, made.id, `v${i}`],
      );
    }
    await expect(saveEditVersion(ctx, CO, { editId: made.id, name: "One too many" }, USER)).rejects.toThrow(`at most ${MAX_EDIT_VERSIONS} versions`);
    const versions = await listEditVersions(ctx, CO, made.id);
    expect(versions).toHaveLength(MAX_EDIT_VERSIONS);
    expect(versions.find((x) => x.id === v.id)).toMatchObject({ name: "Empty", createdByAgentId: "agent-1" });

    // The cap is per edit: another edit still takes versions.
    const other = await createVideoEdit(ctx, CO, { title: "Other" }, USER);
    await expect(saveEditVersion(ctx, CO, { editId: other.id, name: "First" }, USER)).resolves.toMatchObject({ revision: 1 });
  });

  it("video_renders lets only one job be rendering or uploading at a time", async () => {
    const insert = (id: string, status: string) =>
      pg.db.execute(
        `INSERT INTO ${pg.db.namespace}.video_renders (id, company_id, edit_id, edit_revision, doc, preset, status) VALUES ($1, $2, 'e', 1, '{}'::jsonb, 'final', $3)`,
        [id, CO, status],
      );
    await insert("r1", "rendering");
    await insert("r2", "queued");
    await insert("r3", "succeeded");
    await expect(insert("r4", "uploading")).rejects.toThrow(/video_renders_one_active|unique/);
    await expect(insert("r5", "bogus")).rejects.toThrow(/check/i);
    await pg.db.execute(`UPDATE ${pg.db.namespace}.video_renders SET status = 'failed' WHERE id = 'r1'`, []);
    await expect(insert("r6", "uploading")).resolves.toBeTruthy();
  });

  it("restores a version as a new revision, refuses a stale base, and stays inside company and client", async () => {
    await addAsset("asset-own", CO, null);
    const made = await createVideoEdit(ctx, CO, { title: "Cut" }, USER);
    await saveVideoEdit(ctx, CO, { editId: made.id, baseRevision: 1, doc: timeline("asset-own", 4) }, USER);
    const v = await saveEditVersion(ctx, CO, { editId: made.id, name: "Four seconds" }, USER); // at revision 2
    await saveVideoEdit(ctx, CO, { editId: made.id, baseRevision: 2, doc: timeline("asset-own", 2) }, AGENT);

    // Stale base: refused, nothing changes.
    await expect(restoreEditVersion(ctx, CO, { editId: made.id, versionId: v.id, baseRevision: 2 }, USER)).rejects.toMatchObject({ code: "edit_conflict" });
    expect((await getVideoEdit(ctx, CO, made.id)).revision).toBe(3);

    const out = await restoreEditVersion(ctx, CO, { editId: made.id, versionId: v.id, baseRevision: 3 }, USER);
    expect(out).toMatchObject({ revision: 4, restoredVersionId: v.id, keptPrevious: true });
    const back = await getVideoEdit(ctx, CO, made.id);
    expect(back.revision).toBe(4);
    expect(back.duration).toBe(4);
    const names = (await listEditVersions(ctx, CO, made.id)).map((x) => x.name);
    expect(names).toContain("Four seconds");
    expect(names).toContain("Before restore (revision 3)");

    await expect(restoreEditVersion(ctx, CO, { editId: made.id, versionId: "nope", baseRevision: 4 }, USER)).rejects.toMatchObject({ code: "unknown_version" });
    await expect(restoreEditVersion(ctx, CO, { editId: made.id, versionId: v.id }, USER)).rejects.toThrow(/baseRevision/);
    // Another company can't restore it; a version of another edit isn't found.
    await expect(restoreEditVersion(ctx, OTHER_CO, { editId: made.id, versionId: v.id, baseRevision: 4 }, USER)).rejects.toThrow(/not found/);
    const other = await createVideoEdit(ctx, CO, { title: "Other" }, USER);
    await expect(restoreEditVersion(ctx, CO, { editId: other.id, versionId: v.id, baseRevision: 1 }, USER)).rejects.toMatchObject({ code: "unknown_version" });

    // Client scope: an asset that moved to another client blocks the restore.
    await setClient(made.id, { kind: "company", id: "acme" });
    await expect(restoreEditVersion(ctx, CO, { editId: made.id, versionId: v.id, baseRevision: 4 }, USER)).rejects.toThrow(/another client/);
    expect((await getVideoEdit(ctx, CO, made.id)).revision).toBe(4);
  });
});
