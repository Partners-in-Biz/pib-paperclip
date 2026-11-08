/**
 * Render controller (PAR-8316): plain TypeScript with injected actions so the 3 s polling is tested without React.
 * RenderPanel.tsx is the view over it.
 */
export const ASPECTS = ["9:16", "1:1", "4:5", "16:9"] as const;
export const POLL_MS = 3000;

export type RenderStatus = "queued" | "rendering" | "succeeded" | "failed" | "cancelled" | string;
export interface RenderJob {
  id: string;
  status: RenderStatus;
  assetId?: string | null;
  error?: string | null;
  hasPreview?: boolean;
  /** The 720p proxy (A7c): a URL, or an object holding one. */
  preview?: string | { url?: string | null } | null;
}

export interface RenderApi {
  render(params: { editId: string; baseRevision: number }): Promise<unknown>;
  status(params: { renderId: string }): Promise<unknown>;
  cancel(params: { renderId: string }): Promise<unknown>;
}

export interface RenderPanelState {
  job: RenderJob | null;
  starting: boolean;
  error: string | null;
}

export const isActive = (status: RenderStatus | undefined) => status === "queued" || status === "rendering";

export function previewUrl(job: RenderJob | null): string | null {
  const p = job?.preview;
  const url = typeof p === "string" ? p : p?.url;
  return typeof url === "string" && url ? url : null;
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return text.trim() || "Something went wrong. Try again.";
}

function toJob(raw: unknown): RenderJob | null {
  const o = (raw && typeof raw === "object" && "render" in raw ? (raw as { render: unknown }).render : raw) as Partial<RenderJob> | null;
  return o && typeof o.id === "string" && typeof o.status === "string" ? (o as RenderJob) : null;
}

export interface RenderController {
  getState(): RenderPanelState;
  subscribe(listener: () => void): () => void;
  start(editId: string, baseRevision: number): Promise<void>;
  cancel(): Promise<void>;
  /** Stops polling for good; safe to call twice. Late answers are ignored. */
  dispose(): void;
}

export function createRenderController(api: RenderApi, pollMs = POLL_MS): RenderController {
  let state: RenderPanelState = { job: null, starting: false, error: null };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<RenderPanelState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = (renderId: string) => {
    stop();
    if (!disposed) timer = setTimeout(() => void poll(renderId), pollMs);
  };
  const adopt = (job: RenderJob) => {
    set({ job, error: null });
    if (isActive(job.status)) schedule(job.id);
    else stop();
  };
  async function poll(renderId: string): Promise<void> {
    timer = null;
    try {
      const job = toJob(await api.status({ renderId }));
      if (disposed || state.job?.id !== renderId) return;
      if (job) return adopt(job);
      set({ error: "The render status was not understood." });
    } catch (err) {
      if (disposed) return;
      // A failed check is not a failed render: show it and keep watching.
      set({ error: messageOf(err) });
    }
    schedule(renderId);
  }
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async start(editId, baseRevision) {
      if (state.starting || isActive(state.job?.status)) return;
      set({ starting: true, error: null });
      try {
        const job = toJob(await api.render({ editId, baseRevision }));
        if (disposed) return;
        if (!job) return set({ starting: false, error: "The render did not start. Try again." });
        set({ starting: false });
        adopt(job);
      } catch (err) {
        if (!disposed) set({ starting: false, error: messageOf(err) });
      }
    },
    async cancel() {
      const job = state.job;
      if (!job || !isActive(job.status)) return;
      try {
        const next = toJob(await api.cancel({ renderId: job.id }));
        if (disposed) return;
        if (next) adopt(next);
      } catch (err) {
        if (!disposed) set({ error: messageOf(err) });
      }
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}
