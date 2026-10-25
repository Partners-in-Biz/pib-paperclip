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

describe("campaigns detail, A/B and header placeholders", () => {
  const refused = "Viewer access is read-only";
  it("show the error in every view that waits for data", () => {
    for (const loading of ["Loading the campaign…", "Loading…", "Loading campaigns…"]) {
      expect(snapshotPlaceholder(refused, loading)).toBe(refused);
      expect(snapshotPlaceholder("", loading)).toBe(loading);
    }
  });
});
