/**
 * Versions panel (PAR-8361): saved versions of the edit with time and author, "Save version", and Restore with a
 * confirm. A restore saves the old timeline as a new revision (nothing is rewritten) and reloads the editor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useHostContext } from "@paperclipai/plugin-sdk/ui";
import { Button, errorText } from "@partnersinbiz/pib-plugin-ui";
import { useStudioAction } from "../action.js";
import { isEditConflict, type EditorStore } from "./editor-store.js";

interface VersionItem {
  id: string;
  name: string;
  revision: number;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: string | null;
}

const wrap = { overflowWrap: "anywhere" } as const;

export function versionAuthor(v: Pick<VersionItem, "createdByUserId" | "createdByAgentId">): string {
  return v.createdByAgentId ? "An agent" : v.createdByUserId ? "A teammate" : "Unknown";
}

export function VersionsPanel({ store }: { store: EditorStore }) {
  const host = useHostContext();
  const companyId = host.companyId ?? null;
  const listAction = useStudioAction("video-edit-versions-list");
  const saveAction = useStudioAction("video-edit-version-save");
  const restoreAction = useStudioAction("video-edit-restore");
  const actions = useRef({ listAction, saveAction, restoreAction });
  actions.current = { listAction, saveAction, restoreAction };
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const edit = store.getState().edit;
  const editId = edit?.id ?? null;

  const refresh = useCallback(async () => {
    if (!editId) return;
    try {
      const out = (await actions.current.listAction({ companyId, editId })) as { versions?: VersionItem[] };
      setVersions(Array.isArray(out?.versions) ? out.versions : []);
    } catch (err) {
      setError(errorText(err));
    }
  }, [companyId, editId]);
  useEffect(() => void refresh(), [refresh]);

  const save = async () => {
    if (!editId || !name.trim()) return;
    setWorking(true);
    setError(null);
    try {
      await actions.current.saveAction({ companyId, editId, name: name.trim() });
      setName("");
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
    setWorking(false);
  };

  const restore = async (v: VersionItem) => {
    const revision = store.getState().revision;
    if (!editId || revision === null) return;
    if (!window.confirm(`Restore "${v.name}"? It becomes the newest revision. Your current timeline is kept as a version, so you can come back to it.`)) return;
    setWorking(true);
    setError(null);
    try {
      await actions.current.restoreAction({ companyId, editId, versionId: v.id, baseRevision: revision });
    } catch (err) {
      setError(isEditConflict(err) ? "Someone else changed this video. Their version is loaded; nothing was restored." : errorText(err));
    }
    await store.load(editId);
    await refresh();
    setWorking(false);
  };

  return (
    <section aria-label="Versions" data-editor-panel="versions" style={{ display: "grid", gap: 10, minWidth: 0, border: "1px solid var(--border, currentColor)", borderRadius: 8, padding: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", minWidth: 0 }}>
        <input aria-label="Version name" value={name} maxLength={200} placeholder="Name this version" onChange={(e) => setName(e.target.value)} style={{ flex: "1 1 160px", minWidth: 0 }} />
        <Button disabled={working || !name.trim()} onClick={() => void save()}>Save version</Button>
      </div>
      {error ? <div role="alert" style={wrap}>{error}</div> : null}
      {versions.length === 0 ? <div style={wrap}>No saved versions yet.</div> : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8, minWidth: 0 }}>
        {versions.map((v) => (
          <li key={v.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", minWidth: 0 }}>
            <span style={{ ...wrap, minWidth: 0, flex: "1 1 160px" }}>
              <strong>{v.name}</strong>
              <br />
              {v.createdAt ? new Date(v.createdAt).toLocaleString() : ""} · {versionAuthor(v)} · revision {v.revision}
            </span>
            <Button disabled={working} onClick={() => void restore(v)}>Restore</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
