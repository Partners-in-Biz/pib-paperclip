import { describe, expect, it, vi } from "vitest";
import { callingCodeCandidates, leadCallingCode, normalizeRegion, pickNumber, seedNumbersFromSecrets, validateNumbers, type TelephonyNumber } from "../src/numbers.js";
import { pickCallerNumber } from "../src/caller-id.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const ZA: TelephonyNumber = { e164: "+27105550100", label: "PiB Cape Town", regions: ["27"], purposes: ["voice", "sms"], enabled: true, isDefault: true };
const US: TelephonyNumber = { e164: "+12025550100", label: "US sales", regions: ["1"], purposes: ["voice"], enabled: true, isDefault: false };
const WA: TelephonyNumber = { e164: "+27605550100", label: "WhatsApp", regions: [], purposes: ["whatsapp"], enabled: true, isDefault: false };

describe("regions", () => {
  it("normalises calling codes and a few ISO codes", () => {
    expect(normalizeRegion("+27")).toBe("27");
    expect(normalizeRegion(" za ")).toBe("27");
    expect(normalizeRegion("US")).toBe("1");
    expect(normalizeRegion("44")).toBe("44");
    expect(normalizeRegion("XX")).toBeNull();
    expect(normalizeRegion("0")).toBeNull();
    expect(normalizeRegion(27)).toBeNull();
  });

  it("lists a destination's calling-code candidates longest first and names the lead's code", () => {
    expect(callingCodeCandidates("+27821234567")).toEqual(["2782", "278", "27", "2"]);
    expect(leadCallingCode("+27821234567", [ZA, US])).toBe("27");
    expect(leadCallingCode("+12125552000", [ZA, US])).toBe("1");
    expect(leadCallingCode("+447700900123", [ZA, US])).toBe("44");
    expect(leadCallingCode("+12125552000", [])).toBe("1");
  });
});

describe("pickNumber", () => {
  it("matches the lead's region first, then the default", () => {
    expect(pickNumber("+27821234567", [ZA, US], "voice")).toMatchObject({ ok: true, number: ZA, matchedBy: "region" });
    expect(pickNumber("+12125552000", [ZA, US], "voice")).toMatchObject({ ok: true, number: US, matchedBy: "region" });
    expect(pickNumber("+447700900123", [ZA, US], "voice")).toMatchObject({ ok: true, number: ZA, matchedBy: "default" });
  });

  it("honours purpose, enabled and a single-number list", () => {
    expect(pickNumber("+27821234567", [ZA, US, WA], "whatsapp")).toMatchObject({ ok: true, number: WA, matchedBy: "default" });
    expect(pickNumber("+27821234567", [{ ...ZA, enabled: false }, US], "voice")).toMatchObject({ ok: true, number: US, matchedBy: "default" });
    expect(pickNumber("+27821234567", [{ ...US, isDefault: false }], "voice")).toMatchObject({ ok: true, number: US, matchedBy: "default" });
    expect(pickNumber("+27821234567", [{ ...US, isDefault: false }, { ...WA, purposes: ["voice"], regions: ["44"] }], "voice")).toEqual({ ok: false, reason: "no_match" });
    expect(pickNumber("+27821234567", [], "voice")).toEqual({ ok: false, reason: "no_numbers" });
    expect(pickNumber("+27821234567", [ZA], "whatsapp")).toEqual({ ok: false, reason: "no_numbers" });
  });

  it("pickCallerNumber explains the refusal and names the settings page", () => {
    const none = pickCallerNumber("+27821234567", [], "voice");
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.message).toBe("No Voice number is set up. Add one under Numbers in Telephony settings.");
    const miss = pickCallerNumber("+27821234567", [{ ...US, isDefault: false }], "whatsapp");
    if (!miss.ok) expect(miss.reason).toBe("no_numbers");
    const noMatch = pickCallerNumber("+27821234567", [{ ...US, isDefault: false }], "voice");
    if (!noMatch.ok) expect(noMatch.message).toMatch(/No enabled Voice number serves \+27 and none is the default/);
    const hit = pickCallerNumber("+12125552000", [ZA, US]);
    expect(hit).toMatchObject({ ok: true, callerId: "+12025550100", callingCode: "1", matchedBy: "region" });
  });
});

