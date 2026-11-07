/**
 * "From Drive" (PAR-8107, picker PAR-8124): a button that opens a picker over the picked client's Drive assets. The
 * picker looks like the library: a grid of real previews by folder, search, newest first, tick several and add them
 * together, and it stays open. Previews come from the CRM as small images (data: URLs), never as Drive links.
 * People only. Each picker owns its own requests and state; nothing about Drive is kept after it closes.
 * It is a native <dialog> opened with showModal(): the browser's top layer, so a canvas card's transform can't
 * shrink or clip it, with no second React root.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button, errorText, usePibBaseStyles } from "@partnersinbiz/pib-plugin-ui";
import { useStudioAction } from "./action.js";
import { awaitTransfer, percent } from "./drive-transfer.js";
import { useNarrow } from "./narrow.js";
import { ALL_FOLDERS, NO_FOLDER, blockedReason, createThumbQueue, fileSize, folderLabel, folderTabs, shortDate, thumbFallback, visibleFiles, type DriveFile, type ThumbState } from "./drive-picker.js";

export interface ImportedAsset {
  id: string;
  name: string;
}

type Progress = { state: "adding"; percent?: number } | { state: "added"; assetId: string } | { state: "failed"; message: string };
type ThumbRow = { id: string; url?: string; reason?: string };

const muted: CSSProperties = { fontSize: 13, color: "var(--muted-foreground)" };
const scrim = "color-mix(in srgb, var(--background, black) 72%, transparent)";
const pill: CSSProperties = { padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: scrim, border: "1px solid var(--border)", color: "var(--foreground)", whiteSpace: "nowrap" };

/**
 * `client` is the scope the files are for: "company:<id>", "contact:<id>" or "own". Empty: no client picked yet.
 * `variant`: "dialog" on the library, "panel" (a side panel) on the canvas. A phone gets the whole screen either way.
 * `onImported` runs once per Add, with every file that is now in the library.
 */
