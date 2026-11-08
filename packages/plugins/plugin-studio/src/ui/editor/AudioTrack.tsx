/**
 * Audio track (PAR-8322): "Add audio" puts the sound of a Library video or audio asset (music or a voiceover) on the
 * audio track at the playhead; the selected audio clip's volume (0-2) and fade in/out are edited in a small form, and
 * "Mute track" silences the track in the preview only. Saving sends exactly one `video-edit-apply-ops` batch through
 * the store. The logic lives in audio-track.ts (unit tested); Player.tsx plays the clips.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { usePluginData, useHostContext } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Input, Modal, PageMessage } from "@partnersinbiz/pib-plugin-ui";
import { usePreviewUrls } from "../previews.js";
import { clientParam } from "./AddClipDialog.js";
import { addAudioOps, audioClips, audioEditOps, audioMute, findAudioClip, formOf, VOLUME_RANGE, type AudioForm } from "./audio-track.js";
import type { EditorStore } from "./editor-store.js";
import { formatTime } from "./timeline-view.js";

interface LibraryAsset { id: string; name: string; kind: string; status?: string; version?: number }

const field = { display: "grid", gap: 2, fontSize: 12, minWidth: 0 } as const;
const input = { padding: "4px 6px", borderRadius: 6, border: "1px solid #8886", background: "transparent", color: "inherit", minWidth: 0, width: "100%", boxSizing: "border-box" } as const;
const btn = (on: boolean) => ({ padding: "4px 10px", borderRadius: 6, border: "1px solid #8886", background: "transparent", color: "inherit", cursor: on ? "pointer" : "default", opacity: on ? 1 : 0.5, whiteSpace: "nowrap" }) as const;
const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } as const;
const NO_IDS: string[] = [];

function PickDialog({ companyId, client, busy, onPick, onClose }: {
  companyId: string;
  client: { kind?: string | null; id?: string | null } | null;
  busy: boolean;
  /** Resolves null when it saved (the dialog closes), else the message to show. */
  onPick: (asset: LibraryAsset, seconds: number) => Promise<string | null>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<LibraryAsset | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const params = useMemo(() => ({ companyId, client: clientParam(client), limit: 100 }), [companyId, client?.kind, client?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = usePluginData<{ assets: LibraryAsset[] }>("assets", params);
  const q = query.trim().toLowerCase();
  // Library kinds are image and video today; a video's sound is what plays. An audio kind is accepted when it appears.
  const assets = (list.data?.assets ?? []).filter((a: LibraryAsset) => (a.kind === "video" || a.kind === "audio") && a.status !== "archived" && (!q || a.name.toLowerCase().includes(q)));
  const previews = usePreviewUrls(companyId, chosen ? [chosen.id] : NO_IDS);
  const url = chosen ? previews.urls[chosen.id] : undefined;
  useEffect(() => {
    setSeconds(null);
    setProblem(null);
  }, [chosen?.id]);
  const ready = Boolean(chosen) && (seconds ?? 0) > 0;
  const add = async () => {
    if (!chosen || !ready || busy) return;
    const failed = await onPick(chosen, seconds as number);
    if (failed) setProblem(failed);
    else onClose();
  };
  return (
    <Modal
      open
      width={560}
      title="Add audio"
      description="Pick a Library video or audio file. Only its sound is used, placed on the audio track at the playhead."
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={!ready || busy} onClick={() => void add()}>{busy ? "Adding…" : "Add audio"}</Button>
        </>
      }
    >
      <Field label="Search"><Input aria-label="Search the Library" value={query} placeholder="Name" onChange={(e) => setQuery(e.target.value)} /></Field>
      {list.error ? <PageMessage tone="danger" message={list.error.message || "The Library didn't load. Try again."} /> : null}
      {problem ? <PageMessage tone="danger" message={problem} /> : null}
      <div role="listbox" aria-label="Library sounds" data-add-audio-list style={{ display: "grid", gap: 4, maxHeight: 320, overflowY: "auto", minWidth: 0 }}>
        {list.loading && !list.data ? <span style={{ opacity: 0.75 }}>Loading the Library…</span> : null}
        {!list.loading && assets.length === 0 ? <span style={{ opacity: 0.75 }}>No videos or audio files here yet.</span> : null}
        {assets.map((a: LibraryAsset) => {
          const on = chosen?.id === a.id;
          return (
            <button key={a.id} type="button" role="option" aria-selected={on} data-asset={a.id} onClick={() => setChosen(a)} title={a.name}
              style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, width: "100%", padding: "6px 10px", borderRadius: 6, textAlign: "left", cursor: "pointer", color: "inherit", background: on ? "var(--accent, #8882)" : "transparent", border: on ? "1px solid var(--primary, #3b6fd9)" : "1px solid var(--border, #8884)" }}>
              <span style={{ flex: "none", fontSize: 11, padding: "1px 6px", borderRadius: 999, border: "1px solid #8886" }}>{a.kind === "video" ? "Video" : "Audio"}</span>
              <span style={{ ...ellipsis, flex: 1 }}>{a.name || a.id}</span>
            </button>
          );
        })}
      </div>
      {chosen ? (
        <span data-add-audio-length style={{ fontSize: 12, opacity: 0.75 }}>
          {seconds ? `Length ${Math.round(seconds * 10) / 10} s` : url || !previews.error ? "Reading the length…" : "No preview link for this file yet."}
          {url ? (
            <audio key={url} src={url} preload="metadata" style={{ display: "none" }}
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration;
                if (Number.isFinite(d) && d > 0) setSeconds(d);
                else setProblem("Studio couldn't read how long this sound is.");
              }}
              onError={() => setProblem("Studio couldn't open this file to read its length.")} />
          ) : null}
        </span>
      ) : null}
    </Modal>
  );
}

