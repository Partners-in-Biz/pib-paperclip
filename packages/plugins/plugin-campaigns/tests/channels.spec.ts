import { describe, expect, it } from "vitest";
import {
  campaignPhone,
  classifyKeyword,
  DEFAULT_SEND_WINDOWS,
  describeWindows,
  isInSendWindow,
  isMobile,
  localParts,
  maskEmail,
  maskPhone,
  nextSendWindow,
  normalizePhone,
  parseChannel,
  parseSendWindows,
  smsLength,
  hasOptOutInstruction,
  withOptOutLine,
} from "../src/channels.js";

const TZ = "Africa/Johannesburg";
/** A South African wall-clock time (UTC+2, no daylight saving) as an instant. */
const sa = (iso: string) => new Date(`${iso}+02:00`);

describe("channels", () => {
  it("defaults to email and rejects anything else that is not a channel", () => {
    expect(parseChannel(undefined)).toBe("email");
    expect(parseChannel("")).toBe("email");
    expect(parseChannel("sms")).toBe("sms");
    expect(parseChannel("whatsapp")).toBe("whatsapp");
    expect(() => parseChannel("fax")).toThrow(/email, sms or whatsapp/);
  });
});

describe("phone numbers", () => {
  it("writes South African numbers as E.164 however they are typed", () => {
    for (const raw of ["082 123 4567", "0821234567", "+27 82 123 4567", "27821234567", "0027821234567", "+27 (0) 82 123 4567", "(082) 123-4567", "821234567", "whatsapp:+27821234567"]) {
      expect(normalizePhone(raw), raw).toBe("+27821234567");
    }
  });

  it("keeps other countries' numbers and refuses what cannot be a number", () => {
    expect(normalizePhone("+44 7911 123456")).toBe("+447911123456");
    expect(normalizePhone("+1 (415) 555-0100")).toBe("+14155550100");
    for (const bad of [null, undefined, "", "abc", "12345", "+27 82 123 456", "+27 82 123 45678", "+0123456789"]) expect(normalizePhone(bad as string | null), String(bad)).toBeNull();
    // A leading 0 belongs to the default country, which a company can change.
    expect(normalizePhone("0211234567", "+44")).toBe("+44211234567");
  });

  it("never texts a landline and takes the first mobile in the list", () => {
    expect(isMobile("+27821234567")).toBe(true);
    expect(isMobile("+27111234567")).toBe(false);
    expect(campaignPhone(["011 123 4567", "082 123 4567"])).toBe("+27821234567");
    expect(campaignPhone(["011 123 4567"])).toBeNull();
    expect(campaignPhone([])).toBeNull();
    expect(campaignPhone(undefined)).toBeNull();
  });

  it("masks what goes in logs and titles", () => {
    expect(maskPhone("+27821234567")).toBe("+27*****4567");
    expect(maskPhone("+27821234567")).not.toContain("82123");
    expect(maskEmail("ada@acme.test")).toBe("a***@acme.test");
  });
});