export function FromDrive({ companyId, client, onImported, small, variant = "dialog" }: { companyId: string; client: string; onImported: (assets: ImportedAsset[]) => void; small?: boolean; variant?: "dialog" | "panel" }) {
  const [open, setOpen] = useState(false);
  if (!client) return <span style={{ fontSize: small ? 12 : 13, color: "var(--muted-foreground)" }}>Pick a client (or Own work) to add files from Drive.</span>;
  return (
    <span className="nodrag" style={{ display: "inline-flex" }}>
      <Button variant="secondary" onClick={() => setOpen(true)} aria-haspopup="dialog">
        From Drive
      </Button>
      {open ? <DrivePicker companyId={companyId} client={client} variant={variant} onImported={onImported} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

function DrivePicker({ companyId, client, variant, onImported, onClose }: { companyId: string; client: string; variant: "dialog" | "panel"; onImported: (assets: ImportedAsset[]) => void; onClose: () => void }) {
  usePibBaseStyles();
  const narrow = useNarrow();
  const list = useStudioAction("drive-list");
  const thumbsAction = useStudioAction("drive-thumbs");
  const importFile = useStudioAction("drive-import");
  const pollTransfer = useStudioAction("drive-transfer");
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [maxBytes, setMaxBytes] = useState(5 * 1024 * 1024);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  const [folder, setFolder] = useState(ALL_FOLDERS);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [thumbs, setThumbs] = useState<Record<string, ThumbState>>({});
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const el = dialogRef.current;
    if (el && typeof el.showModal === "function" && !el.open) el.showModal();
    return () => {
      if (el?.open) el.close();
    };
  }, []);

  useEffect(() => {
    let live = true;
    setFiles(null);
    setLoadError(null);
    list({ companyId, client })
      .then((out) => {
        if (!live) return;
        const reply = out as { files: DriveFile[]; maxBytes?: number };
        setFiles(reply.files);
        if (typeof reply.maxBytes === "number") setMaxBytes(reply.maxBytes);
      })
      .catch((err: unknown) => {
        if (live) setLoadError(errorText(err));
      });
    return () => {
      live = false;
    };
  }, [companyId, client, loads, list]);

  useEffect(() => {
    if (!narrow) searchRef.current?.focus();
  }, [narrow]);

  // One queue per list: previews load in as cards come into view, a batch per request, each file once.
  const loaded = files !== null;
  const queue = useMemo(() => {
    if (!loaded) return null;
    return createThumbQueue(
      async (ids) => ((await thumbsAction({ companyId, client, fileIds: ids, size: "small" })) as { thumbs: ThumbRow[] }).thumbs,
      (results) => setThumbs((prev) => ({ ...prev, ...results })),
    );
  }, [loaded, companyId, client, thumbsAction]);
  useEffect(() => () => queue?.stop(), [queue]);

  const observer = useMemo(() => {
    if (!queue || typeof IntersectionObserver === "undefined") return null;
    return new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.fileId;
          if (e.isIntersecting && id) queue.want(id);
        }
      },
      { rootMargin: "300px 0px" },
    );
  }, [queue]);
  useEffect(() => () => observer?.disconnect(), [observer]);
  const watch = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      if (observer) observer.observe(el);
      else if (queue && el.dataset.fileId) queue.want(el.dataset.fileId);
    },
    [observer, queue],
  );

  const shown = useMemo(() => (files ? visibleFiles(files, folder, search) : []), [files, folder, search]);
  const tabs = useMemo(() => (files ? folderTabs(files) : []), [files]);
  const canTick = (f: DriveFile) => !f.assetId && !blockedReason(f, maxBytes) && progress[f.id]?.state !== "added";
  const toggle = (f: DriveFile) => {
    if (!canTick(f) || adding) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(f.id)) next.delete(f.id);
      else next.add(f.id);
      return next;
    });
  };

  async function addFiles(ids: string[]) {
    if (ids.length === 0 || adding) return;
    setAdding(true);
    setProgress((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, { state: "adding" } as Progress])) }));
    const added: ImportedAsset[] = [];
    // Two at a time. Up to 5 MB a copy is one Drive read inside the action; bigger ones run in the background (PAR-8125)
    // and are polled here, with their progress on the tile.
    let next = 0;
    const one = async () => {
      while (next < ids.length) {
        const id = ids[next++]!;
        try {
          const f = files?.find((x) => x.id === id);
          const out = await importFile({ companyId, client, fileId: id, size: f?.size, mimeType: f?.mimeType });
          const asset = await awaitTransfer<ImportedAsset>(out, pollTransfer, companyId, (done, total) =>
            setProgress((prev) => ({ ...prev, [id]: { state: "adding", percent: percent(done, total) } })),
          );
          added.push(asset);
          setProgress((prev) => ({ ...prev, [id]: { state: "added", assetId: asset.id } }));
          setFiles((prev) => prev?.map((f) => (f.id === id ? { ...f, assetId: asset.id } : f)) ?? prev);
          setSelected((prev) => {
            const s = new Set(prev);
            s.delete(id);
            return s;
          });
        } catch (err) {
          setProgress((prev) => ({ ...prev, [id]: { state: "failed", message: errorText(err) } }));
        }
      }
    };
    await Promise.all([one(), one()]);
    setAdding(false);
    if (added.length > 0) onImported(added);
  }

  const states = Object.values(progress);
  const addingNow = states.filter((p) => p.state === "adding").length;
  const addedCount = states.filter((p) => p.state === "added").length;
  const failedCount = states.filter((p) => p.state === "failed").length;
  const preview = previewId ? files?.find((f) => f.id === previewId) ?? null : null;
  const panel = variant === "panel" && !narrow;
  const pad = narrow ? 16 : 20;

  return (
    <dialog
      ref={dialogRef}
      aria-label="Add from Drive"
      className="nodrag nowheel"
      onCancel={(e) => {
        // Escape: close, unless files are being added.
        e.preventDefault();
        if (!adding) onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !adding) onClose();
      }}
      // React still bubbles events to the card the picker was opened from: stop them here so the canvas doesn't drag or select.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, width: "100vw", height: "100dvh", maxWidth: "none", maxHeight: "none", margin: 0, border: 0, boxSizing: "border-box", color: "var(--foreground)", background: "color-mix(in oklab, black 50%, transparent)", display: "flex", justifyContent: panel ? "flex-end" : "center", alignItems: panel || narrow ? "stretch" : "center", padding: panel || narrow ? 0 : 16 }}
    >
      <div
        className="pib-ui"
        style={{
          width: narrow ? "100%" : panel ? "min(560px, 100%)" : "min(1120px, 100%)",
          height: narrow || panel ? "100%" : "min(860px, calc(100dvh - 32px))",
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          background: "var(--card)",
          color: "var(--foreground)",
          border: narrow ? "none" : "1px solid var(--border)",
          borderRadius: narrow || panel ? 0 : 16,
          boxShadow: "0 24px 60px color-mix(in oklab, black 40%, transparent)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: narrow ? "calc(12px + env(safe-area-inset-top, 0px)) 16px 8px" : "16px 20px 8px" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 650, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{preview ? preview.name : "Add from Drive"}</h2>
            <p style={{ ...muted, margin: "2px 0 0" }}>
              {preview
                ? [folderLabel(preview.folder), fileSize(preview.size), shortDate(preview.modifiedTime)].filter(Boolean).join(" · ")
                : "This client's Drive Assets folders, newest first. Tick files, then add them to the library."}
            </p>
          </div>
          {preview ? (
            <Button variant="secondary" onClick={() => setPreviewId(null)}>
              Back
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={adding} aria-label="Close" style={{ minWidth: 40, padding: "0 10px", flexShrink: 0 }}>
            ×
          </Button>
        </div>

        {preview ? (
          <PreviewView key={preview.id} file={preview} companyId={companyId} client={client} small={thumbs[preview.id]} maxBytes={maxBytes} pad={pad} />
        ) : (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: `4px ${pad}px 10px` }}>
              <input
                ref={searchRef}
                type="search"
                aria-label="Search Drive files"
                placeholder="Search by name"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ flex: "1 1 200px", minWidth: 0, height: 36, padding: "0 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--background)", color: "inherit", font: "inherit", fontSize: 14 }}
              />
              {files && files.length > 0 ? (
                <div role="tablist" aria-label="Folder" style={{ display: "inline-flex", flexWrap: "wrap", gap: 2, padding: 2, border: "1px solid var(--border)", borderRadius: 18, maxWidth: "100%", minWidth: 0 }}>
                  {tabs.map(([value, label, n]) => (
                    <button
                      key={value || "all"}
                      type="button"
                      role="tab"
                      aria-selected={folder === value}
                      onClick={() => setFolder(value)}
                      style={{ border: 0, borderRadius: 999, padding: "4px 12px", minHeight: 32, font: "inherit", fontSize: 13, cursor: "pointer", whiteSpace: "nowrap", color: folder === value ? "var(--foreground)" : "var(--muted-foreground)", background: folder === value ? "var(--accent, var(--muted))" : "transparent", fontWeight: folder === value ? 600 : 400 }}
                    >
                      {label}
                      <span style={{ marginLeft: 6, opacity: 0.7 }}>{n}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: `0 ${pad}px 16px` }}>
              {loadError ? (
                <Notice
                  title="Drive couldn't be read"
                  action={
                    <Button variant="secondary" onClick={() => setLoads((n) => n + 1)}>
                      Try again
                    </Button>
                  }
                >
                  {loadError}
                </Notice>
              ) : !files ? (
                <>
                  <p style={{ ...muted, margin: "0 0 10px" }} role="status">
                    Reading this client's Drive. This can take up to 20 seconds.
                  </p>
                  <Grid narrow={narrow} panel={panel}>
                    {Array.from({ length: 12 }, (_, i) => (
                      <div key={i} aria-hidden="true" style={{ borderRadius: 10, border: "1px solid var(--border)", aspectRatio: "4 / 3", background: "var(--muted)" }} />
                    ))}
                  </Grid>
                </>
              ) : files.length === 0 ? (
                <Notice title="No images or videos in Drive yet">
                  This client's Drive Assets folders (such as Assets/Images, Assets/Video and Assets/Social) have no files Studio can take. Put JPEG, PNG, GIF, WebP, MP4 or MOV files there in Drive, then open From Drive again.
                </Notice>
              ) : shown.length === 0 ? (
                <Notice title="Nothing matches">
                  No file in {folder ? folderLabel(folder === NO_FOLDER ? null : folder) : "these folders"} has “{search.trim()}” in its name.
                </Notice>
              ) : (
                <Grid narrow={narrow} panel={panel}>
                  {shown.map((f) => (
                    <FileCard
                      key={f.id}
                      file={f}
                      thumb={thumbs[f.id]}
                      ticked={selected.has(f.id)}
                      progress={progress[f.id]}
                      blocked={blockedReason(f, maxBytes)}
                      disabled={adding}
                      watch={watch}
                      onToggle={() => toggle(f)}
                      onOpen={() => setPreviewId(f.id)}
                    />
                  ))}
                </Grid>
              )}
            </div>
          </>
        )}

        <div style={{ borderTop: "1px solid var(--border)", padding: narrow ? "10px 16px calc(10px + env(safe-area-inset-bottom, 0px))" : "12px 20px", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <div style={{ flex: "1 1 180px", minWidth: 0 }} role="status" aria-live="polite">
            <span style={{ fontWeight: 600 }}>{adding ? `Adding ${addingNow} file${addingNow === 1 ? "" : "s"}…` : `${selected.size} selected`}</span>
            {addedCount > 0 ? <span style={muted}> · {addedCount} added to the library</span> : null}
            {failedCount > 0 && !adding ? <span style={{ fontSize: 13, color: "var(--destructive)" }}> · {failedCount} failed, see the files marked Failed</span> : null}
          </div>
          <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexShrink: 0 }}>
            {preview && canTick(preview) ? (
            <Button variant="secondary" disabled={adding} onClick={() => toggle(preview)}>
              {selected.has(preview.id) ? "Untick" : "Tick"}
            </Button>
          ) : !preview && selected.size > 0 ? (
            <Button variant="secondary" disabled={adding} onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          ) : null}
          {preview && canTick(preview) && selected.size === 0 ? (
            <Button disabled={adding} onClick={() => void addFiles([preview.id])}>
              Add this file
            </Button>
          ) : (
            <Button disabled={adding || selected.size === 0} onClick={() => void addFiles([...selected])}>
              {adding ? "Adding…" : selected.size > 1 ? `Add ${selected.size} files` : "Add to library"}
            </Button>
          )}
          </div>
        </div>
      </div>
    </dialog>
  );
}

function Grid({ narrow, panel, children }: { narrow: boolean; panel: boolean; children: ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: narrow ? "repeat(2, minmax(0, 1fr))" : `repeat(auto-fill, minmax(${panel ? 150 : 180}px, 1fr))`, gap: 10 }}>{children}</div>;
}

