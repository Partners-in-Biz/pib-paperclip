/**
 * Hermes prints the session id at process exit in quiet mode. A killed or
 * failed run then has a transcript on disk and no id for the next wake, so
 * Paperclip starts the task over. `--format stream-json` emits the id in the
 * first `system/init` event. These helpers find that id as soon as it appears.
 */

export interface HermesStreamEvent {
  type: string;
  subtype?: string;
  sessionId?: string;
  text?: string;
  name?: string;
  exitCode?: number;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
}

const CHECKPOINT_OFF = new Set(["0", "false", "off", "no"]);

/** Default on. Set PAPERCLIP_SESSION_CHECKPOINT=0 to restore full-rerun wakes. */
export function sessionCheckpointResumeEnabled(
  env: Record<string, string | undefined> = process.env,
) {
  const raw = env.PAPERCLIP_SESSION_CHECKPOINT;
  if (raw == null || raw.trim() === "") return true;
  return !CHECKPOINT_OFF.has(raw.trim().toLowerCase());
}

const SESSION_ID_TEXT =
  /session[_ ](?:id|saved)[:\s]+([A-Za-z0-9_-]+)/i;

export function isPlausibleHermesSessionId(value: string | null | undefined): value is string {
  if (!value) return false;
  return (
    /^\d{8}_\d{6}_[A-Za-z0-9_-]{4,}$/.test(value) ||
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)
  );
}

export function extractHermesSessionId(text: string): string | null {
  const json = text.match(/"session_id"\s*:\s*"([A-Za-z0-9_-]+)"/);
  if (json?.[1] && isPlausibleHermesSessionId(json[1])) return json[1];
  const plain = text.match(SESSION_ID_TEXT);
  if (plain?.[1] && isPlausibleHermesSessionId(plain[1])) return plain[1];
  return null;
}

export function parseHermesStreamJsonLine(line: string): HermesStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (!type) return null;
  const sessionId = typeof record.session_id === "string" ? record.session_id : undefined;
  const tokens =
    record.tokens && typeof record.tokens === "object" && !Array.isArray(record.tokens)
      ? (record.tokens as Record<string, unknown>)
      : null;
  const usage = tokens
    ? {
        inputTokens: Number(tokens.input) || 0,
        outputTokens: Number(tokens.output) || 0,
        ...(Number(tokens.cache_read) > 0
          ? { cachedInputTokens: Number(tokens.cache_read) }
          : {}),
      }
    : undefined;
  return {
    type,
    ...(typeof record.subtype === "string" ? { subtype: record.subtype } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(typeof record.text === "string" ? { text: record.text } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.exit_code === "number" ? { exitCode: record.exit_code } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(usage ? { usage } : {}),
  };
}

export function formatHermesStreamEventForLog(event: HermesStreamEvent): string | null {
  if (event.type === "system" && event.subtype === "init" && event.sessionId) {
    return `[hermes] Session checkpoint: ${event.sessionId}`;
  }
  if (event.type === "tool_use" && event.name) {
    return `[hermes] tool ${event.name}`;
  }
  if (event.type === "result") {
    const exit = event.exitCode == null ? "" : ` exit=${event.exitCode}`;
    return `[hermes] stream result${exit}`;
  }
  return null;
}

export function parseHermesStreamJsonOutput(stdout: string): {
  sessionId?: string;
  response?: string;
  usage?: HermesStreamEvent["usage"];
  errorMessage?: string;
} {
  let sessionId: string | undefined;
  let response: string | undefined;
  let usage: HermesStreamEvent["usage"];
  let errorMessage: string | undefined;
  for (const line of stdout.split("\n")) {
    const event = parseHermesStreamJsonLine(line);
    if (!event) {
      const plain = extractHermesSessionId(line);
      if (plain) sessionId = plain;
      continue;
    }
    if (event.sessionId && isPlausibleHermesSessionId(event.sessionId)) {
      sessionId = event.sessionId;
    }
    if (event.type !== "result") continue;
    if (event.text?.trim()) response = event.text.trim();
    if (event.usage) usage = event.usage;
    if (event.error) errorMessage = event.error;
  }
  return { sessionId, response, usage, errorMessage };
}
