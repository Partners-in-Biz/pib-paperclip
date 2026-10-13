import { describe, it, expect } from "vitest";
import {
  classifyInboundKeyword,
  isWithinMarketingWindow,
  withOptOutLine,
  STOP_CONFIRMATION,
  HELP_REPLY,
} from "../src/sms/policy.js";

const sastDate = (dateStr: string, timeStr: string): Date => {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - 2, minute, 0));
};

describe("classifyInboundKeyword", () => {
  it.each([
    ["STOP", "stop"], ["Stop", "stop"], ["stop", "stop"],
    ["STOPALL", "stop"], ["UNSUBSCRIBE", "stop"], ["CANCEL", "stop"], ["END", "stop"],
    ["QUIT", "stop"], ["OPT OUT", "stop"], ["OPTOUT", "stop"], ["HOU OP", "stop"], ["HOUOP", "stop"],
    ["STOP.", "stop"], ["Stop!", "stop"], ["quit?", "stop"], ["UNSUBSCRIBE,", "stop"],
    ["  STOP  ", "stop"], ["\tSTOP\n", "stop"],
    ["HELP", "help"], ["Help", "help"], ["HULP", "help"], ["INFO", "help"],
    ["HELP.", "help"], ["info!", "help"], ["  HELP  ", "help"],
    ["please don't stop", null], ["STOP please", null], ["maybe stop", null],
    ["HELP me", null], ["not help", null], ["STOPPED", null], ["HELPING", null],
    ["", null], ["   ", null], ["hello", null], ["12345", null], ["STOOP", null], ["HALP", null],
  ])('classify "%s" -> %s', (input, expected) => {
    expect(classifyInboundKeyword(input)).toBe(expected);
  });
});

describe("isWithinMarketingWindow", () => {
  it.each([
    // Mon-Fri 08:00-20:00
    ["2026-10-12", "00:00", false], ["2026-10-12", "07:59", false], ["2026-10-12", "08:00", true], ["2026-10-12", "08:01", true],
    ["2026-10-12", "19:59", true], ["2026-10-12", "20:00", false],
    ["2026-10-14", "12:00", true], ["2026-10-16", "08:00", true], ["2026-10-16", "19:59", true],
    ["2026-10-16", "20:00", false],
    // Saturday 09:00-13:00
    ["2026-10-17", "08:59", false], ["2026-10-17", "09:00", true], ["2026-10-17", "09:01", true],
    ["2026-10-17", "12:59", true], ["2026-10-17", "13:00", false], ["2026-10-17", "13:01", false],
    // Sunday always false
    ["2026-10-18", "08:00", false], ["2026-10-18", "12:00", false], ["2026-10-18", "19:00", false],
  ])('%s %s -> %s', (dateStr, timeStr, expected) => {
    expect(isWithinMarketingWindow(sastDate(dateStr, timeStr), [])).toBe(expected);
  });

  it.each([
    ["2026-12-25", "12:00", ["2026-12-25"], false], // holiday on Fri
    ["2026-10-12", "12:00", ["2026-12-25"], true], // not in list
    ["2026-10-12", "12:00", ["2026-10-12"], false], // Mon in list
    ["2026-12-25", "10:00", ["2026-10-12", "2026-12-25"], false], // multi-holiday match
  ])('%s %s with holidays %p -> %s', (dateStr, timeStr, holidays, expected) => {
    expect(isWithinMarketingWindow(sastDate(dateStr, timeStr), holidays)).toBe(expected);
  });

  it.each([
    ["2026-10-12T22:30:00Z", false], // 00:30 SAST Tue (before 08:00)
    ["2026-10-12T06:00:00Z", true], // 08:00 SAST Mon (at start)
  ])('UTC instant %s -> %s', (utcStr, expected) => {
    expect(isWithinMarketingWindow(new Date(utcStr), [])).toBe(expected);
  });
});

describe("withOptOutLine", () => {
  it.each([
    ["Your appointment is tomorrow", "marketing", "Your appointment is tomorrow\nReply STOP to opt out"],
    ["Your order. Reply STOP to opt out", "marketing", "Your order. Reply STOP to opt out"],
    ["Your order. REPLY STOP to opt out", "marketing", "Your order. REPLY STOP to opt out"],
    ["Your order. Reply Stop to opt out", "marketing", "Your order. Reply Stop to opt out"],
    ["Send STOP to quit", "marketing", "Send STOP to quit\nReply STOP to opt out"],
    ["Hello\nThis is a test", "marketing", "Hello\nThis is a test\nReply STOP to opt out"],
    ["Your appointment is confirmed", "service", "Your appointment is confirmed"],
    ["Hello", "service", "Hello"],
  ])('withOptOutLine("%s", "%s") -> correct', (input, kind, expected) => {
    expect(withOptOutLine(input, kind as any)).toBe(expected);
  });

  it("idempotent on marketing", () => {
    const input = "Hello";
    const once = withOptOutLine(input, "marketing");
    const twice = withOptOutLine(once, "marketing");
    expect(once).toBe(twice);
  });
});

describe("constants", () => {
  it("STOP_CONFIRMATION and HELP_REPLY are defined", () => {
    expect(STOP_CONFIRMATION).toBe("You have been unsubscribed and will receive no more messages from us. Reply HELP for help.");
    expect(HELP_REPLY).toBe("Reply STOP to unsubscribe. For help contact us on our usual business number.");
  });
});
