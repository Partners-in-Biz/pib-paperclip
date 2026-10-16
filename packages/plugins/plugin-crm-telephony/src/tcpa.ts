import { phoneRegion } from "./phone.js";

export type CallingHours = { ok: true } | { ok: false; reason: "outside_us_calling_hours" };

function getLocalHour(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const hourPart = parts.find((p) => p.type === "hour");
  return parseInt(hourPart?.value ?? "0", 10);
}

export function checkCallingHours(toE164: string, now: Date): CallingHours {
  // TCPA rules only apply to US numbers
  if (phoneRegion(toE164) !== "US") {
    return { ok: true };
  }

  // Area code is 3 digits after +1; zone selection: 808→Hawaii, 907→Alaska, else lower-48
  // Effective window is 11:00-21:00 Eastern (most restrictive across the four zones)
  const areaCode = toE164.slice(2, 5);
  const zones = areaCode === "808"
    ? ["Pacific/Honolulu"]
    : areaCode === "907"
      ? ["America/Anchorage"]
      : ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];

  // Check if the local hour is within [8, 21) in EVERY candidate time zone
  for (const zone of zones) {
    const hour = getLocalHour(now, zone);
    if (hour < 8 || hour >= 21) {
      return { ok: false, reason: "outside_us_calling_hours" };
    }
  }

  return { ok: true };
}
