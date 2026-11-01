import { clip, type ApiClient } from "./live-tools.js";
import { newUuid } from "./uuid.js";

/** One line of the call, with the time it first appeared. */
export interface LogEntry {
  who: "you" | "voice" | "note";
  text: string;
  at: number;
}

export interface ReportApi extends ApiClient {
  put<T>(path: string, body: unknown): Promise<T>;
}

export interface CallRecord {
  entries: LogEntry[];
  startedAt: number;
  endedAt: number;
  /** Recap request id per task, kept so a retry reuses it and the host drops a duplicate. */
  recapIds?: Record<string, string>;
}

export interface SaveTarget {
  issueId: string;
  ref: string;
}

const MAX_TOPICS = 5;
const MAX_TARGETS = 5;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

/** Stable per call: a retry updates the same document (with its latest revision id) instead of adding a second one. */
export function documentKey(startedAt: number): string {
  const d = new Date(startedAt);
  return `live-chat-transcript-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** A call is worth saving only when somebody actually said something. */
export function hasSpeech(entries: LogEntry[]): boolean {
  return entries.some((e) => e.who !== "note" && e.text.trim().length > 0);
}

export function buildTranscriptDocument(call: CallRecord): string {
  const lines = call.entries
    .filter((e) => e.text.trim())
    .map((e) => {
      const text = e.text.trim();
      if (e.who === "note") return `- _${clock(e.at)} ${text}_`;
      return `- **${e.who === "you" ? "You" : "Voice"}** (${clock(e.at)}): ${text}`;
    });
  return [
    "# Live chat transcript",
    "",
    `Call started ${new Date(call.startedAt).toLocaleString("en-ZA")}, lasted ${duration(call.endedAt - call.startedAt)}.`,
    "Spoken text is machine-transcribed and may contain mistakes.",
    "",
    ...lines,
    "",
  ].join("\n");
}

export function buildRecap(call: CallRecord, key: string): string {
  const spoken = call.entries.filter((e) => e.who !== "note" && e.text.trim());
  const youTurns = spoken.filter((e) => e.who === "you");
  const voiceTurns = spoken.filter((e) => e.who === "voice");
  const actions = call.entries.filter((e) => e.who === "note" && /^(Posted to|Created) /.test(e.text));
  const out = [
    "**Live chat recap**",
    "",
    `${duration(call.endedAt - call.startedAt)} call, ${youTurns.length} turns from you and ${voiceTurns.length} from the voice.`,
  ];
  if (youTurns.length > 0) {
    out.push("", "**What you asked or said**");
    for (const e of youTurns.slice(0, MAX_TOPICS)) out.push(`- ${clip(e.text.trim(), 160)}`);
    if (youTurns.length > MAX_TOPICS) out.push(`- and ${youTurns.length - MAX_TOPICS} more in the transcript`);
  }
  out.push("", "**Done during the call**");
  if (actions.length === 0) out.push("- No messages posted and no tasks created.");
  for (const e of actions) out.push(`- ${e.text.trim()}`);
  out.push(
    "",
    `Full two-sided transcript: the document \`${key}\` on this task. No action needed from agents; this is a record of the call.`,
  );
  return out.join("\n");
}

export interface SaveResult {
  saved: string[];
  failed: Array<{ ref: string; error: string }>;
  /** Tasks beyond the limit that got nothing. */
  skipped: number;
}

/** The host refuses an update to an existing key without the latest revision id, so look it up first. */
async function latestRevisionId(api: ReportApi, path: string): Promise<string | null> {
  try {
    const doc = await api.get<{ latestRevisionId?: string | null }>(path);
    return doc.latestRevisionId ?? null;
  } catch (err) {
    // Only "not found" means a first save; a 401, 500 or dropped network must reach the person.
    if (err instanceof Error && /\b404\b/.test(err.message)) return null;
    throw err;
  }
}

export interface SaveOptions {
  /** Post the recap comment after the document. Off for the autosave during the call, which must never add comments. */
  comment?: boolean;
  changeSummary?: string;
}

/** Writes the transcript document, then the recap comment, on each task the call touched. */
export async function saveLiveTranscript(
  api: ReportApi,
  call: CallRecord,
  targets: SaveTarget[],
  options: SaveOptions = {},
): Promise<SaveResult> {
  const { comment = true, changeSummary = "Saved from a live voice chat" } = options;
  const result: SaveResult = { saved: [], failed: [], skipped: 0 };
  if (!hasSpeech(call.entries)) return result;
  const key = documentKey(call.startedAt);
  const title = `Live chat transcript ${new Date(call.startedAt).toLocaleDateString("en-ZA")} ${clock(call.startedAt)}`;
  const body = buildTranscriptDocument(call);
  const recap = comment ? buildRecap(call, key) : "";
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.issueId)) continue;
    if (seen.size >= MAX_TARGETS) {
      result.skipped++;
      continue;
    }
    seen.add(target.issueId);
    try {
      const docPath = `/issues/${target.issueId}/documents/${key}`;
      const baseRevisionId = await latestRevisionId(api, docPath);
      await api.put(docPath, {
        title,
        format: "markdown",
        body,
        changeSummary,
        ...(baseRevisionId ? { baseRevisionId } : {}),
      });
      if (comment) {
        // The comment goes last: a failed document write never leaves a recap pointing at nothing.
        const recapIds = (call.recapIds ??= {});
        const clientRequestId = (recapIds[target.issueId] ??= newUuid());
        await api.post(`/issues/${target.issueId}/comments`, { body: recap, clientRequestId });
      }
      result.saved.push(target.ref);
    } catch (err) {
      result.failed.push({ ref: target.ref, error: err instanceof Error ? clip(err.message, 160) : "unknown error" });
    }
  }
  return result;
}
