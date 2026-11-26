import { GEMINI_INTERACTIONS_URL, XAI_TTS_URL } from "./namespace.js";
import {
  GEMINI_STYLE_MAX_CHARS,
  GEMINI_TTS_MODEL,
  MAX_TTS_AUDIO_BYTES,
  PROVIDER_TIMEOUT_MS,
  TTS_SAMPLE_RATE,
} from "./limits.js";

type FetchLike = typeof fetch;

/** What one provider call came to. Never carries a provider error body: it can echo request detail. */
export type TtsOutcome = "ok" | "not_configured" | "auth_failed" | "rate_limited" | "provider_error" | "timeout" | "daily_limit";

export type TtsResult = { outcome: "ok"; audio: string } | { outcome: Exclude<TtsOutcome, "ok"> };

export interface GeminiSpeakInput {
  apiKey: string;
  text: string;
  voice: string;
  /** Sent only as `speech_metadata.style`, never inside `text`. */
  style?: string;
  timeoutMs?: number;
}

export interface XaiSpeakInput {
  apiKey: string;
  text: string;
  voice: string;
  /** Language code, or empty for automatic detection. */
  language?: string;
  timeoutMs?: number;
}

/** Control characters, newlines and bracket characters out, whitespace collapsed, capped. */
export function cleanStyle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[<>[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, GEMINI_STYLE_MAX_CHARS)
    .trim();
}

export function geminiRequestBody(input: Pick<GeminiSpeakInput, "text" | "voice" | "style">): string {
  const style = cleanStyle(input.style);
  const part: Record<string, unknown> = { type: "text", text: input.text };
  if (style) part.annotations = [{ type: "speech_metadata", style }];
  return JSON.stringify({
    model: GEMINI_TTS_MODEL,
    input: [{ type: "user_input", content: [part] }],
    response_format: { type: "audio", mime_type: "audio/l16", sample_rate: TTS_SAMPLE_RATE },
    generation_config: { speech_config: [{ voice: input.voice }] },
  });
}

export function xaiRequestBody(input: Pick<XaiSpeakInput, "text" | "voice" | "language">): string {
  return JSON.stringify({
    text: input.text,
    voice_id: input.voice,
    language: input.language || "auto",
    output_format: { codec: "pcm", sample_rate: TTS_SAMPLE_RATE },
  });
}

function statusOutcome(status: number): Exclude<TtsOutcome, "ok"> {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  return "provider_error";
}

/**
 * One POST with a hard abort. The race makes the timeout hold even for a fetch that ignores its signal.
 * Reading the body is inside the budget too.
 */
async function post<T>(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  read: (res: Response) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; outcome: Exclude<TtsOutcome, "ok"> }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });
  const work = (async () => {
    const res = await fetchImpl(url, { method: "POST", headers, body, signal: controller.signal });
    if (!res.ok) return { ok: false as const, outcome: statusOutcome(res.status) };
    return { ok: true as const, value: await read(res) };
  })();
  work.catch(() => undefined);
  try {
    const first = await Promise.race([work, expired]);
    if (first === "timeout") return { ok: false, outcome: "timeout" };
    return first;
  } catch (error) {
    if (controller.signal.aborted || (error as { name?: string })?.name === "AbortError") return { ok: false, outcome: "timeout" };
    return { ok: false, outcome: "provider_error" };
  } finally {
    clearTimeout(timer);
  }
}

/** The last audio item over `steps[].content[]`; its `data` is base64 PCM16 LE mono 24 kHz. */
export function geminiAudioFrom(body: unknown): string | null {
  const steps = (body as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return null;
  let found: string | null = null;
  for (const step of steps) {
    const content = (step as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const rec = item as { type?: unknown; data?: unknown };
      if (rec?.type === "audio" && typeof rec.data === "string" && rec.data) found = rec.data;
    }
  }
  return found;
}

const base64Bytes = (value: string) => Math.floor((value.length * 3) / 4);

export async function geminiSpeak(input: GeminiSpeakInput, fetchImpl: FetchLike = fetch): Promise<TtsResult> {
  const res = await post(
    fetchImpl,
    GEMINI_INTERACTIONS_URL,
    { "x-goog-api-key": input.apiKey, "Content-Type": "application/json" },
    geminiRequestBody(input),
    input.timeoutMs ?? PROVIDER_TIMEOUT_MS,
    async (r) => geminiAudioFrom(await r.json()),
  );
  if (!res.ok) return { outcome: res.outcome };
  if (!res.value || base64Bytes(res.value) > MAX_TTS_AUDIO_BYTES) return { outcome: "provider_error" };
  return { outcome: "ok", audio: res.value };
}

export async function xaiSpeak(input: XaiSpeakInput, fetchImpl: FetchLike = fetch): Promise<TtsResult> {
  const res = await post(
    fetchImpl,
    XAI_TTS_URL,
    { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    xaiRequestBody(input),
    input.timeoutMs ?? PROVIDER_TIMEOUT_MS,
    async (r) => Buffer.from(await r.arrayBuffer()),
  );
  if (!res.ok) return { outcome: res.outcome };
  if (res.value.byteLength === 0 || res.value.byteLength > MAX_TTS_AUDIO_BYTES) return { outcome: "provider_error" };
  return { outcome: "ok", audio: res.value.toString("base64") };
}
