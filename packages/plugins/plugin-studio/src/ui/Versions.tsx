/**
 * Canvas versions (a toolbar menu) and a card's comment thread (a side panel tab), PAR-8092. Viewers see both; only
 * editors save or restore a version or write a comment (the worker checks this again).
 */
import { useState, type CSSProperties } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { Button, errorText } from "@partnersinbiz/pib-plugin-ui";

interface Version { id: string; name: string; revision: number; cards: number; createdAt: string | null }
interface Comment { id: string; body: string; authorUserId: string | null; createdAt: string | null }

const muted: CSSProperties = { color: "var(--muted-foreground)", fontSize: "var(--text-xs, 12px)", overflowWrap: "anywhere" };
const field: CSSProperties = { width: "100%", minWidth: 0, boxSizing: "border-box", font: "inherit", fontSize: 13, padding: 6, border: "1px solid var(--border)", borderRadius: 6, background: "var(--background)", color: "var(--foreground)" };
const alert: CSSProperties = { color: "var(--destructive)", fontSize: 12, overflowWrap: "anywhere" };
const when = (at: string | null) => (at ? new Date(at).toLocaleString() : "");

export interface VersionsProps {
  companyId: string;
  canvasId: string;
  canEdit: boolean;
  /** Restore only from a fully saved board, so it never races an autosave. */
  saved: boolean;
  revision: () => number;
  /** Called after a restore: the page reloads the board. */
  onRestored: () => void;
}

/** Open state can come from the page, so opening this menu closes the Share one (PAR-8102). */
export function VersionsMenu({ companyId, canvasId, canEdit, saved, revision, onRestored, open: shown, onOpenChange }: VersionsProps & { open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [own, setOwn] = useState(false);
  const open = shown ?? own;
  const setOpen = onOpenChange ?? setOwn;
  return (
    <div className="studio-canvas-versions">
      <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>Versions</Button>
      {open ? <VersionsList {...{ companyId, canvasId, canEdit, saved, revision, onRestored }} /> : null}
    </div>
  );
}

function VersionsList({ companyId, canvasId, canEdit, saved, revision, onRestored }: VersionsProps) {
  const list = usePluginData<{ versions: Version[] }>("canvas-versions", { companyId, canvasId });
  const saveVersion = usePluginAction("canvas-version-save");
  const restore = usePluginAction("canvas-version-restore");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
      list.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const doRestore = (v: Version) => {
    if (!window.confirm(`Restore "${v.name}"? The board goes back to that version; you can save a version of it first.`)) return;
    void run(v.id, async () => {
      await restore({ companyId, canvasId, versionId: v.id, baseRevision: revision() });
      onRestored();
    });
  };
  return (
    <div role="region" aria-label="Versions" className="studio-canvas-versions-list">
      {canEdit ? (
        <form style={{ display: "flex", gap: 6 }} onSubmit={(e) => { e.preventDefault(); void run("save", () => saveVersion({ companyId, canvasId, name }).then(() => setName(""))); }}>
          <input aria-label="Version name" placeholder="Name this version" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} style={field} />
          <Button type="submit" disabled={busy !== null || !name.trim() || !saved}>Save version</Button>
        </form>
      ) : null}
      {canEdit && !saved ? <span style={muted}>Waiting for the board to save…</span> : null}
      {error ? <span role="alert" style={alert}>{error}</span> : null}
      {list.error ? <span role="alert" style={alert}>{errorText(list.error)}</span> : null}
      {list.data && list.data.versions.length === 0 ? <span style={muted}>No versions yet.{canEdit ? " Name one above to keep this board as it is now." : ""}</span> : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {(list.data?.versions ?? []).map((v) => (
          <li key={v.id} style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ minWidth: 0 }}>
              <strong style={{ display: "block", fontSize: 13, overflowWrap: "anywhere" }}>{v.name}</strong>
              <span style={muted}>{v.cards} cards · {when(v.createdAt)}</span>
            </span>
            {canEdit ? <Button variant="secondary" disabled={busy !== null || !saved} onClick={() => doRestore(v)}>{busy === v.id ? "Restoring…" : "Restore"}</Button> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CommentsThread({ companyId, canvasId, cardId, canEdit, meUserId }: { companyId: string; canvasId: string; cardId: string; canEdit: boolean; meUserId: string | null }) {
  const thread = usePluginData<{ comments: Comment[] }>("canvas-comments", { companyId, canvasId, cardId });
  const add = usePluginAction("canvas-comment-add");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await add({ companyId, canvasId, cardId, body });
      setBody("");
      thread.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const comments = thread.data?.comments ?? [];
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {thread.error ? <span role="alert" style={alert}>{errorText(thread.error)}</span> : null}
      {thread.data && comments.length === 0 ? <span style={muted}>No comments on this card yet.</span> : null}
      <ol aria-label="Comments" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {comments.map((c) => (
          <li key={c.id} style={{ display: "grid", gap: 2, paddingBottom: 6, borderBottom: "1px solid var(--border)" }}>
            <span style={muted}>{c.authorUserId && c.authorUserId === meUserId ? "You" : "A teammate"} · {when(c.createdAt)}</span>
            <span style={{ fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.body}</span>
          </li>
        ))}
      </ol>
      {canEdit ? (
        <form style={{ display: "grid", gap: 6 }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea aria-label="New comment" rows={3} maxLength={2000} placeholder="Add a comment" value={body} onChange={(e) => setBody(e.target.value)} style={{ ...field, resize: "vertical" }} />
          <Button type="submit" disabled={busy || !body.trim()}>{busy ? "Posting…" : "Comment"}</Button>
          {error ? <span role="alert" style={alert}>{error}</span> : null}
        </form>
      ) : <span style={muted}>Viewers can read comments but not add them.</span>}
    </div>
  );
}
