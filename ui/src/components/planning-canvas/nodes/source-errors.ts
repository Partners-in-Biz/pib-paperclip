import { PLANNING_CANVAS_SOURCE_ERROR_CODES as CODES } from "@paperclipai/shared";
import { ApiError } from "@/api/client";

/** Plain-language copy for the connector source refusals (PAR-14257 D 4a). */
const MESSAGES: Record<string, string> = {
  [CODES.personalSourceRefused]:
    "This board is shared, so the agent cannot use your personal connections (for example your own Google account) here. Use a company connection, or do this on your own personal board.",
  [CODES.refreshDisabled]: "Refreshing from a source is switched off.",
  [CODES.noSource]: "This node has no connector source to refresh.",
  [CODES.toolNotAllowed]: "The agent may no longer use this read action, so it cannot refresh.",
  [CODES.unknownAgent]: "The agent that fetched this data is no longer active.",
  [CODES.personRequired]: "Refreshing needs a signed-in person.",
};

export function sourceRefusalMessage(code: string | null | undefined): string | null {
  return (code && MESSAGES[code]) || null;
}

/** The refusal behind an error, or the error's own message. */
export function sourceErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return sourceRefusalMessage(err.code) ?? err.message;
  return err instanceof Error ? err.message : "Something went wrong.";
}

/** An agent reply that carries the personal-source refusal code gets the plain message under it. */
export function personalRefusalIn(body: string): string | null {
  return body.includes(CODES.personalSourceRefused) ? MESSAGES[CODES.personalSourceRefused]! : null;
}
