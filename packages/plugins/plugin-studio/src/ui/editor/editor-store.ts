/**
 * The video editor's state (PAR-8313): the edit document, its revision, the playhead and the selected clip.
 * Plain TypeScript with injected actions so it is tested without React; EditorPage wires it to the real
 * `video-edit-get` and `video-edit-apply-ops` actions. Every change is an ops batch sent with the revision the page
 * holds; the worker owns the rules, the UI never builds ffmpeg arguments.
 */
import type { EditDoc } from "../../video-edit/timeline.js";

export interface EditorEdit {
  id: string;
  /** The edit's title, as video-edit-get returns it. */
  title?: string;
  revision: number;
  duration?: number;
  doc: EditDoc;
}

export interface EditorApi {
  get(editId: string): Promise<unknown>;
  applyOps(params: { editId: string; baseRevision: number; ops: unknown[] }): Promise<unknown>;
  voiceover?(params: { editId: string; baseRevision: number; script: string; voice: string; at: number }): Promise<unknown>;
  music?(params: { editId: string; baseRevision: number; prompt: string; duration: number; at: number }): Promise<unknown>;
  caption?(params: { editId: string; baseRevision: number; clipId: string; style?: string }): Promise<unknown>;
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
  // A missing xAI key (PAR-8418): always name the setting, whatever the server worded.
  if ((err as { code?: unknown } | null)?.code === "not_configured" && !text.includes("xAI voice")) return `Voiceover needs an xAI key: set it under "xAI voice" in Studio's plugin settings.`;
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

/** How a `video-edit-music` call ended (PAR-10257). `retry` is false whenever money may have been spent: never offer a second try. */
export type MusicOutcome =
  | { kind: "placed"; clipId: string }
  | { kind: "synthesizing"; message: string }
  | { kind: "failed"; message: string; retry: boolean };

/** Server refusals that happen before anything is reserved: safe to try again. */
const MUSIC_BEFORE_SPEND = new Set(["bad_request", "not_configured", "provider_cap_reached", "no_room", "edit_conflict"]);
export const MUSIC_UNKNOWN_MESSAGE = "This may have been charged. Check the Library before trying again.";

/** A refusal carries the server's `code` and message. An error with no code (a raw RPC timeout) may have been charged. */
export function musicFailure(err: unknown): { message: string; retry: boolean } {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const text = typeof e?.message === "string" ? e.message.trim() : "";
  if (!code) return { message: MUSIC_UNKNOWN_MESSAGE, retry: false };
  return { message: text || MUSIC_UNKNOWN_MESSAGE, retry: MUSIC_BEFORE_SPEND.has(code) || /nothing was charged/i.test(text) };
}

export interface EditorStore {
  getState(): EditorState;
  subscribe(listener: () => void): () => void;
  load(editId: string | null): Promise<void>;
  applyOps(ops: unknown[]): Promise<boolean>;
  /** `video-edit-voiceover`: script to speech on the audio track; the new clip id, or null on failure. */
  voiceover(params: { script: string; voice: string; at: number }): Promise<string | null>;
  /** `video-edit-music` (PAR-10257): a prompt to music on the audio track. A cap refusal is also shown as the page toast. */
  music(params: { prompt: string; duration: number; at: number }): Promise<MusicOutcome>;
  /** `video-edit-caption`: speech in a video/sound clip becomes captions (PAR-8360). False when the page has no such action. */
  autoCaption(params: { clipId: string; style?: string }): Promise<boolean>;
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

  /** One server change at the page's revision: the answer (a saved edit) is adopted, a conflict reloads. */
  async function save(call: (p: { editId: string; baseRevision: number }) => Promise<unknown>): Promise<boolean> {
    if (!editId || state.revision === null || state.busy) return false;
    set({ busy: true, toast: null });
    try {
      const saved = (await call({ editId, baseRevision: state.revision })) as { revision?: number; doc?: EditDoc; duration?: number };
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

  const applyOps = (ops: unknown[]) => save((p) => api.applyOps({ ...p, ops }));
  /** `video-edit-voiceover` (PAR-8418): speaks a script onto the audio track; resolves the new clip's id, or null when it failed (the toast says why). */
  const voiceover = async (params: { script: string; voice: string; at: number }): Promise<string | null> => {
    if (!api.voiceover) return null;
    let clipId: string | null = null;
    const ok = await save(async (p) => {
      const saved = (await api.voiceover!({ ...p, ...params })) as { clipId?: unknown };
      clipId = typeof saved?.clipId === "string" ? saved.clipId : null;
      return saved;
    });
    return ok ? clipId : null;
  };
  const music = async (params: { prompt: string; duration: number; at: number }): Promise<MusicOutcome> => {
    if (!api.music) return { kind: "failed", message: "Music isn't available on this page.", retry: false };
    if (!editId || state.revision === null || state.busy) return { kind: "failed", message: "The editor is busy. Try again in a moment.", retry: true };
    set({ busy: true, toast: null });
    try {
      const saved = (await api.music({ editId, baseRevision: state.revision, ...params })) as { status?: unknown; revision?: number; doc?: EditDoc; duration?: number; clipId?: unknown } | null;
      if (saved?.status === "synthesizing") {
        set({ busy: false });
        return { kind: "synthesizing", message: "Still making it; it will be in the Library; add it with Add audio." };
      }
      if (!saved || typeof saved.revision !== "number" || !saved.doc || typeof saved.clipId !== "string") throw Object.assign(new Error(MUSIC_UNKNOWN_MESSAGE), { code: "" });
      adopt({ ...(state.edit as EditorEdit), revision: saved.revision, doc: saved.doc, duration: saved.duration }, { busy: false });
      return { kind: "placed", clipId: saved.clipId };
    } catch (err) {
      if (isEditConflict(err)) {
        set({ busy: false });
        await load(editId);
        const message = "Someone else changed this video. Their version is loaded; the music was not started.";
        set({ toast: message });
        return { kind: "failed", message, retry: true };
      }
      const failure = musicFailure(err);
      set({ busy: false, toast: failure.message });
      return { kind: "failed", ...failure };
    }
  };
  const autoCaption = (params: { clipId: string; style?: string }) =>
    api.caption ? save((p) => api.caption!({ ...p, ...params })) : Promise.resolve(false);

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    applyOps,
    autoCaption,
    voiceover,
    music,
    setPlayhead: (seconds) => set({ playhead: Number.isFinite(seconds) ? Math.max(0, seconds) : 0 }),
    selectClip: (clipId) => set({ selectedClipId: clipId }),
    dismissToast: () => set({ toast: null }),
  };
}