export function AudioTrack({ store }: { store: EditorStore }) {
  const { doc, edit, playhead, selectedClipId, busy, revision } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const companyId = useHostContext().companyId ?? "";
  useSyncExternalStore(audioMute.subscribe, audioMute.getSnapshot, audioMute.getSnapshot);
  const found = findAudioClip(doc, selectedClipId);
  const clip = found?.clip ?? null;
  const [form, setForm] = useState<AudioForm | null>(clip ? formOf(clip) : null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    setForm(clip ? formOf(clip) : null);
    setError(null);
  }, [clip?.id, revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const client = (edit as { client?: { kind?: string | null; id?: string | null } | null } | null)?.client ?? null;
  const addPicked = async (asset: LibraryAsset, seconds: number) => {
    const made = addAudioOps(doc, { id: asset.id, version: asset.version ?? 1, seconds }, playhead);
    if ("error" in made) return made.error;
    if (!(await store.applyOps(made.ops))) return store.getState().toast ?? "The audio wasn't added. Try again.";
    store.selectClip(made.clipId);
    return null;
  };
  const save = () => {
    if (!clip || !form || busy) return;
    const made = audioEditOps(clip, form);
    if (made && "error" in made && made.error) return setError(made.error);
    setError(null);
    if (made && "ops" in made) void store.applyOps(made.ops);
  };
  const set = (key: keyof AudioForm) => (e: { target: { value: string } }) => setForm((f) => (f ? { ...f, [key]: e.target.value } : f));
  const trackId = found?.trackId ?? doc?.tracks.find((t) => t.kind === "audio")?.id ?? null;
  const muted = trackId ? audioMute.isMuted(trackId) : false;
  const count = audioClips(doc).length;

  return (
    <div data-audio-track style={{ display: "grid", gap: 8, padding: "8px 12px", borderBottom: "1px solid #8883", minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, minWidth: 0 }}>
        <strong>Audio</strong>
        <span style={{ opacity: 0.75 }}>{count} audio clip{count === 1 ? "" : "s"}{clip ? "" : " · select one on the timeline to edit it"}</span>
        <span style={{ flex: "1 1 0" }} />
        <button type="button" aria-pressed={muted} disabled={!trackId} onClick={() => trackId && audioMute.toggle(trackId)} title="Silences the audio track in the preview only; a render still includes it" style={btn(Boolean(trackId))}>
          {muted ? "Unmute track" : "Mute track"}
        </button>
        <button type="button" onClick={() => setAdding(true)} disabled={busy || !doc || !companyId} title={`Add audio at ${formatTime(playhead)}`} style={btn(!busy && Boolean(doc) && Boolean(companyId))}>Add audio</button>
      </div>
      {clip && form ? (
        <form aria-label="Edit audio clip" onSubmit={(e) => { e.preventDefault(); save(); }} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8, minWidth: 0 }}>
          <label style={field}>Volume ({VOLUME_RANGE[0]}-{VOLUME_RANGE[1]})<input type="number" min={VOLUME_RANGE[0]} max={VOLUME_RANGE[1]} step={0.1} value={form.volume} onChange={set("volume")} style={input} /></label>
          <label style={field}>Fade in (s)<input type="number" min={0} step={0.1} value={form.fadeIn} onChange={set("fadeIn")} style={input} /></label>
          <label style={field}>Fade out (s)<input type="number" min={0} step={0.1} value={form.fadeOut} onChange={set("fadeOut")} style={input} /></label>
          <div style={{ display: "flex", alignItems: "end", gap: 8 }}>
            <button type="submit" disabled={busy} style={btn(!busy)}>Save audio</button>
          </div>
        </form>
      ) : null}
      {error ? <div role="alert" style={{ color: "#e5484d", fontSize: 12, overflowWrap: "anywhere" }}>{error}</div> : null}
      {adding ? <PickDialog companyId={companyId} client={client} busy={busy} onPick={addPicked} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
