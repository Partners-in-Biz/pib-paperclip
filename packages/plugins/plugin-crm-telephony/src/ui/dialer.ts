/**
 * Pure logic utilities for the Dialer UI (no React imports).
 */

export interface DialerParams {
  to?: string;
  contactId?: string;
}

/**
 * Parse Dialer page query parameters.
 */
export function parseDialerParams(search: string): DialerParams {
  if (!search) return {};
  const params = new URLSearchParams(search);
  const to = params.get("to") ?? undefined;
  const contactId = params.get("contactId") ?? undefined;
  return { to, contactId };
}

/**
 * Format duration in seconds as HH:MM:SS.
 */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [h, m, s].map((n) => String(n).padStart(2, "0"));
  return h > 0 ? parts.join(":") : parts.slice(1).join(":");
}

/**
 * Validate DTMF digit: 0-9, *, or #.
 */
export function isValidDtmf(digit: string): boolean {
  return /^[0-9*#]$/.test(digit);
}

/**
 * Softphone state machine reducer.
 */
export interface SoftphoneState {
  status: "idle" | "dialing" | "ringing" | "connected" | "error";
  currentNumber?: string;
  durationSeconds: number;
  isMuted: boolean;
  isRecording: boolean;
  error?: string;
}

export type SoftphoneAction =
  | { type: "dial"; number: string }
  | { type: "ring" }
  | { type: "connect" }
  | { type: "tick" }
  | { type: "hangup" }
  | { type: "mute" }
  | { type: "unmute" }
  | { type: "recordingStart" }
  | { type: "recordingStop" }
  | { type: "error"; message: string }
  | { type: "reset" };

export const initialSoftphoneState: SoftphoneState = {
  status: "idle",
  durationSeconds: 0,
  isMuted: false,
  isRecording: false,
};

export function softphoneReducer(state: SoftphoneState, action: SoftphoneAction): SoftphoneState {
  switch (action.type) {
    case "dial":
      return { ...state, status: "dialing", currentNumber: action.number, durationSeconds: 0, error: undefined };
    case "ring":
      return { ...state, status: "ringing" };
    case "connect":
      return { ...state, status: "connected", durationSeconds: 0, isMuted: false };
    case "tick":
      return state.status === "connected" ? { ...state, durationSeconds: state.durationSeconds + 1 } : state;
    case "hangup":
      return { ...initialSoftphoneState };
    case "mute":
      return { ...state, isMuted: true };
    case "unmute":
      return { ...state, isMuted: false };
    case "recordingStart":
      return { ...state, isRecording: true };
    case "recordingStop":
      return { ...state, isRecording: false };
    case "error":
      return { ...state, status: "error", error: action.message };
    case "reset":
      return { ...initialSoftphoneState };
    default:
      return state;
  }
}
