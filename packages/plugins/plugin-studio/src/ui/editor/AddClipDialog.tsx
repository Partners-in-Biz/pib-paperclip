/**
 * "Add clip" (PAR-8317): pick a Library video or picture and it is joined onto the end of the video track. The list is
 * the same `assets` page data the Library uses, scoped to the edit's client (the worker refuses another client's asset
 * anyway). A video's length is read from its signed preview URL (`<video preload="metadata">`, media never goes
 * through RPC); a picture shows 3 s. The dialog only reports the pick: Timeline turns it into one ops batch.
 */
import { useEffect, useMemo, useState } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Input, Modal, PageMessage, Select } from "@partnersinbiz/pib-plugin-ui";
import { usePreviewUrls } from "../previews.js";
import type { LibraryPick } from "./timeline-view.js";

interface LibraryAsset { id: string; name: string; kind: string; status?: string; version?: number }
type KindFilter = "all" | "video" | "image";

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } as const;
const NO_IDS: string[] = [];

/** The `client` filter for the edit's scope: own work, or `<kind>:<id>`. */
export function clientParam(client: { kind?: string | null; id?: string | null } | null | undefined): string {
  return client?.id ? `${client.kind ?? "client"}:${client.id}` : "own";
}

export function AddClipDialog({ companyId, client, busy, onPick, onClose }: {
  companyId: string;
  /** The edit's client; null for own work. */
  client: { kind?: string | null; id?: string | null } | null;
  busy: boolean;
  /** Sends the batch; resolves null when it saved (the dialog closes), else the message to show. */
  onPick: (pick: LibraryPick) => Promise<string | null>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<LibraryAsset | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const params = useMemo(() => ({ companyId, client: clientParam(client), limit: 100, ...(kind === "all" ? {} : { kind }) }), [companyId, client?.kind, client?.id, kind]);
  const list = usePluginData<{ assets: LibraryAsset[] }>("assets", params);
  const q = query.trim().toLowerCase();
  const assets = (list.data?.assets ?? []).filter((a: LibraryAsset) => (a.kind === "video" || a.kind === "image") && a.status !== "archived" && (!q || a.name.toLowerCase().includes(q)));
  const previews = usePreviewUrls(companyId, chosen?.kind === "video" ? [chosen.id] : NO_IDS);
  const videoUrl = chosen?.kind === "video" ? previews.urls[chosen.id] : undefined;

  useEffect(() => {
    setSeconds(null);
    setProblem(null);
  }, [chosen?.id]);

  const ready = Boolean(chosen) && (chosen?.kind === "image" || (seconds ?? 0) > 0);
  const add = async () => {
    if (!chosen || !ready || busy) return;
    const failed = await onPick({ id: chosen.id, kind: chosen.kind, version: chosen.version ?? 1, seconds: seconds ?? undefined });
    if (failed) setProblem(failed);
    else onClose();
  };

  return (
    <Modal
      open
      width={560}
      title="Add a clip"
      description="Pick a video or picture from the Library. It joins the end of the video track; a picture shows for 3 seconds."
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={!ready || busy} onClick={() => void add()}>{busy ? "Adding…" : "Add to the end"}</Button>
        </>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, minWidth: 0 }}>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <Field label="Search"><Input aria-label="Search the Library" value={query} placeholder="Name" onChange={(e) => setQuery(e.target.value)} /></Field>
        </div>
        <div style={{ flex: "0 1 120px", minWidth: 0 }}>
          <Field label="Show">
            <Select aria-label="Show kind" value={kind} onChange={(e) => setKind(e.target.value as KindFilter)}>
              <option value="all">All</option>
              <option value="video">Videos</option>
              <option value="image">Pictures</option>
            </Select>
          </Field>
        </div>
      </div>
      {list.error ? <PageMessage tone="danger" message={list.error.message || "The Library didn't load. Try again."} /> : null}
      {problem ? <PageMessage tone="danger" message={problem} /> : null}
      <div role="listbox" aria-label="Library assets" data-add-clip-list style={{ display: "grid", gap: 4, maxHeight: 320, overflowY: "auto", minWidth: 0 }}>
        {list.loading && !list.data ? <span style={{ opacity: 0.75 }}>Loading the Library…</span> : null}
        {!list.loading && assets.length === 0 ? <span style={{ opacity: 0.75 }}>No videos or pictures here yet.</span> : null}
        {assets.map((a: LibraryAsset) => {
          const on = chosen?.id === a.id;
          return (
            <button key={a.id} type="button" role="option" aria-selected={on} data-asset={a.id} onClick={() => setChosen(a)} title={a.name}
              style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, width: "100%", padding: "6px 10px", borderRadius: 6, textAlign: "left", cursor: "pointer", color: "inherit", background: on ? "var(--accent, #8882)" : "transparent", border: on ? "1px solid var(--primary, #3b6fd9)" : "1px solid var(--border, #8884)" }}>
              <span style={{ flex: "none", fontSize: 11, padding: "1px 6px", borderRadius: 999, border: "1px solid #8886" }}>{a.kind === "video" ? "Video" : "Picture"}</span>
              <span style={{ ...ellipsis, flex: 1 }}>{a.name || a.id}</span>
            </button>
          );
        })}
      </div>
      {chosen?.kind === "video" ? (
        <span data-add-clip-length style={{ fontSize: 12, opacity: 0.75 }}>
          {seconds ? `Length ${Math.round(seconds * 10) / 10} s` : videoUrl || !previews.error ? "Reading the video's length…" : "No preview link for this video yet."}
          {videoUrl ? (
            <video key={videoUrl} src={videoUrl} preload="metadata" muted style={{ display: "none" }}
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration;
                if (Number.isFinite(d) && d > 0) setSeconds(d);
                else setProblem("Studio couldn't read how long this video is.");
              }}
              onError={() => setProblem("Studio couldn't open this video to read its length.")} />
          ) : null}
        </span>
      ) : null}
    </Modal>
  );
}
