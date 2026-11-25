import { describe, expect, it } from "vitest";
import { requestedPauseReason } from "../services/requested-pause-reason.js";

describe("requestedPauseReason", () => {
  it("accepts maintenance", () => expect(requestedPauseReason({ reason: "maintenance" })).toBe("maintenance"));
  it("falls back to the default for unknown reasons", () => {
    for (const reason of ["budget", "setup", "MAINTENANCE", 1, null, {}]) expect(requestedPauseReason({ reason })).toBeUndefined();
  });
  it("falls back for a missing or non-object body", () => {
    for (const body of [undefined, null, {}, "maintenance"]) expect(requestedPauseReason(body)).toBeUndefined();
  });
});