describe("validateNumbers", () => {
  it("accepts a clean list and keeps exactly one default", () => {
    const r = validateNumbers([ZA, { ...US, isDefault: true }]);
    expect(r.errors).toEqual([]);
    expect(r.numbers.map((n) => n.isDefault)).toEqual([true, false]);
    const noDefault = validateNumbers([{ ...ZA, isDefault: false }, US]);
    expect(noDefault.numbers.map((n) => n.isDefault)).toEqual([true, false]);
    const defaultDisabled = validateNumbers([{ ...ZA, enabled: false }, US]);
    expect(defaultDisabled.numbers.map((n) => n.isDefault)).toEqual([false, true]);
  });

  it("cleans numbers, regions and labels, and reports bad rows by position", () => {
    const r = validateNumbers([
      { e164: "+27 10 555 0100", label: "  Cape Town  ", regions: "27, ZA, +27", purposes: ["voice", "nope"], enabled: true },
      { e164: "0105550100", label: "bad", regions: [], purposes: ["voice"] },
      { e164: "+27105550100", label: "dup", regions: [], purposes: ["voice"] },
      { e164: "+12025550100", label: "", regions: ["XX"], purposes: ["voice"] },
      { e164: "+12025550101", label: "no purpose", regions: [], purposes: [] },
    ]);
    expect(r.numbers).toEqual([{ e164: "+27105550100", label: "Cape Town", regions: ["27"], purposes: ["voice"], enabled: true, isDefault: true }]);
    expect(r.errors).toEqual([
      "Number 2: not an E.164 number (like +27105550100)",
      "Number 3: +27105550100 is listed twice",
      "Number 4: unknown region XX (use a calling code like 27 or 1)",
      "Number 5: tick at least one of voice, SMS, WhatsApp",
    ]);
    expect(validateNumbers(undefined)).toEqual({ numbers: [], errors: [] });
    expect(validateNumbers("x").errors).toEqual(["numbers must be a list"]);
    expect(validateNumbers([{ e164: "+12025550100", regions: [], purposes: ["sms"] }]).numbers[0].label).toBe("+12025550100");
  });
});

describe("seedNumbersFromSecrets", () => {
  function ctxWith(values: Record<string, string>): PluginContext {
    return {
      config: { get: vi.fn(async () => ({})) },
      secrets: { resolve: vi.fn(async (name: string) => { if (values[name]) return values[name]; throw new Error("not set"); }) },
    } as unknown as PluginContext;
  }

  it("turns the old secrets into a list with the ZA number as default", async () => {
    const list = await seedNumbersFromSecrets(ctxWith({ TWILIO_ZA_NUMBER: "+27105550100", TWILIO_US_NUMBER: "+12025550100", TWILIO_WHATSAPP_FROM: "whatsapp:+27605550100" }), "c1");
    expect(list).toEqual([
      { e164: "+27105550100", label: "South Africa (from secret TWILIO_ZA_NUMBER)", regions: ["27"], purposes: ["voice", "sms"], enabled: true, isDefault: true },
      { e164: "+12025550100", label: "United States (from secret TWILIO_US_NUMBER)", regions: ["1"], purposes: ["voice", "sms"], enabled: true, isDefault: false },
      { e164: "+27605550100", label: "WhatsApp sender (from secret TWILIO_WHATSAPP_FROM)", regions: [], purposes: ["whatsapp"], enabled: true, isDefault: false },
    ]);
  });

  it("merges purposes when the WhatsApp sender is the same number, skips junk, and is empty with no secrets", async () => {
    const list = await seedNumbersFromSecrets(ctxWith({ TWILIO_ZA_NUMBER: "+27105550100", TWILIO_WHATSAPP_FROM: "whatsapp:+27105550100", TWILIO_US_NUMBER: "not a number" }), "c1");
    expect(list).toHaveLength(1);
    expect(list[0].purposes).toEqual(["voice", "sms", "whatsapp"]);
    expect(await seedNumbersFromSecrets(ctxWith({}), "c1")).toEqual([]);
  });
});
