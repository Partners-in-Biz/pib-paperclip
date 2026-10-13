import { describe, it, expect } from "vitest";
import { pickCallerId } from "../src/caller-id.js";

describe("pickCallerId", () => {
  it("picks ZA number for ZA destination", () => {
    const result = pickCallerId("+27821234567", { za: "+27821234567", us: "+15125551234" });
    expect(result).toEqual({ ok: true, callerId: "+27821234567", region: "ZA" });
  });

  it("picks US number for US destination", () => {
    const result = pickCallerId("+15125551234", { za: "+27821234567", us: "+15125551234" });
    expect(result).toEqual({ ok: true, callerId: "+15125551234", region: "US" });
  });

  it("refuses unsupported region", () => {
    const result = pickCallerId("+442079460958", { za: "+27821234567", us: "+15125551234" });
    expect(result).toEqual({ ok: false, reason: "unsupported_region" });
  });

  it("refuses ZA destination when ZA number missing", () => {
    const result = pickCallerId("+27821234567", { us: "+15125551234" });
    expect(result).toEqual({ ok: false, reason: "caller_id_not_configured" });
  });

  it("refuses ZA destination when ZA number is empty", () => {
    const result = pickCallerId("+27821234567", { za: "", us: "+15125551234" });
    expect(result).toEqual({ ok: false, reason: "caller_id_not_configured" });
  });

  it("refuses US destination when US number missing", () => {
    const result = pickCallerId("+15125551234", { za: "+27821234567" });
    expect(result).toEqual({ ok: false, reason: "caller_id_not_configured" });
  });

  it("refuses US destination when US number is empty", () => {
    const result = pickCallerId("+15125551234", { za: "+27821234567", us: "" });
    expect(result).toEqual({ ok: false, reason: "caller_id_not_configured" });
  });

  it("never falls back to other country's number", () => {
    const result = pickCallerId("+27821234567", { us: "+15125551234" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("caller_id_not_configured");
    }
  });
});
