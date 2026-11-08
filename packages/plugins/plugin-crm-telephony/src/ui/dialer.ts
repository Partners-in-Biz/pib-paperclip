/**
 * Pure logic utilities for the Dialer UI (no React imports).
 */

export interface DialerParams {
  to?: string;
  contactId?: string;
}

/**
 * Normalize dial input by removing formatting characters.
 * Strips spaces, dashes, parentheses, and dots.
 */
export function normalizeDialInput(raw: string): string {
  return raw.trim().replace(/[\s\-().]/g, "");
}

/**
 * Parse Dialer page query parameters.
 * to: trimmed, accepted only if E.164 format, else empty string
 * contactId: trimmed, max 64 chars, only [A-Za-z0-9_-], else empty string
 */
export function parseDialerParams(search: string): DialerParams {
  if (!search) return {};
  const params = new URLSearchParams(search);

  let to: string | undefined;
  const toParam = params.get("to");
  if (toParam) {
    const normalized = normalizeDialInput(toParam);
    if (isDialable(normalized)) {
      to = normalized;
    }
  }

  let contactId: string | undefined;
  const contactIdParam = params.get("contactId");
  if (contactIdParam) {
    const trimmed = contactIdParam.trim();
    if (trimmed.length <= 64 && /^[A-Za-z0-9_-]+$/.test(trimmed)) {
      contactId = trimmed;
    }
  }

  return { to, contactId };
}

/**
 * Check if a number is valid E.164 format: +[1-9]\d{6,14}
 */
export function isDialable(to: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(to);
}

/**
 * Event type for dial intent.
 */
export const DIAL_EVENT = "pib-telephony:dial";

/**
 * Build dial intent custom event.
 */
export function buildDialEvent(to: string, contactId?: string): CustomEvent<{ to: string; contactId?: string }> {
  return new CustomEvent(DIAL_EVENT, {
    detail: { to, contactId },
    bubbles: true,
    cancelable: true,
  });
}

// ---------------------------------------------------------------------------
// Call state helpers for the Dialer page (pure; the page owns the Twilio Device)
// ---------------------------------------------------------------------------

/**
 * idle → preparing (token + Device registration) → dialing (REST call) →
 * ringing (Twilio rings this browser, then the contact) → in_call → ended.
 * error can follow any phase.
 */
export type DialerPhase = "idle" | "preparing" | "dialing" | "ringing" | "in_call" | "ended" | "error";

/** How long to wait for Twilio to ring this browser after the REST call was accepted. */
export const INCOMING_WAIT_MS = 20_000;

/** How often the page asks the worker for the call row while a call runs. */
export const CALL_POLL_MS = 2_000;

/** 0:05, 12:34, 1:02:03 */
export function formatCallDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** The incoming call Twilio hands the browser must be the one this page asked for. */
export function isExpectedIncoming(params: Record<string, string> | undefined, expectedSid: string | null): boolean {
  if (!expectedSid || !params) return false;
  return params.CallSid === expectedSid;
}

/** What the status line says in each phase. `rowStatus` is the tel_calls row's status. */
export function phaseLabel(phase: DialerPhase, rowStatus: string | null): string {
  switch (phase) {
    case "idle": return "Ready to call";
    case "preparing": return "Connecting to Twilio…";
    case "dialing": return "Placing the call…";
    case "ringing":
      if (rowStatus === "ringing" || rowStatus === "connecting") return "Ringing the contact…";
      return "Connecting…";
    case "in_call": return "In call";
    case "ended": return callOutcomeLabel(rowStatus);
    case "error": return "Call failed";
  }
}

export function callOutcomeLabel(rowStatus: string | null): string {
  switch (rowStatus) {
    case "busy": return "Busy";
    case "no-answer": return "No answer";
    case "failed": return "Could not connect";
    case "canceled": return "Cancelled";
    case "completed": return "Call ended";
    default: return "Call ended";
  }
}

export interface FriendlyDialError {
  text: string;
  /** True when the fix lives in Telephony settings or the company secrets. */
  setup: boolean;
}

/** Turn a worker or SDK error into one sentence a salesperson can act on. */
export function friendlyDialError(message: string): FriendlyDialError {
  const m = message.trim();
  if (/credentials are not configured/i.test(m)) {
    return { text: "Voice calling is not set up yet: the Twilio secrets are missing. Open Telephony settings for the list.", setup: true };
  }
  if (/not enabled for (this|any) user/i.test(m) || /signed-in person/i.test(m)) {
    return { text: "Calling is not enabled for your user. Ask the owner to add your user id under Voice user IDs in Telephony settings.", setup: true };
  }
  if (/public base URL/i.test(m) || /TWILIO_(ZA|US)_NUMBER/i.test(m)) {
    return { text: m, setup: true };
  }
  if (/Permission denied|NotAllowedError|microphone|getUserMedia|AcquisitionFailed/i.test(m)) {
    return { text: "The browser blocked the microphone. Allow microphone access for this site and try again.", setup: false };
  }
  if (/AccessTokenInvalid|AccessTokenExpired|20101|20104/i.test(m)) {
    return { text: "The Twilio token was refused. Reload the page and try again; if it keeps happening, check the API key secrets.", setup: true };
  }
  return { text: m || "The call could not be placed.", setup: false };
}
