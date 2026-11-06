import { describe, expect, it } from "vitest";
import { aspectCss, cardStatus, creditsLeft, markRunning } from "../src/ui/card-look.js";

describe("cardStatus (pill on a card)", () => {
  it("shows Generating while a run is on, even over an old file", () => {
    expect(cardStatus("video", { groupId: "g1", assetId: "a1" }, "approved")).toEqual({ label: "Generating", tone: "running" });
  });
  it("shows nothing on an empty card or a plain source", () => {
    expect(cardStatus("image", {}, undefined)).toBeNull();
    expect(cardStatus("source", { assetId: "a1" }, undefined)).toBeNull();
  });
  it("uses the review decision first, then Draft for results and Done for made cards", () => {
    expect(cardStatus("output", { assetId: "a1" }, "approved")?.label).toBe("Approved");
    expect(cardStatus("source", { assetId: "a1" }, "rejected")?.label).toBe("Rejected");
    expect(cardStatus("output", { assetId: "a1" }, "draft")?.label).toBe("Draft");
    expect(cardStatus("image", { assetId: "a1" }, undefined)?.label).toBe("Done");
  });
});

describe("aspectCss", () => {
  it("turns a ratio into CSS and falls back to square", () => {
    expect(aspectCss("16:9")).toBe("16 / 9");
    expect(aspectCss("2.39:1")).toBe("2.39 / 1");
    expect(aspectCss(undefined)).toBe("1 / 1");
    expect(aspectCss("0:9")).toBe("1 / 1");
    expect(aspectCss("auto")).toBe("1 / 1");
  });
});

describe("markRunning", () => {
  it("animates only edges into a generating card", () => {
    const nodes: Array<{ id: string; data: Record<string, string> }> = [{ id: "p", data: {} }, { id: "v", data: { groupId: "g" } }, { id: "i", data: {} }];
    const out = markRunning(nodes, [{ id: "e1", source: "p", target: "v" }, { id: "e2", source: "p", target: "i" }]);
    expect(out[0]).toMatchObject({ animated: true, className: "studio-edge-running" });
    expect(out[1]).toEqual({ id: "e2", source: "p", target: "i" });
  });
});

describe("creditsLeft", () => {
  it("rounds to cents and never goes below zero", () => {
    expect(creditsLeft(49.38, 50)).toBe(0.62);
    expect(creditsLeft(60, 50)).toBe(0);
  });
});
