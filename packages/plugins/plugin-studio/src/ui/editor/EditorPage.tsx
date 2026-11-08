/**
 * The `studio-editor` page (PAR-8313): `?edit=<id>` loads a video edit and shows the player, timeline and render
 * panel around one editor store. Later tickets fill the three panels and never touch this file (PAR-8451 adds the
 * ClipInspector under the timeline).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useHostContext, useHostLocation, useHostNavigation, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, errorText, Page, PageMessage } from "@partnersinbiz/pib-plugin-ui";
import { useStudioAction } from "../action.js";
import { clipCount, createEditorStore, type EditorApi } from "./editor-store.js";
import { Player } from "./Player.js";
import { Timeline } from "./Timeline.js";
import { ClipInspector } from "./ClipInspector.js";
import { createKeyHistory } from "./timeline-view.js";
import { RenderPanel } from "./RenderPanel.js";
import { VersionsPanel } from "./VersionsPanel.js";

export function StudioEditorPage({ context }: PluginPageProps) {
  const host = useHostContext();
  const companyId = context.companyId ?? host.companyId ?? null;
  const { search } = useHostLocation();
  const editId = new URLSearchParams(search).get("edit");
  const nav = useHostNavigation();
  const getAction = useStudioAction("video-edit-get");
  const deleteAction = useStudioAction("video-edit-delete");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const opsAction = useStudioAction("video-edit-apply-ops");
  const captionAction = useStudioAction("video-edit-caption");
  // Actions go through refs so the store is built once per company, not once per render.
  const actions = useRef({ getAction, opsAction, captionAction });
  actions.current = { getAction, opsAction, captionAction };
  const store = useMemo(() => {
    const api: EditorApi = {
      get: (id) => actions.current.getAction({ companyId, editId: id }),
      applyOps: (p) => actions.current.opsAction({ companyId, ...p }),
      caption: (p) => actions.current.captionAction({ companyId, ...p }),
    };
    return createEditorStore(api);
  }, [companyId]);
  // Key changes from the inspector and the timeline markers share one undo list per edit (PAR-8451).
  const keyHistory = useMemo(() => createKeyHistory(), [store, editId]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  useEffect(() => {
    if (companyId) void store.load(editId);
  }, [store, editId, companyId]);

  if (!companyId) return <Page accent="studio" title="Video editor" description="Pick a company first.">{null}</Page>;
  const title = state.edit?.name || "Video editor";
  const remove = async () => {
    if (!editId || !window.confirm(`Delete "${title}"? Its timeline and saved versions are removed for everyone. Videos it already rendered stay in the library. This can't be undone.`)) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAction({ companyId, editId });
      nav.navigate("/studio");
    } catch (err) {
      setDeleteError(errorText(err));
      setDeleting(false);
    }
  };
  const message = deleteError ?? state.toast ?? undefined;
  const deleteButton = state.status === "ready" ? <Button disabled={deleting} onClick={() => void remove()}>{deleting ? "Deleting…" : "Delete"}</Button> : null;
  return (
    <Page accent="studio" title={title} description="Cut, caption and polish a video, then render it." message={message} messageTone="warning" actions={<>{state.toast ? <Button onClick={store.dismissToast}>Dismiss</Button> : null}{deleteButton}</>}>
      {state.status === "idle" || state.status === "loading" ? <PageMessage message="Loading the video…" /> : null}
      {state.status === "error" ? <EmptyState title="This video can't be opened" description={state.error ?? "Try again."} /> : null}
      {state.status === "ready" ? (
        <div data-editor-ready style={{ display: "grid", gap: 12, minWidth: 0 }}>
          {clipCount(state.doc) === 0 ? <PageMessage message="This edit is empty. Add a clip to start." /> : null}
          <Player store={store} />
          <Timeline store={store} keyHistory={keyHistory} />
          <ClipInspector store={store} history={keyHistory} />
          <RenderPanel store={store} />
          <VersionsPanel store={store} />
        </div>
      ) : null}
    </Page>
  );
}
