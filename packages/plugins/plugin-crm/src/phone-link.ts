/**
 * Pure utilities for generating dialer links (no React imports).
 */

export const TELEPHONY_PLUGIN_KEY = "partnersinbiz.crm-telephony";

/**
 * Normalize phone input by removing formatting characters.
 * Strips spaces, dashes, parentheses, and dots.
 */
function normalizePhoneInput(raw: string): string {
  return raw.trim().replace(/[\s\-().]/g, "");
}

/**
 * Check if a phone number is valid E.164 format: +[1-9]\d{6,14}
 */
function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}

/**
 * Validate contactId format: max 64 chars, only [A-Za-z0-9_-]
 */
function isValidContactId(id: string): boolean {
  return id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id);
}

/**
 * Convert South African local format to E.164.
 * 10-digit numbers starting with 0 are converted to +27 format.
 * @param normalized - the normalized phone number (no spaces/dashes/etc.)
 * @returns converted number or the input if not SA local format
 */
function convertSALocal(normalized: string): string {
  // Check for 10-digit number starting with 0 (South African local format)
  if (/^0\d{9}$/.test(normalized)) {
    return "+27" + normalized.substring(1);
  }
  return normalized;
}

/**
 * Encode a phone number for URL query parameter.
 * The plus sign needs to be URL-encoded as %2B.
 */
function encodePhoneForUrl(phone: string): string {
  return encodeURIComponent(phone);
}

/**
 * Generate a dialer href for a phone number.
 * @param phone - the phone number (can be in various formats)
 * @param contactId - optional contact ID to link the dial to
 * @param prefix - company prefix (required; returns null if missing)
 * @returns the href string for the dialer, or null if phone is invalid or prefix is missing
 */
export function dialerHref(phone: string, contactId?: string | null, prefix?: string | null): string | null {
  if (!phone) return null;

  // Prefix is required; return null if missing or empty
  if (!prefix || !prefix.trim()) return null;
  const trimmedPrefix = prefix.trim();

  // Normalize the input
  const normalized = normalizePhoneInput(phone);
  if (!normalized) return null;

  // Convert South African local format if applicable
  const converted = convertSALocal(normalized);

  // Validate E.164 format
  if (!isValidE164(converted)) return null;

  // Validate contactId if provided
  if (contactId !== null && contactId !== undefined) {
    const trimmed = contactId.trim();
    if (trimmed && !isValidContactId(trimmed)) {
      return null;
    }
  }

  // Build the href using string concatenation
  let href = `/${encodeURIComponent(trimmedPrefix)}/dialer?to=${encodeURIComponent(converted)}`;

  if (contactId && contactId.trim()) {
    href += `&contactId=${encodeURIComponent(contactId.trim())}`;
  }

  return href;
}
