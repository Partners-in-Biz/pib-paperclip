import { normalizeE164 } from "./phone.js";

export type ContactLookup = (companyId: string, e164: string) => Promise<string[]>;

export interface DecideRecordingDeps {
  lookup: ContactLookup;
  prefs: (companyId: string, contactIds: string[]) => Promise<Array<{ do_not_record: boolean; erased_at: string | null }>>;
}

export async function decideRecording(
  deps: DecideRecordingDeps,
  companyId: string,
  toRaw: string,
): Promise<{ toE164: string | null; record: boolean; reason: string }> {
  // Normalize To number
  const toE164 = normalizeE164(toRaw);
  if (!toE164) {
    return { toE164: null, record: false, reason: "invalid_number" };
  }

  try {
    // Look up all contacts with this number
    const contactIds = await deps.lookup(companyId, toE164);

    // TRUST RULE: no contacts found -> no recording
    if (contactIds.length === 0) {
      return { toE164, record: false, reason: "unknown_number" };
    }

    // Get preferences for all contacts
    const prefs = await deps.prefs(companyId, contactIds);

    // ANY contact with do_not_record=true OR erased_at IS NOT NULL -> no recording
    for (const pref of prefs) {
      if (pref.do_not_record || pref.erased_at) {
        return { toE164, record: false, reason: "dnr_or_erased" };
      }
    }

    // All known, none opted out -> record
    return { toE164, record: true, reason: "allowed" };
  } catch {
    // DB error -> fail closed, no recording
    return { toE164, record: false, reason: "db_error" };
  }
}

export function buildVoiceTwiml({
  toE164,
  callerId,
  record,
  noticeUrl,
  recordingStatusUrl,
  xmlEscape,
}: {
  toE164: string | null;
  callerId: string;
  record: boolean;
  noticeUrl?: string;
  recordingStatusUrl?: string;
  xmlEscape: (s: string) => string;
}): string {
  // Invalid number
  if (!toE164) {
    return "<Response><Reject/></Response>";
  }

  // Escape attributes
  const escapedCallerId = xmlEscape(callerId);
  const escapedToE164 = xmlEscape(toE164);

  if (record) {
    // With recording: add url to Number element for notice playback
    const escapedNoticeUrl = noticeUrl ? xmlEscape(noticeUrl) : "";
    return `<Response><Dial callerId="${escapedCallerId}" record="record-from-answer-dual" recordingStatusCallback="${xmlEscape(recordingStatusUrl || "")}"><Number url="${escapedNoticeUrl}">${escapedToE164}</Number></Dial></Response>`;
  } else {
    // No recording
    return `<Response><Dial callerId="${escapedCallerId}"><Number>${escapedToE164}</Number></Dial></Response>`;
  }
}

/** Default contact lookup: throws on error to fail closed */
export async function defaultContactLookup(): Promise<string[]> {
  throw new Error("contact_lookup_unavailable");
}

/** Default prefs: throws on error to fail closed */
export async function defaultPrefs(): Promise<Array<{ do_not_record: boolean; erased_at: string | null }>> {
  throw new Error("contact_prefs_unavailable");
}
