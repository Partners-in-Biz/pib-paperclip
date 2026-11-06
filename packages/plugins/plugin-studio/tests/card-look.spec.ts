import { describe, expect, it } from "vitest";
import { aspectCss, cardStatus, creditsLeft, markRunning, pickerRows } from "../src/ui/card-look.js";

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

describe("pickerRows (grouped model picker)", () => {
  const models = [
    { id: "soul", ratios: ["1:1", "16:9", "9:16", "4:3", "3:4"], resolutions: ["1k", "2k"], maxRefs: 0 },
    { id: "kling", ratios: ["16:9"], resolutions: ["720p", "1080p"], maxRefs: 1 },
  ];
  it("keeps disabled models out of the main list and collects them with their reason", () => {
    const unavailable = Array.from({ length: 14 }, (_, i) => ({ id: `na-${i}`, label: `M${i}`, disabled: "Not on the Higgsfield REST API" }));
    const out = pickerRows([{ id: "soul", label: "Soul", disabled: null }, { id: "kling", label: "Kling", disabled: "takes at most 1 reference image" }, ...unavailable], models);
    expect(out.rows.map((r) => r.id)).toEqual(["soul"]);
    expect(out.unavailable).toHaveLength(15);
    expect(out.unavailable[0]).toEqual({ id: "kling", label: "Kling", reason: "takes at most 1 reference image" });
  });
  it("summarises shape, references and the top resolution", () => {
    const out = pickerRows([{ id: "soul", label: "Soul", disabled: null }, { id: "kling", label: "Kling", disabled: null }], models);
    expect(out.rows[0]).toEqual({ id: "soul", label: "Soul", detail: "5 aspect ratios · prompt only", maxRes: "2k" });
    expect(out.rows[1]).toEqual({ id: "kling", label: "Kling", detail: "16:9 · up to 1 reference", maxRes: "1080p" });
  });
});