describe("SMS length", () => {
  it("counts plain text as GSM-7: 160 in one part, 153 per part after that", () => {
    expect(smsLength("")).toMatchObject({ segments: 0, encoding: "gsm7" });
    expect(smsLength("a".repeat(160))).toMatchObject({ segments: 1, units: 160, encoding: "gsm7", perSegment: 160 });
    expect(smsLength("a".repeat(161))).toMatchObject({ segments: 2, perSegment: 153 });
    expect(smsLength("a".repeat(306))).toMatchObject({ segments: 2 });
    expect(smsLength("a".repeat(307))).toMatchObject({ segments: 3 });
  });

  it("counts the GSM escape characters twice", () => {
    expect(smsLength("[x]")).toMatchObject({ units: 5, encoding: "gsm7" });
    expect(smsLength("€")).toMatchObject({ units: 2, encoding: "gsm7" });
    // 80 euro signs are 160 units: one part; 81 are 162 units: two.
    expect(smsLength("€".repeat(80)).segments).toBe(1);
    expect(smsLength("€".repeat(81)).segments).toBe(2);
  });

  it("switches the whole message to UCS-2 for one character outside GSM-7", () => {
    const smart = smsLength(`${"a".repeat(100)}’`);
    expect(smart).toMatchObject({ encoding: "ucs2", units: 101, segments: 2, perSegment: 67 });
    expect(smart.nonGsm).toEqual(["’"]);
    expect(smsLength("a".repeat(70) + "“")).toMatchObject({ encoding: "ucs2", segments: 2 });
    expect(smsLength("“" + "a".repeat(69))).toMatchObject({ encoding: "ucs2", segments: 1, units: 70 });
    // An emoji is two UTF-16 units.
    expect(smsLength("\u{1F600}")).toMatchObject({ encoding: "ucs2", units: 2 });
    expect(smsLength("ç").encoding).toBe("ucs2");
    expect(smsLength("é").encoding).toBe("gsm7");
  });

  it("adds the opt-out line unless the text already tells the reader to send STOP", () => {
    expect(withOptOutLine("Hi Ada, 10% off")).toBe("Hi Ada, 10% off Reply STOP to opt out.");
    expect(withOptOutLine("")).toBe("Reply STOP to opt out.");
    // The text says it itself: left as written, in any of the usual ways.
    for (const text of [
      "Hi. Text STOP to stop.",
      "Hi. text stop to quit",
      "Hi Ada. Reply STOP to opt out.",
      'Hi Ada. Reply "STOP" to unsubscribe.',
      "Hi Ada. Reply \u2018stop\u2019 to end these.",
      "Hi Ada. Reply with the word STOP.",
      "Send STOP to 31234 to unsubscribe",
      "To opt out, text us STOP",
      "Reply UNSUBSCRIBE",
      "SMS STOP to opt out",
      "STOP to opt out",
      "Stop to cancel these texts",
    ]) {
      expect(withOptOutLine(text), text).toBe(text);
      expect(hasOptOutInstruction(text), text).toBe(true);
    }
  });

  it("marketing copy that merely contains the word stop still gets the opt-out line (POPIA, CPA)", () => {
    for (const text of [
      "Stop paying too much for electricity. Save 20% today",
      "Visit us next to the bus stop on Main Rd",
      "Bus stopping soon",
      "Don't stop now: reply YES to claim your gift",
      "Text us to stop the leaks for good",
      "Reply to this message to stop paying more",
      "Send us a message to stop wasting water",
      "Reply STOP paying too much: ask for a quote",
      "Our opt-out policy is on our site",
      "Stopwatch sale this weekend",
      "Stop. Think. Save.",
    ]) {
      expect(withOptOutLine(text), text).toBe(`${text} Reply STOP to opt out.`);
      expect(hasOptOutInstruction(text), text).toBe(false);
    }
  });
});

describe("opt-out and opt-in words", () => {
  it("treats the standard STOP words as opt-out, in any case and with punctuation", () => {
    for (const word of ["STOP", "stop", "Stop.", " stop! ", "STOPALL", "Stop all", "UNSUBSCRIBE", "cancel", "END", "Quit", "OPTOUT", "opt out", "opt-out", "revoke"]) {
      expect(classifyKeyword(word), word).toBe("stop");
    }
  });

  it("treats plain sentences that ask to stop as opt-out", () => {
    for (const text of ["Stop texting me", "stop sending me messages", "Please stop messaging me", "Don't text me again", "do not contact me", "remove me from your list", "Take me off the list", "no more texts", "leave me alone", "Unsubscribe me please", "STOP please"]) {
      expect(classifyKeyword(text), text).toBe("stop");
    }
  });

  it("does not stop someone who only used one of those words in another sentence", () => {
    for (const text of ["Can you cancel my appointment?", "When does it end?", "I quit my job last week", "The bus stopped here", "Yes please", "Interested, call me", "stopped by your shop yesterday"]) {
      expect(classifyKeyword(text), text).toBe("other");
    }
  });

  it("reads START and UNSTOP as opt-in, HELP as help, and nothing as other", () => {
    expect(classifyKeyword("START")).toBe("start");
    expect(classifyKeyword("unstop")).toBe("start");
    expect(classifyKeyword("YES")).toBe("other");
    expect(classifyKeyword("HELP")).toBe("help");
    expect(classifyKeyword("info")).toBe("help");
    expect(classifyKeyword("")).toBe("other");
    expect(classifyKeyword(null)).toBe("other");
  });

  it("reads curly apostrophes the same as straight ones", () => {
    expect(classifyKeyword("Don’t text me")).toBe("stop");
  });
});

