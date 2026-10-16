import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { normalizeE164 } from "./phone.js";

export interface ContactMatchResult {
  contactId: string | null;
  ambiguous: boolean;
  candidateIds: string[];
}

/**
 * Match contacts by phone number using E.164 normalized form.
 *
 * Security rules (applied strictly):
 * - Scope by company_id (must match signature-verified company)
 * - Ignore rows with deleted = true
 * - SQL prefilter by last 9 digits as optimization only
 * - Final match: normalizing one of contact's phones with normalizeE164 must give EXACTLY the inbound e164
 *
 * Returns:
 * - Exactly 1 match: { contactId, ambiguous: false, candidateIds: [id] }
 * - 2+ matches: { contactId: null, ambiguous: true, candidateIds: [...] }
 * - 0 matches: { contactId: null, ambiguous: false, candidateIds: [] }
 *
 * Never picks one of several candidates.
 */
export async function matchContactsByPhone(
  dbClient: PluginDatabaseClient,
  namespace: string,
  companyId: string,
  e164: string,
): Promise<ContactMatchResult> {
  // Extract last 9 digits for SQL prefilter
  const digits = e164.replace(/\D/g, "");
  const last9 = digits.slice(-9);

  // Query contacts in this company (not deleted) where a phone's last 9 digits match
  const rows = (await dbClient.query(
    `SELECT id, phones FROM ${namespace}.crm_contacts
     WHERE company_id = $1
       AND deleted = false
       AND EXISTS (
         SELECT 1 FROM unnest(phones) p
         WHERE regexp_replace(p, '\\D', '', 'g') LIKE '%' || $2
       )`,
    [companyId, last9],
  )) as Array<{ id: string; phones: string[] | null }>;

  // Filter to exact normalizeE164 matches
  const candidates: string[] = [];

  for (const row of rows) {
    if (!row.phones) continue;

    for (const rawPhone of row.phones) {
      const normalized = normalizeE164(rawPhone);
      if (normalized === e164) {
        candidates.push(row.id);
        break; // Only count this contact once
      }
    }
  }

  // Remove duplicates and sort
  const uniqueCandidates = Array.from(new Set(candidates)).sort();

  if (uniqueCandidates.length === 1) {
    return {
      contactId: uniqueCandidates[0],
      ambiguous: false,
      candidateIds: uniqueCandidates,
    };
  }

  if (uniqueCandidates.length > 1) {
    return {
      contactId: null,
      ambiguous: true,
      candidateIds: uniqueCandidates,
    };
  }

  return {
    contactId: null,
    ambiguous: false,
    candidateIds: [],
  };
}
