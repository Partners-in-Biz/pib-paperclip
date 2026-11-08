/**
 * The canvas Edit card (PAR-8323): the videos and pictures wired into it become a video edit, "Open in editor" opens
 * that edit on the `studio-editor` page, and Render puts the finished video on the card, where it feeds a Layout card
 * and counts for Share and Approve like any other result. The card only calls the video-edit actions; the timeline
 * itself is changed in the editor (apply-ops with the edit's revision), never here.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useEdges, useNodes } from "@xyflow/react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { Button, errorText } from "@partnersinbiz/pib-plugin-ui";
import { useStudioAction } from "./action.js";
import { editInputs, type CardData } from "./board.js";

const POLL_MS = 4000;
const ACTIVE = new Set(["queued", "rendering"]);
const muted: CSSProperties = { color: "var(--muted-foreground)", fontSize: "var(--text-xs, 12px)", overflowWrap: "anywhere" };
const row: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" };

interface EditSummary { id: string; title: string; revision: number; clips: number; duration?: number }
interface RenderJob { id: string; status: string; assetId: string | null; error: string | null }

export function EditBody({ id, data, companyId, client, canEdit, set, children }: { id: string; data: CardData; companyId: string; client: string; canEdit: boolean; set: (patch: Record<string, string>) => void; children: ReactNode }) {
  const nav = useHostNavigation();
  const nodes = useNodes();
  const edges = useEdges();
  const inputs = useMemo(() => editInputs(nodes as Parameters<typeof editInputs>[0], edges, id), [nodes, edges, id]);
  const createAction = useStudioAction("video-edit-create");
  const renderAction = useStudioAction("video-edit-render");
  const statusAction = useStudioAction("video-edit-render-status");
  const [busy, setBusy] = useState<"create" | "render" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [render, setRender] = useState<RenderJob | null>(null);
  const editId = data.editId;
  const renderId = data.renderId;

  // The edit's clip count, so an empty edit says so instead of offering a render that the worker would refuse.
  // Read through the action (there is no data handler for edits); asked again when the card or a render changes.
  const getAction = useStudioAction("video-edit-get");
  const [loaded, setLoaded] = useState<{ editId: string; summary: EditSummary | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!editId) return;
    let stopped = false;
    getAction({ companyId, editId })
      .then((out) => { if (!stopped) setLoaded({ editId, summary: out as EditSummary, error: null }); })
      .catch((err) => { if (!stopped) setLoaded({ editId, summary: null, error: errorText(err) }); });
    return () => { stopped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId, companyId, data.assetId]);
  const summary = editId && loaded?.editId === editId ? loaded.summary : null;
  const loadError = editId && loaded?.editId === editId ? loaded.error : null;

  // A render in flight survives a reload: the card keeps its id and asks for its status until it ends.
  useEffect(() => {
    if (!renderId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      statusAction({ companyId, renderId })
        .then((out) => {
          if (stopped) return;
          const job = out as RenderJob;
          setRender(job);
          if (ACTIVE.has(job.status)) timer = setTimeout(poll, POLL_MS);
          else if (job.status === "succeeded" && job.assetId) set({ assetId: job.assetId, renderId: "" });
          else {
            setError(job.error || `The render ${job.status === "cancelled" ? "was cancelled" : "failed"}.`);
            set({ renderId: "" });
          }
        })
        .catch((err) => {
          if (stopped) return;
          setError(errorText(err));
          set({ renderId: "" });
        });
    };
    poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // statusAction and set are new functions each render; the poll restarts only for a new render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderId, companyId]);

  const editorPath = editId ? `/studio-editor?edit=${encodeURIComponent(editId)}` : null;
  const create = () => {
    if (!inputs.assetIds.length) return;
    setBusy("create");
    setError(null);
    createAction({ companyId, assetIds: inputs.assetIds, title: data.label || "Canvas edit", ...(client && client !== "own" ? { client } : {}) })
      .then((out) => set({ editId: (out as { id: string }).id }))
      .catch((err) => setError(errorText(err)))
      .finally(() => setBusy(null));
  };
  const start = () => {
    if (!editId) return;
    setBusy("render");
    setError(null);
    renderAction({ companyId, editId })
      .then((out) => {
        const job = out as RenderJob;
        setRender(job);
        set({ renderId: job.id });
      })
      .catch((err) => setError(errorText(err)))
      .finally(() => setBusy(null));
  };

  const rendering = Boolean(renderId);
  const files = inputs.assetIds.length;
  return (
    <>
      {children}
      <div className="nodrag" style={{ display: "grid", gap: 4 }}>
        <span style={muted}>
          {editId
            ? summary
              ? summary.clips
                ? `${summary.clips} clip${summary.clips === 1 ? "" : "s"} · revision ${summary.revision}`
                : "The edit is empty. Add clips in the editor."
              : loadError
                ? loadError
                : "Loading the edit…"
            : files
              ? `${files} file${files === 1 ? "" : "s"} wired in`
              : "Wire in video, image or source cards"}
        </span>
        {inputs.missing.map((m) => <span key={m} style={muted}>{m}</span>)}
        <div style={row}>
          {editorPath ? (
            // A new tab, so this board stays open, saves the card and picks up the render when it finishes.
            <a href={nav.linkProps(editorPath).href} target="_blank" rel="noopener" style={{ fontSize: "var(--text-xs, 12px)" }}>Open in editor</a>
          ) : canEdit ? (
            <Button variant="secondary" disabled={!files || busy !== null} onClick={create}>{busy === "create" ? "Creating…" : "Open in editor"}</Button>
          ) : null}
          {editId && canEdit ? (
            <Button variant="secondary" disabled={rendering || busy !== null || (summary !== null && summary.clips === 0)} onClick={start}>
              {rendering ? (render?.status === "rendering" ? "Rendering…" : "Waiting to render…") : busy === "render" ? "Starting…" : data.assetId ? "Render again" : "Render"}
            </Button>
          ) : null}
          {data.assetId ? <a {...nav.linkProps(`/studio?asset=${encodeURIComponent(data.assetId)}`)} style={{ fontSize: "var(--text-xs, 12px)" }}>Open in library</a> : null}
        </div>
        {error ? <span role="alert" style={{ ...muted, color: "var(--destructive)" }}>{error}</span> : null}
      </div>
    </>
  );
}
