import { createHash } from "node:crypto";
import { MAX_EVENT_PAYLOAD_TEXT_CHARS } from "../redaction.js";
import { RunnerApiResponseLimitError } from "./native-runtime/runner-api-response-limits.js";
import type { RunResponseCaptureArtifact } from "./run-response-capture.js";

/**
 * Oversized binary tool results (PAR-9905). A string leaf over the event text
 * limit that is strict base64 of a known binary type is saved as a run-scoped
 * asset and replaced by a short note; everything else is withheld as before by
 * `validateToolContent`. Text-like types (SVG, text, JSON, octet-stream) are
 * never saved: their bytes would skip the secret redactor.
 */

const latin1 = (bytes: Buffer, start: number, end: number) => bytes.toString("latin1", start, end);
const riff = (bytes: Buffer, form: string) => latin1(bytes, 0, 4) === "RIFF" && latin1(bytes, 8, 12) === form;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Allowed types and the leading bytes each must have. */
const SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  "image/jpeg": bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": bytes => bytes.subarray(0, 8).equals(PNG_SIGNATURE),
  "image/gif": bytes => latin1(bytes, 0, 6) === "GIF87a" || latin1(bytes, 0, 6) === "GIF89a",
  "image/webp": bytes => riff(bytes, "WEBP"),
  "application/pdf": bytes => latin1(bytes, 0, 5) === "%PDF-",
  "video/mp4": bytes => latin1(bytes, 4, 8) === "ftyp",
  "audio/mpeg": bytes => latin1(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0),
  "audio/ogg": bytes => latin1(bytes, 0, 4) === "OggS",
  "audio/wav": bytes => riff(bytes, "WAVE"),
};

const MAX_DEPTH = 64;

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowedMime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const mime = value.split(";", 1)[0]!.trim().toLowerCase();
  return Object.hasOwn(SIGNATURES, mime) ? mime : null;
}

/** Strict base64: one alphabet (standard or URL-safe), valid padding, round-trip equal. */
export function decodeStrictBase64(text: string): Buffer | null {
  const standard = /^[A-Za-z0-9+/]+={0,2}$/.test(text);
  const urlSafe = !standard && /^[A-Za-z0-9_-]+={0,2}$/.test(text);
  if (!standard && !urlSafe) return null;
  const padded = text.endsWith("=");
  if ((standard || padded) && text.length % 4 !== 0) return null;
  if (text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, urlSafe ? "base64url" : "base64");
  let again = bytes.toString("base64");
  if (urlSafe) again = again.replace(/\+/g, "-").replace(/\//g, "_");
  if (!padded) again = again.replace(/=+$/, "");
  return again === text ? bytes : null;
}

/**
 * Only a session's own agent run may own saved files. No run (named gateway
 * without one), no agent or an approved execution (runs after a person
 * approves, often after the run ended): no spill.
 */
export function binarySpillRunScope(
  session: { companyId: string; agentId: string | null; runId: string | null },
  approvedAction: boolean,
): { companyId: string; agentId: string; runId: string } | null {
  const { companyId, agentId, runId } = session;
  return approvedAction || !agentId || !runId ? null : { companyId, agentId, runId };
}

export type BinarySpillCandidate = { text: string; mimeType: string };

/**
 * Primary leaves: an over-limit string beside an allowed `mimeType` (MCP
 * `{type:"image"|"audio", data, mimeType}`, `{resource:{blob, mimeType}}` and
 * the Drive `{content, id, mimeType, title}` shape). Cheap: no decoding.
 */
export function findBinarySpillCandidates(value: unknown): BinarySpillCandidate[] {
  const found = new Map<string, BinarySpillCandidate>();
  const walk = (node: unknown, depth: number) => {
    if (depth >= MAX_DEPTH || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    const mimeType = allowedMime((node as Record<string, unknown>).mimeType);
    for (const [key, item] of Object.entries(node)) {
      if (mimeType && key !== "mimeType" && typeof item === "string" && item.length > MAX_EVENT_PAYLOAD_TEXT_CHARS) {
        if (!found.has(item)) found.set(item, { text: item, mimeType });
      } else walk(item, depth + 1);
    }
  };
  walk(value, 0);
  return [...found.values()];
}

export type BinarySpillCapture = (bytes: Buffer, contentType: string) => Promise<RunResponseCaptureArtifact>;

function withheldNote(byteSize: number, mimeType: string, error: unknown) {
  const reason = error instanceof RunnerApiResponseLimitError
    ? error.code === "api_response_capture_busy" ? "file capture is busy, retry this call in a moment." : error.message
    : "file capture failed.";
  return `[Paperclip withheld this file (${byteSize} bytes, ${mimeType}): ${reason}]`;
}

/**
 * Saves each valid primary leaf once per sha256 and replaces it, and its exact
 * base64 inside any other over-limit leaf (the JSON text mirror), with a note.
 * A capture error replaces it with a withheld note instead; never throws for one.
 */
export async function spillBinaryLeaves(
  value: unknown,
  candidates: BinarySpillCandidate[],
  capture: BinarySpillCapture,
  onCaptureError: (error: unknown) => void = () => undefined,
): Promise<{ value: unknown; savedFiles: RunResponseCaptureArtifact[] }> {
  const notes = new Map<string, string>();
  const bySha = new Map<string, { note: string; artifact?: RunResponseCaptureArtifact }>();
  for (const { text, mimeType } of candidates) {
    const bytes = decodeStrictBase64(text);
    if (!bytes || !SIGNATURES[mimeType]!(bytes)) continue;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let outcome = bySha.get(sha256);
    if (!outcome) {
      // Sequential on purpose: captures share 2 process slots per company.
      try {
        const artifact = await capture(bytes, mimeType);
        outcome = { artifact, note: `[Paperclip saved this file (${artifact.byteSize} bytes, ${mimeType}) as artifact ${artifact.artifactId}. Download it with GET /api/assets/${artifact.artifactId}/content and this run's API key.]` };
      } catch (error) {
        onCaptureError(error);
        outcome = { note: withheldNote(bytes.length, mimeType, error) };
      }
      bySha.set(sha256, outcome);
    }
    notes.set(text, outcome.note);
  }
  if (!notes.size) return { value, savedFiles: [] };
  // Longest first, so a shorter saved text never splits a longer one.
  const replacements = [...notes].sort((a, b) => b[0].length - a[0].length);
  const rebuild = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") {
      if (node.length <= MAX_EVENT_PAYLOAD_TEXT_CHARS) return node;
      const exact = notes.get(node);
      if (exact) return exact;
      let next = node;
      for (const [text, note] of replacements) if (next.includes(text)) next = next.split(text).join(note);
      return next;
    }
    if (depth >= MAX_DEPTH) return node;
    if (Array.isArray(node)) return node.map(item => rebuild(item, depth + 1));
    if (plainObject(node)) return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, rebuild(item, depth + 1)]));
    return node;
  };
  const savedFiles = [...bySha.values()].flatMap(outcome => outcome.artifact ? [outcome.artifact] : []);
  return { value: rebuild(value, 0), savedFiles };
}