function Notice({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" style={{ border: "1px dashed var(--border)", borderRadius: 12, padding: 20, display: "grid", gap: 8, justifyItems: "start", maxWidth: 560, margin: "24px auto" }}>
      <strong>{title}</strong>
      <span style={{ ...muted, overflowWrap: "anywhere" }}>{children}</span>
      {action}
    </div>
  );
}

function FileCard({ file: f, thumb, ticked, progress, blocked, disabled, watch, onToggle, onOpen }: {
  file: DriveFile;
  thumb: ThumbState | undefined;
  ticked: boolean;
  progress: Progress | undefined;
  blocked: string | null;
  disabled: boolean;
  watch: (el: HTMLElement | null) => void;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const inLibrary = Boolean(f.assetId) || progress?.state === "added";
  const tickable = !inLibrary && !blocked;
  const isVideo = f.mimeType.startsWith("video/");
  const url = thumb && thumb !== "loading" && "url" in thumb ? thumb.url : null;
  const meta = [fileSize(f.size), shortDate(f.modifiedTime)].filter(Boolean).join(" · ");
  const ring = ticked ? "var(--primary, var(--foreground))" : "var(--border)";
  return (
    <div ref={watch} data-file-id={f.id} style={{ borderRadius: 10, border: `1px solid ${ring}`, boxShadow: ticked ? `0 0 0 1px ${ring}` : "none", background: "var(--card)", overflow: "hidden", minWidth: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ position: "relative", aspectRatio: "4 / 3", background: "var(--muted)" }}>
        <button type="button" onClick={onOpen} aria-label={`Preview ${f.name}`} style={{ position: "absolute", inset: 0, border: 0, padding: 0, margin: 0, background: "transparent", color: "inherit", font: "inherit", cursor: "zoom-in", display: "grid", placeItems: "center", width: "100%", height: "100%" }}>
          {url ? (
            <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: blocked ? 0.55 : 1 }} />
          ) : (
            <span style={muted}>{thumb === "loading" ? "Loading preview…" : thumbFallback(f, thumb)}</span>
          )}
        </button>
        <label style={{ position: "absolute", top: 6, left: 6, display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 8, background: scrim, cursor: tickable && !disabled ? "pointer" : "not-allowed" }} title={blocked ?? (inLibrary ? "Already in the library" : `Tick ${f.name}`)}>
          <input type="checkbox" aria-label={`Tick ${f.name}`} checked={ticked || inLibrary} disabled={!tickable || disabled} onChange={onToggle} style={{ width: 18, height: 18, margin: 0, cursor: "inherit" }} />
        </label>
        <span style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "calc(100% - 52px)", pointerEvents: "none" }}>
          {progress?.state === "adding" ? <span style={pill}>{progress.percent === undefined ? "Adding…" : `Adding… ${progress.percent}%`}</span> : null}
          {progress?.state === "failed" ? <span style={{ ...pill, borderColor: "var(--destructive)" }}>Failed</span> : null}
          {inLibrary ? <span style={pill}>{progress?.state === "added" ? "Added" : "In library"}</span> : null}
          {blocked ? <span style={{ ...pill, borderColor: "var(--destructive)" }}>Too large</span> : null}
        </span>
        {isVideo ? (
          <span aria-hidden="true" style={{ position: "absolute", left: 8, bottom: 8, pointerEvents: "none", ...pill }}>
            ▶ Video
          </span>
        ) : null}
      </div>
      <div style={{ padding: "8px 10px 10px", minWidth: 0 }}>
        <div title={f.name} style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {f.name}
        </div>
        <div style={{ ...muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta}</div>
        {blocked ? <div style={{ fontSize: 12, color: "var(--destructive)", marginTop: 4, overflowWrap: "anywhere" }}>{blocked}</div> : null}
        {progress?.state === "failed" ? (
          <div role="alert" style={{ fontSize: 12, color: "var(--destructive)", marginTop: 4, overflowWrap: "anywhere" }}>
            {progress.message}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One file larger: Drive's 1024 px preview (one frame for a video), the small one meanwhile. */
function PreviewView({ file, companyId, client, small, maxBytes, pad }: { file: DriveFile; companyId: string; client: string; small: ThumbState | undefined; maxBytes: number; pad: number }) {
  const thumbsAction = useStudioAction("drive-thumbs");
  const [large, setLarge] = useState<ThumbState>("loading");
  useEffect(() => {
    let live = true;
    thumbsAction({ companyId, client, fileIds: [file.id], size: "large" })
      .then((out) => {
        const t = (out as { thumbs: ThumbRow[] }).thumbs.find((x) => x.id === file.id);
        if (live) setLarge(t?.url ? { url: t.url } : { reason: t?.reason ?? "no_preview" });
      })
      .catch(() => {
        if (live) setLarge({ reason: "failed" });
      });
    return () => {
      live = false;
    };
  }, [file.id, companyId, client, thumbsAction]);
  const url = large !== "loading" && "url" in large ? large.url : small && small !== "loading" && "url" in small ? small.url : null;
  const blocked = blockedReason(file, maxBytes);
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8, padding: `0 ${pad}px 12px` }}>
      <div style={{ flex: 1, minHeight: 0, borderRadius: 12, background: "var(--muted)", display: "grid", placeItems: "center", overflow: "hidden" }}>
        {url ? <img src={url} alt={file.name} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }} /> : <span style={muted}>{large === "loading" ? "Loading preview…" : "Drive has no preview of this file."}</span>}
      </div>
      {file.mimeType.startsWith("video/") ? <span style={muted}>A video: the preview is one frame from it.</span> : null}
      {file.assetId ? <span style={muted}>Already in the library.</span> : null}
      {blocked ? <span style={{ fontSize: 13, color: "var(--destructive)" }}>{blocked}</span> : null}
    </div>
  );
}
