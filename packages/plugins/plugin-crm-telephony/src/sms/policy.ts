export type SmsKeyword = "stop" | "help" | null;

const STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "OPT OUT",
  "OPTOUT",
  "HOU OP",
  "HOUOP",
]);

const HELP_KEYWORDS = new Set(["HELP", "HULP", "INFO"]);

export function classifyInboundKeyword(body: string): SmsKeyword {
  // Trim, convert to uppercase, strip trailing punctuation
  const normalized = body.trim().toUpperCase().replace(/[.,!?;:]*$/, "");

  // Whole-message match only: no leading or trailing text
  if (STOP_KEYWORDS.has(normalized)) return "stop";
  if (HELP_KEYWORDS.has(normalized)) return "help";

  return null;
}

export function isWithinMarketingWindow(at: Date, holidays: readonly string[]): boolean {
  // Format in SAST timezone to extract date and time components
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(at);
  const dateStr = `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}-${parts.find((p) => p.type === "day")?.value}`;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);

  // Check if date is in holidays list
  if (holidays.includes(dateStr)) return false;

  // Compute day of week in SAST: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const dayOfWeek = new Date(`${dateStr}T00:00:00Z`).getUTCDay();

  // Sunday is never allowed
  if (dayOfWeek === 0) return false;

  // Monday-Friday (1-5): 08:00-20:00 (inclusive start, exclusive end)
  if (dayOfWeek >= 1 && dayOfWeek <= 5) {
    const timeInMinutes = hour * 60 + minute;
    return timeInMinutes >= 8 * 60 && timeInMinutes < 20 * 60;
  }

  // Saturday (6): 09:00-13:00 (inclusive start, exclusive end)
  if (dayOfWeek === 6) {
    const timeInMinutes = hour * 60 + minute;
    return timeInMinutes >= 9 * 60 && timeInMinutes < 13 * 60;
  }

  return false;
}

export function withOptOutLine(body: string, kind: "marketing" | "service"): string {
  if (kind === "service") return body;

  // Check if already contains "reply stop" (case-insensitive)
  if (/reply\s+stop/i.test(body)) return body;

  return body + "\nReply STOP to opt out";
}

export const STOP_CONFIRMATION = "You have been unsubscribed and will receive no more messages from us. Reply HELP for help.";
export const HELP_REPLY = "Reply STOP to unsubscribe. For help contact us on our usual business number.";
