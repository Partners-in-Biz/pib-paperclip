/**
 * The video editor's state (PAR-8313): the edit document, its revision, the playhead and the selected clip.
 * Plain TypeScript with injected actions so it is tested without React; EditorPage wires it to the real
 * `video-edit-get` and `video-edit-apply-ops` actions. Every change is an ops batch sent with the revision the page
 * holds; the worker owns the rules, the UI never builds ffmpeg arguments.
 */
import type { EditDoc } from "../../video-edit/timeline.js";

export interface EditorEdit {
  id: string;
  name?: string;
  revision: number;
  duration?: number;
  doc: EditDoc;
}

export interface EditorApi {
  get(editId: string): Promise<unknown>;
  applyOps(params: { editId: string; baseRevision: number; ops: unknown[] }): Promise<unknown>;
}

export type EditorStatus = "idle" | "loading" | "ready" | "error";

export interface EditorState {
  status: EditorStatus;
  edit: EditorEdit | null;
  /** The doc, or null before load. */
  doc: EditDoc | null;
  revision: number | null;
  playhead: number;
  selectedClipId: string | null;
  /** Load failure: shown as the page's error state. */
  error: string | null;
  /** Apply failure or conflict: shown as a toast, the page stays usable. */
  toast: string | null;
  busy: boolean;
}

const INITIAL: EditorState = { status: "idle", edit: null, doc: null, revision: null, playhead: 0, selectedClipId: null, error: null, toast: null, busy: false };

export function isEditConflict(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e && e.code === "edit_conflict") return true;
  return typeof e?.message === "string" && e.message.includes("edit_conflict");
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return text.trim() || "Something went wrong. Try again.";
}

function toEdit(raw: unknown): EditorEdit | null {
  const o = raw as Partial<EditorEdit> | null;
  if (!o || typeof o !== "object" || typeof o.id !== "string" || typeof o.revision !== "number" || !o.doc || !Array.isArray(o.doc.tracks)) return null;
  return o as EditorEdit;
}

export function clipCount(doc: EditDoc | null): number {
  return doc ? doc.tracks.reduce((n, t) => n + t.clips.length, 0) : 0;
}

export interface EditorStore {
  getState(): EditorState;
  subscribe(listener: () => void): () => void;
  load(editId: string | null): Promise<void>;
  applyOps(ops: unknown[]): Promise<boolean>;
  setPlayhead(seconds: number): void;
  selectClip(clipId: string | null): void;
  dismissToast(): void;
}

export function createEditorStore(api: EditorApi): EditorStore {
  let state: EditorState = INITIAL;
  let editId: string | null = null;
  let loadSeq = 0;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<EditorState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  const adopt = (edit: EditorEdit, extra: Partial<EditorState> = {}) => {
    const clipId = state.selectedClipId;
    const stillThere = clipId !== null && edit.doc.tracks.some((t) => t.clips.some((c) => c.id === clipId));
    set({ edit, doc: edit.doc, revision: edit.revision, selectedClipId: stillThere ? clipId : null, ...extra });
  };

  async function load(id: string | null): Promise<void> {
    const seq = ++loadSeq;
    editId = id && id.trim() ? id.trim() : null;
    if (!editId) {
      state = { ...INITIAL };
      set({ status: "error", error: "No video edit was chosen. Open one from the Studio library." });
      return;
    }
    // First load shows "loading"; a reload of the same edit keeps the current doc on screen until the new one arrives.
    const reload = state.status === "ready" && state.edit?.id === editId;
    set(reload ? { error: null } : { status: "loading", error: null, toast: null });
    try {
      const edit = toEdit(await api.get(editId));
      if (seq !== loadSeq) return;
      if (!edit) return set({ status: "error", edit: null, doc: null, revision: null, error: "That video edit doesn't exist, or you can't open it." });
      adopt(edit, { status: "ready", error: null });
    } catch (err) {
      if (seq !== loadSeq) return;
      set({ status: "error", edit: null, doc: null, revision: null, error: messageOf(err) });
    }
  }

  async function applyOps(ops: unknown[]): Promise<boolean> {
    if (!editId || state.revision === null || state.busy) return false;
    set({ busy: true, toast: null });
    try {
      const saved = (await api.applyOps({ editId, baseRevision: state.revision, ops })) as { revision?: number; doc?: EditDoc; duration?: number };
      if (!saved || typeof saved.revision !== "number" || !saved.doc) throw new Error("The editor got an unexpected answer. Reload and try again.");
      adopt({ ...(state.edit as EditorEdit), revision: saved.revision, doc: saved.doc, duration: saved.duration }, { busy: false });
      return true;
    } catch (err) {
      if (isEditConflict(err)) {
        set({ busy: false });
        await load(editId);
        set({ toast: "Someone else changed this video. Their version is loaded; your last change was not saved." });
        return false;
      }
      set({ busy: false, toast: messageOf(err) });
      return false;
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    applyOps,
    setPlayhead: (seconds) => set({ playhead: Number.isFinite(seconds) ? Math.max(0, seconds) : 0 }),
    selectClip: (clipId) => set({ selectedClipId: clipId }),
    dismissToast: () => set({ toast: null }),
  };
}
