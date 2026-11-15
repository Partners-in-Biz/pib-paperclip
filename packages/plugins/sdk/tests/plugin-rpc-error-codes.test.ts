import { describe, expect, it } from "vitest";

import { PLUGIN_RPC_ERROR_CODES } from "../src/protocol.js";

// PAR-11278: a plugin's rate-limit refusal has its own code (the webhook route answers 429).
// Deliberately not a snapshot of the whole object: adding a code must not break this test.
describe("PLUGIN_RPC_ERROR_CODES.RATE_LIMITED", () => {
  it("exists in the JSON-RPC server error range and no other code shares its value", () => {
    expect(PLUGIN_RPC_ERROR_CODES.RATE_LIMITED).toBe(-32007);
    const values: number[] = Object.values(PLUGIN_RPC_ERROR_CODES);
    expect(values.filter((code) => code === PLUGIN_RPC_ERROR_CODES.RATE_LIMITED)).toHaveLength(1);
    expect(new Set(values).size).toBe(values.length);
  });
});
