import { describe, expect, it, vi } from "vitest";
import { createEditorStore, isEditConflict, type EditorApi } from "../src/ui/editor/editor-store.js";

const doc = (clips: string[] = ["c1"]) => ({
  schemaVersion: 1,
  project: { size: "9:16", width: 1080, height: 1920, fps: 30 },
  tracks: [{ id: "v1", kind: "video", clips: clips.map((id) => ({ id })) }],
});
const edit = (revision: number, clips?: string[]) => ({ id: "e1", name: "Ad", revision, doc: doc(clips) });

function make(over: Partial<EditorApi> = {}) {
  const api = { get: vi.fn(async () => edit(1)), applyOps: vi.fn(async () => ({ id: "e1", revision: 2, doc: doc(["c1", "c2"]), duration: 5 })), ...over } as unknown as EditorApi & { get: ReturnType<typeof vi.fn>; applyOps: ReturnType<typeof vi.fn> };
  return { api, store: createEditorStore(api) };
}

describe("editor store", () => {
  it("loads an edit", async () => {
    const { store } = make();
    await store.load("e1");
    expect(store.getState()).toMatchObject({ status: "ready", revision: 1, error: null });
  });
  it("errors on a missing id and an unknown edit", async () => {
    const { store, api } = make();
    await store.load(null);
    expect(store.getState().status).toBe("error");
    api.get.mockRejectedValueOnce(new Error("Video edit not found."));
    await store.load("nope");
    expect(store.getState()).toMatchObject({ status: "error", error: "Video edit not found." });
  });
  it("applies ops with the revision and adopts the answer", async () => {
    const { store, api } = make();
    await store.load("e1");
    store.selectClip("c1");
    expect(await store.applyOps([{ op: "delete", clipId: "x" }])).toBe(true);
    expect(api.applyOps).toHaveBeenCalledWith({ editId: "e1", baseRevision: 1, ops: [{ op: "delete", clipId: "x" }] });
    expect(store.getState()).toMatchObject({ revision: 2, selectedClipId: "c1", busy: false, toast: null });
  });
  it("reloads and toasts on edit_conflict", async () => {
    const { store, api } = make();
    await store.load("e1");
    api.applyOps.mockRejectedValueOnce(Object.assign(new Error("Someone saved this video edit"), { code: "edit_conflict" }));
    api.get.mockResolvedValueOnce(edit(5, ["z"]));
    const statuses: string[] = [];
    store.subscribe(() => statuses.push(store.getState().status));
    expect(await store.applyOps([])).toBe(false);
    expect(statuses).not.toContain("loading"); // the panels stay mounted during the reload
    expect(store.getState()).toMatchObject({ revision: 5, status: "ready", busy: false });
    expect(store.getState().toast).toMatch(/Someone else/);
    expect(isEditConflict(new Error("edit_conflict"))).toBe(true);
  });
  it("shows a network error and keeps the edit", async () => {
    const { store, api } = make();
    await store.load("e1");
    api.applyOps.mockRejectedValueOnce(new Error("Request failed: 502"));
    expect(await store.applyOps([])).toBe(false);
    expect(store.getState()).toMatchObject({ revision: 1, status: "ready", toast: "Request failed: 502" });
  });
  it("tracks playhead and selection", async () => {
    const { store } = make();
    await store.load("e1");
    store.setPlayhead(-3);
    expect(store.getState().playhead).toBe(0);
    store.setPlayhead(2.5);
    store.selectClip("c1");
    expect(store.getState()).toMatchObject({ playhead: 2.5, selectedClipId: "c1" });
  });
});
