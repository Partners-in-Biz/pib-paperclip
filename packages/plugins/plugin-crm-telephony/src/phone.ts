export type PhoneRegion = "ZA" | "US";

export function normalizeE164(raw: string, defaultRegion: PhoneRegion = "ZA"): string | null {
  let s = raw.replace(/\s/g, "").replace(/-/g, "").replace(/\./g, "");

  // Handle (0) trunk marker after country code while parentheses still present
  s = s.replace(/^(\+\d{2})\(0\)/, "$1");

  // Remove remaining parentheses
  s = s.replace(/[()]/g, "");

  // Leading 00 → +
  if (s.startsWith("00")) {
    s = "+" + s.slice(2);
  }

  // Reject anything with letters or extension markers
  if (/[a-z#*]/i.test(s)) return null;

  // If it starts with +
  if (s.startsWith("+")) {
    const plus = s.slice(1);

    // +27 with exactly 9 digits (first digit 1-8)
    if (s.startsWith("+27")) {
      const digits = plus.slice(2);
      if (/^\d{9}$/.test(digits) && /^[1-8]/.test(digits)) return s;
      return null;
    }

    // +1 with exactly 10 digits (NANP: area code and exchange first digit 2-9)
    if (s.startsWith("+1")) {
      const digits = plus.slice(1);
      if (/^\d{10}$/.test(digits) && /^[2-9]/.test(digits) && /^[2-9]/.test(digits[3]!)) return s;
      return null;
    }

    // Any other +: generic E.164 (8-15 digits, first digit not 0)
    if (/^\+[1-9]\d{7,14}$/.test(s)) return s;

    return null;
  }

  // Without +: match by defaultRegion only
  if (defaultRegion === "ZA") {
    // ZA national: 0 + 9 digits (second digit 1-8)
    if (/^0[1-8]\d{8}$/.test(s)) return "+27" + s.slice(1);
    // ZA full: 27 + 9 digits
    if (/^27[1-8]\d{8}$/.test(s)) return "+" + s;
    // ZA bare: 9 digits (second digit 1-8)
    if (/^[1-8]\d{8}$/.test(s)) return "+27" + s;
    return null;
  }

  if (defaultRegion === "US") {
    // US full: 1 + 10 digits with area and exchange 2-9
    if (/^1[2-9]\d{9}$/.test(s) && /^[2-9]/.test(s[3]!)) return "+" + s;
    // US bare: 10 digits with area and exchange 2-9
    if (/^[2-9]\d{9}$/.test(s) && /^[2-9]/.test(s[3]!)) return "+1" + s;
    return null;
  }

  return null;
}

export function phoneRegion(e164: string): "ZA" | "US" | "OTHER" {
  if (e164.startsWith("+27")) return "ZA";
  if (e164.startsWith("+1")) return "US";
  return "OTHER";
}
