import { describe, expect, it } from "vitest";
import { snapshotPlaceholder } from "../src/ui/placeholder.js";

describe("campaigns page when the load is refused", () => {
  it("shows the read-only message and no Loading", () => {
    const text = snapshotPlaceholder("Viewer access is read-only");
    expect(text).toBe("Viewer access is read-only");
    expect(text).not.toMatch(/Loading/);
  });
  it("still says Loading while the load is pending", () => {
    expect(snapshotPlaceholder("")).toBe("Loading campaigns…");
  });
});
