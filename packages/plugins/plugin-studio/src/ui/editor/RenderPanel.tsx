/**
 * Render panel (PAR-8316): pick the aspect, render, watch progress, cancel, and open the result.
 * The controller is plain TypeScript with injected actions so polling is tested without React. Every change goes
 * through the editor store (`setProject` ops batch); the UI never builds ffmpeg arguments.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useHostContext, useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { Button, ButtonLink } from "@partnersinbiz/pib-plugin-ui";
import { useStudioAction } from "../action.js";
import type { EditorStore } from "./editor-store.js";
import { ASPECTS, createRenderController, isActive, previewUrl } from "./render-controller.js";

const LABEL: Record<string, string> = { queued: "Waiting in the queue…", rendering: "Rendering…", succeeded: "Done", failed: "Render failed", cancelled: "Cancelled" };
const wrap = { overflowWrap: "anywhere" } as const;

export function RenderPanel({ store }: { store: EditorStore }) {
  const host = useHostContext();
  const nav = useHostNavigation();
  const companyId = host.companyId ?? null;
  const renderAction = useStudioAction("video-edit-render");
  const statusAction = useStudioAction("video-edit-render-status");
  const cancelAction = useStudioAction("video-edit-cancel-render");
  const actions = useRef({ renderAction, statusAction, cancelAction });
  actions.current = { renderAction, statusAction, cancelAction };
  const controller = useMemo(
    () =>
      createRenderController({
        render: (p) => actions.current.renderAction({ companyId, ...p }),
        status: (p) => actions.current.statusAction({ companyId, ...p }),
        cancel: (p) => actions.current.cancelAction({ companyId, ...p }),
      }),
    [companyId],
  );
  useEffect(() => () => controller.dispose(), [controller]);
  const render = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const editor = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  const { doc, edit, revision, busy } = editor;
  const active = isActive(render.job?.status);
  const preview = previewUrl(render.job);
  const size = doc?.project.size ?? "9:16";
  return (
    <section aria-label="Render" data-editor-panel="render" style={{ display: "grid", gap: 10, minWidth: 0, border: "1px solid var(--border, currentColor)", borderRadius: 8, padding: 16 }}>
      <div role="group" aria-label="Aspect" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {ASPECTS.map((a) => (
          <Button key={a} aria-pressed={a === size} disabled={busy || active || a === size} onClick={() => void store.applyOps([{ op: "setProject", size: a }])}>
            {a}
          </Button>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", minWidth: 0 }}>
        <Button disabled={!edit || revision === null || busy || render.starting || active} onClick={() => edit && revision !== null && void controller.start(edit.id, revision)}>
          {render.starting ? "Starting…" : "Render"}
        </Button>
        {active ? <Button onClick={() => void controller.cancel()}>Cancel</Button> : null}
        {render.job ? <span role="status" style={wrap}>{LABEL[render.job.status] ?? render.job.status}</span> : null}
      </div>
      {render.error ? <div role="alert" style={wrap}>{render.error}</div> : null}
      {render.job?.status === "failed" ? <div role="alert" style={wrap}>{render.job.error || "The render failed."}</div> : null}
      {render.job?.status === "succeeded" ? (
        <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
          {preview ? <video src={preview} controls playsInline style={{ maxWidth: "100%", maxHeight: 360 }} /> : null}
          {render.job.assetId ? <ButtonLink {...nav.linkProps(`/studio?asset=${encodeURIComponent(render.job.assetId)}`)}>Open in Library</ButtonLink> : null}
        </div>
      ) : null}
    </section>
  );
}
