import { phoneRegion } from "./phone.js";

export type CallerIdPick =
  | { ok: true; callerId: string; region: "ZA" | "US" }
  | { ok: false; reason: "unsupported_region" | "caller_id_not_configured" };

export function pickCallerId(toE164: string, numbers: { za?: string; us?: string }): CallerIdPick {
  const region = phoneRegion(toE164);

  if (region === "ZA") {
    const callerId = numbers.za;
    if (!callerId) {
      return { ok: false, reason: "caller_id_not_configured" };
    }
    return { ok: true, callerId, region: "ZA" };
  }

  if (region === "US") {
    const callerId = numbers.us;
    if (!callerId) {
      return { ok: false, reason: "caller_id_not_configured" };
    }
    return { ok: true, callerId, region: "US" };
  }

  return { ok: false, reason: "unsupported_region" };
}
