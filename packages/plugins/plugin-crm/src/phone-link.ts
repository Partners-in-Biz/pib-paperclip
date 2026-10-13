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
 * @param base - optional base path (defaults to "/plugin")
 * @returns the href string for the dialer, or null if phone is invalid
 */
export function dialerHref(phone: string, contactId?: string | null, base?: string): string | null {
  if (!phone) return null;

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

  // Build the URL
  const baseUrl = base || "/plugin";
  const url = new URL(`${baseUrl}/${TELEPHONY_PLUGIN_KEY}/dialer`, "http://localhost");
  url.searchParams.set("to", converted);

  if (contactId && contactId.trim()) {
    url.searchParams.set("contactId", contactId.trim());
  }

  // Return the pathname + search, removing the http://localhost part
  return url.pathname + url.search;
}
