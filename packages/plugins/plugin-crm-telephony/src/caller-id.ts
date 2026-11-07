import { phoneRegion } from "./phone.js";
import { leadCallingCode, pickNumber, type NumberPurpose, type TelephonyNumber } from "./numbers.js";

export type CallerNumberPick =
  | { ok: true; callerId: string; number: TelephonyNumber; callingCode: string; matchedBy: "region" | "default" }
  | { ok: false; reason: "no_numbers" | "no_match"; callingCode: string; message: string };

/**
 * The caller ID for a destination from the company's number list: a number that
 * serves the lead's country calling code, else the default. The message names
 * where to fix it.
 */
export function pickCallerNumber(toE164: string, numbers: TelephonyNumber[], purpose: NumberPurpose = "voice"): CallerNumberPick {
  const callingCode = leadCallingCode(toE164, numbers);
  const pick = pickNumber(toE164, numbers, purpose);
  if (pick.ok) return { ok: true, callerId: pick.number.e164, number: pick.number, callingCode, matchedBy: pick.matchedBy };
  const what = purpose === "voice" ? "Voice" : purpose === "sms" ? "SMS" : "WhatsApp";
  const message = pick.reason === "no_numbers"
    ? `No ${what} number is set up. Add one under Numbers in Telephony settings.`
    : `No enabled ${what} number serves +${callingCode} and none is the default. Add a region or a default under Numbers in Telephony settings.`;
  return { ok: false, reason: pick.reason, callingCode, message };
}

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
