/**
 * Pure logic utilities for the Dialer UI (no React imports).
 */

export interface DialerParams {
  to?: string;
  contactId?: string;
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
    const trimmed = toParam.trim();
    const normalized = trimmed.replace(/[\s\-()]/g, "");
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
