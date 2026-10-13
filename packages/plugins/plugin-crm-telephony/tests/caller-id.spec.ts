import { describe, it, expect } from "vitest";
import { pickCallerId } from "../src/caller-id.js";

describe("pickCallerId", () => {
  it.each([
    ["+27821234567", { za: "+27821234567", us: "+15125551234" }, true, "ZA"],
    ["+15125551234", { za: "+27821234567", us: "+15125551234" }, true, "US"],
    ["+442079460958", { za: "+27821234567", us: "+15125551234" }, false, "unsupported_region"],
    ["+27821234567", { us: "+15125551234" }, false, "caller_id_not_configured"],
  ])("destination %s", (dest, config, expectOk, expectResult) => {
    const result = pickCallerId(dest, config);
    expect(result.ok).toBe(expectOk);
    if (expectOk && result.ok) expect(result.region).toBe(expectResult);
    else if (!result.ok) expect(result.reason).toBe(expectResult);
  });
});
