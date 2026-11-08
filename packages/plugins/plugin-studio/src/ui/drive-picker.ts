/**
 * The From Drive picker's plain logic (PAR-8124), kept out of the component so it is tested without a browser:
 * folder tabs, search, labels, and the queue that asks for previews a page at a time as cards scroll into view.
 */

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** The folder below the client's, e.g. "Assets/Images". null when the CRM didn't say. */
  folder: string | null;
  /** ISO time of the last change in Drive. */
  modifiedTime: string | null;
  tooLarge: boolean;
  /** The library asset when this client already has the file. */
  assetId: string | null;
}

export const ALL_FOLDERS = "";
/** The tab for files the CRM gave no folder for. */
export const NO_FOLDER = "\u0000none";
/** Previews per request: about 12 × 150 KB at most, well inside one action's reply. */
export const THUMB_BATCH = 12;

export function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "Assets/Images" reads as "Images"; a file with no folder is under "Other". */
export function folderLabel(folder: string | null): string {
  if (!folder) return "Other";
  const parts = folder.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(" / ") : (parts[0] ?? "Other");
}

/** The whole path under the client's Drive folder: "Assets/Marketing" reads as "Assets / Marketing". */
export function folderPath(folder: string | null): string {
  const parts = (folder ?? "").split("/").filter(Boolean);
  return parts.length ? parts.join(" / ") : "No folder";
}

/** Folder tabs in a steady order (by label), each with its count, after "All". */
export function folderTabs(files: DriveFile[]): Array<[string, string, number]> {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(f.folder ?? NO_FOLDER, (counts.get(f.folder ?? NO_FOLDER) ?? 0) + 1);
  const tabs = [...counts.entries()].map(([folder, n]) => [folder, folderLabel(folder === NO_FOLDER ? null : folder), n] as [string, string, number]);
  tabs.sort((a, b) => a[1].localeCompare(b[1]));
  return [[ALL_FOLDERS, "All", files.length], ...tabs];
}

/** The files to show for a folder tab and a search (name, any case). The list stays newest first. */
export function visibleFiles(files: DriveFile[], folder: string, search: string): DriveFile[] {
  const q = search.trim().toLowerCase();
  return files.filter((f) => (folder === ALL_FOLDERS || (f.folder ?? NO_FOLDER) === folder) && (!q || f.name.toLowerCase().includes(q)));
}

/** "12 Nov 2026", or "" when Drive gave no date. */
export function shortDate(iso: string | null, locale?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

/** Why a file can't be ticked, in plain words; null when it can. */
export function blockedReason(f: DriveFile, maxBytes: number): string | null {
  if (f.tooLarge) return `Too large: ${fileSize(f.size)}. Studio takes Drive files up to ${fileSize(maxBytes)}.`;
  return null;
}

export type ThumbState = { url: string } | { reason: string } | "loading";

/** Words for a card with no preview. */
export function thumbFallback(f: DriveFile, state: ThumbState | undefined): string {
  const kind = f.mimeType.startsWith("video/") ? "Video" : "Image";
  if (state === undefined || state === "loading") return kind;
  if ("reason" in state && state.reason !== "no_preview") return `${kind} · no preview`;
  return kind;
}

/**
 * Asks for previews as cards come into view: ids queue up and go out a batch at a time, at most `parallel` batches at
 * once, each id once. `fetch` answers per id; an id it leaves out, or a failed batch, gets a reason, not a retry loop.
 */
export function createThumbQueue(
  fetch: (ids: string[]) => Promise<Array<{ id: string; url?: string; reason?: string }>>,
  onResult: (results: Record<string, ThumbState>) => void,
  opts: { batch?: number; parallel?: number; delayMs?: number } = {},
) {
  const batch = opts.batch ?? THUMB_BATCH;
  const parallel = opts.parallel ?? 2;
  const seen = new Set<string>();
  const waiting: string[] = [];
  let running = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const pump = () => {
    timer = null;
    while (!stopped && running < parallel && waiting.length > 0) {
      const ids = waiting.splice(0, batch);
      running++;
      onResult(Object.fromEntries(ids.map((id) => [id, "loading" as const])));
      fetch(ids)
        .then((rows) => {
          const out: Record<string, ThumbState> = {};
          for (const r of rows) if (ids.includes(r.id)) out[r.id] = typeof r.url === "string" ? { url: r.url } : { reason: r.reason ?? "no_preview" };
          for (const id of ids) out[id] ??= { reason: "no_reply" };
          if (!stopped) onResult(out);
        })
        .catch(() => {
          if (!stopped) onResult(Object.fromEntries(ids.map((id) => [id, { reason: "failed" }])));
        })
        .finally(() => {
          running--;
          if (!stopped) pump();
        });
    }
  };

  return {
    want(id: string) {
      if (stopped || seen.has(id)) return;
      seen.add(id);
      waiting.push(id);
      // A short wait gathers the cards that scrolled in together into one request.
      if (timer === null) timer = setTimeout(pump, opts.delayMs ?? 60);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      waiting.length = 0;
    },
  };
}
