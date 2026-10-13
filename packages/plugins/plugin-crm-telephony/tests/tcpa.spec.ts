import { describe, it, expect } from "vitest";
import { checkCallingHours } from "../src/tcpa.js";

describe("checkCallingHours", () => {
  it.each([
    ["+15125551234", "2026-10-13T16:30:00Z", true], // 12:30 EDT, 11:30 CDT, 10:30 MDT, 09:30 PDT
    ["+15125551234", "2026-10-13T14:00:00Z", false], // 07:00 PDT (outside [8, 21))
    ["+15125551234", "2026-10-14T01:30:00Z", false], // 21:30 EDT (outside [8, 21))
    ["+18085551234", "2026-10-13T17:00:00Z", false], // 07:00 HST (outside)
    ["+18085551234", "2026-10-13T20:30:00Z", true], // 09:00 HST (within [8, 21))
    ["+19075551234", "2026-10-13T19:00:00Z", true], // 10:00 AKDT (within [8, 21))
    ["+15125551234", "2026-12-15T13:00:00Z", false], // 07:00 CST in winter (outside)
    ["+27821234567", "2026-10-13T00:00:00Z", true], // ZA always allowed
    ["+442079460958", "2026-10-13T02:00:00Z", true], // Non-US always allowed
  ])("check %s at %s", (phone, date, expected) => {
    const result = checkCallingHours(phone, new Date(date));
    expect(result.ok).toBe(expected);
  });
});
