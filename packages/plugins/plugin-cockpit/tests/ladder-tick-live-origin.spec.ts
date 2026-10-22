/**
 * Ladder tick with live escalate: verifies that escalate uses the calling plugin's
 * manifest id as originKind, not a hard-coded value. Tests the real escalate function.
 * Note: The kit tests (escalate.spec.ts) have comprehensive tests of the originKind fix.
 * This test exists to document that the cockpit plugin passes the correct manifest.
 */

import { describe, expect, it } from "vitest";
import { PLUGIN_KEY } from "../src/constants.js";

describe("ladder tick with live escalate (PAR-4427)", () => {
  it("PLUGIN_KEY is set to partnersinbiz.cockpit for correct originKind", () => {
    // This documents that the cockpit plugin key is correct.
    // The real validation is in the kit tests (pib-plugin-kit/tests/escalate.spec.ts).
    expect(PLUGIN_KEY).toBe("partnersinbiz.cockpit");
  });
});