describe("send windows", () => {
  it("allows Mon-Fri 08:00-20:00, Saturday 09:00-13:00 and never Sunday by default", () => {
    // 2026-10-05 is a Monday.
    expect(isInSendWindow(sa("2026-10-05T07:59:00"), TZ)).toBe(false);
    expect(isInSendWindow(sa("2026-10-05T08:00:00"), TZ)).toBe(true);
    expect(isInSendWindow(sa("2026-10-05T19:59:00"), TZ)).toBe(true);
    expect(isInSendWindow(sa("2026-10-05T20:00:00"), TZ)).toBe(false);
    expect(isInSendWindow(sa("2026-10-09T12:00:00"), TZ)).toBe(true);
    expect(isInSendWindow(sa("2026-10-10T08:59:00"), TZ)).toBe(false);
    expect(isInSendWindow(sa("2026-10-10T09:00:00"), TZ)).toBe(true);
    expect(isInSendWindow(sa("2026-10-10T13:00:00"), TZ)).toBe(false);
    expect(isInSendWindow(sa("2026-10-11T12:00:00"), TZ)).toBe(false);
  });

  it("reads the time in the company's zone, not the server's", () => {
    // 07:00 UTC is 09:00 in Johannesburg (open) and 03:00 in New York (closed).
    const at = new Date("2026-10-05T07:00:00Z");
    expect(isInSendWindow(at, TZ)).toBe(true);
    expect(isInSendWindow(at, "America/New_York")).toBe(false);
    expect(localParts(at, TZ)).toEqual({ weekday: 1, minutes: 540, date: "2026-10-05" });
    // An unknown zone falls back to South Africa instead of throwing.
    expect(isInSendWindow(at, "Not/AZone")).toBe(true);
  });

  it("honours blackout dates (public holidays)", () => {
    const windows = parseSendWindows({ blackoutDates: "2026-10-05, 2026-12-25\n2026-12-26;bad-date" });
    expect(windows.blackout).toEqual(["2026-10-05", "2026-12-25", "2026-12-26"]);
    expect(isInSendWindow(sa("2026-10-05T10:00:00"), TZ, windows)).toBe(false);
    expect(isInSendWindow(sa("2026-10-06T10:00:00"), TZ, windows)).toBe(true);
  });

  it("takes the windows from settings and keeps the default for a value that does not parse", () => {
    const custom = parseSendWindows({ weekdays: "09:00-17:00", saturday: "off", sunday: "10:00-12:00" });
    expect(isInSendWindow(sa("2026-10-05T08:30:00"), TZ, custom)).toBe(false);
    expect(isInSendWindow(sa("2026-10-05T16:59:00"), TZ, custom)).toBe(true);
    expect(isInSendWindow(sa("2026-10-10T10:00:00"), TZ, custom)).toBe(false);
    expect(isInSendWindow(sa("2026-10-11T11:00:00"), TZ, custom)).toBe(true);
    expect(parseSendWindows({ weekdays: "later", saturday: "25:00-26:00", sunday: "12:00-10:00" })).toEqual(DEFAULT_SEND_WINDOWS);
    expect(parseSendWindows(undefined)).toEqual(DEFAULT_SEND_WINDOWS);
  });

  it("finds when the window opens next, to the minute", () => {
    // Monday 21:00: next opening is Tuesday 08:00.
    expect(nextSendWindow(sa("2026-10-05T21:00:00"), TZ)?.toISOString()).toBe(sa("2026-10-06T08:00:00").toISOString());
    // Friday 20:30: Saturday 09:00.
    expect(nextSendWindow(sa("2026-10-09T20:30:00"), TZ)?.toISOString()).toBe(sa("2026-10-10T09:00:00").toISOString());
    // Saturday 14:00: Sunday is closed, so Monday 08:00.
    expect(nextSendWindow(sa("2026-10-10T14:00:00"), TZ)?.toISOString()).toBe(sa("2026-10-12T08:00:00").toISOString());
    // Already open: now, unchanged.
    const open = sa("2026-10-06T10:15:30");
    expect(nextSendWindow(open, TZ)).toBe(open);
    // Never open: null, not a loop.
    expect(nextSendWindow(open, TZ, { days: [null, null, null, null, null, null, null], blackout: [] })).toBeNull();
  });

  it("says the windows in words", () => {
    expect(describeWindows(DEFAULT_SEND_WINDOWS)).toBe("Mon-Fri 08:00-20:00, Sat 09:00-13:00, Sun closed");
    expect(describeWindows(parseSendWindows({ blackoutDates: "2026-12-25" }))).toBe("Mon-Fri 08:00-20:00, Sat 09:00-13:00, Sun closed; no sending on 2026-12-25");
  });
});
