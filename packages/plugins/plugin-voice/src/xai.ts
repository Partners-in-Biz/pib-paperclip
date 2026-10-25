import { XAI_CLIENT_SECRETS_URL, XAI_STT_MODEL, XAI_STT_URL } from "./namespace.js";

type FetchLike = typeof fetch;

/** Audio types the phone browsers record in. xAI detects the container itself. */
export const ACCEPTED_AUDIO = new Map<string, string>([
  ["audio/mp4", "note.m4a"],
  ["audio/x-m4a", "note.m4a"],
  ["audio/aac", "note.aac"],
  ["audio/webm", "note.webm"],
  ["audio/ogg", "note.ogg"],
  ["audio/mpeg", "note.mp3"],
  ["audio/wav", "note.wav"],
  ["audio/x-wav", "note.wav"],
]);

/** 7 MB of audio is roughly 20 minutes of compressed speech and stays under the bridge's 10 MB body cap once base64-encoded. */
export const MAX_AUDIO_BYTES = 7 * 1024 * 1024;

export function baseMime(mimeType: unknown): string {
  return typeof mimeType === "string" ? mimeType.split(";")[0]!.trim().toLowerCase() : "";
}

export class VoiceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "VoiceError";
  }
}

/** xAI error bodies can echo request detail; keep only a short status line. */
async function describeFailure(res: Response, what: string): Promise<VoiceError> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    const raw = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : "";
    detail = raw.replace(/xai-[A-Za-z0-9]{8,}/g, "[key]").slice(0, 160);
  } catch {
    // Non-JSON error body: the status code says enough.
  }
  const hint =
    res.status === 401 || res.status === 403
      ? " Check the xAI key in Voice settings."
      : res.status === 429
        ? " xAI is rate limiting or out of credit."
        : "";
  return new VoiceError(`${what} failed (${res.status}).${detail ? ` ${detail}.` : ""}${hint}`, res.status);
}

export interface TranscribeInput {
  apiKey: string;
  audio: Uint8Array;
  mimeType: string;
  language?: string;
  keyterms?: string[];
}

export async function transcribe(input: TranscribeInput, fetchImpl: FetchLike = fetch): Promise<{ text: string; duration: number | null }> {
  const mime = baseMime(input.mimeType);
  const filename = ACCEPTED_AUDIO.get(mime);
  if (!filename) throw new VoiceError(`Unsupported audio type: ${mime || "unknown"}`);
  if (input.audio.byteLength === 0) throw new VoiceError("The recording is empty.");
  if (input.audio.byteLength > MAX_AUDIO_BYTES) throw new VoiceError("The recording is too long. Keep voice notes under about 20 minutes.");

  // Option fields must come before the file in the multipart body.
  const form = new FormData();
  form.append("model", XAI_STT_MODEL);
  if (input.language) {
    form.append("language", input.language);
    form.append("format", "true");
  }
  for (const term of (input.keyterms ?? []).slice(0, 100)) form.append("keyterm", term);
  form.append("file", new Blob([new Uint8Array(input.audio)], { type: mime }), filename);

  const res = await fetchImpl(XAI_STT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}` },
    body: form,
  });
  if (!res.ok) throw await describeFailure(res, "Transcription");
  const body = (await res.json()) as { text?: unknown; duration?: unknown };
  return {
    text: typeof body.text === "string" ? body.text.trim() : "",
    duration: typeof body.duration === "number" ? body.duration : null,
  };
}

export async function mintLiveToken(
  apiKey: string,
  seconds: number,
  fetchImpl: FetchLike = fetch,
): Promise<{ token: string; expiresAt: number }> {
  const res = await fetchImpl(XAI_CLIENT_SECRETS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds } }),
  });
  if (!res.ok) throw await describeFailure(res, "Starting a live session");
  const body = (await res.json()) as { value?: unknown; expires_at?: unknown };
  if (typeof body.value !== "string" || !body.value) throw new VoiceError("xAI returned no session token.");
  return {
    token: body.value,
    expiresAt: typeof body.expires_at === "number" ? body.expires_at : Math.floor(Date.now() / 1000) + seconds,
  };
}
