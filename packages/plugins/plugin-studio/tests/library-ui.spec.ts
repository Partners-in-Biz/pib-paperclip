import { describe, expect, it } from "vitest";
import { formatDuration, humanTitle, metaLine, posterFrameUrl, relativeAge, statusTone } from "../src/ui/library.js";

const NOW = Date.parse("2026-11-06T12:00:00Z");

describe("library card helpers (PAR-8047)", () => {
  it("titles from the first six words, cut at a word, never mid-word", () => {
    const long = "a tidy desk in a small South African business office, morning light, laptop open, notebook";
    expect(humanTitle(long, "raw-name")).toBe("A tidy desk in a small…");
    expect(humanTitle("Product reveal, 5 s", "x")).toBe("Product reveal, 5 s");
    expect(humanTitle("one two three four five six, seven", "x")).toBe("One two three four five six…");
  });

  it("falls back to the asset name for imports, and never returns an empty title", () => {
    expect(humanTitle(null, "brand-logo.png")).toBe("Brand-logo.png");
    expect(humanTitle("   ", "")).toBe("Untitled");
  });

  it("writes relative ages", () => {
    expect(relativeAge("2026-11-06T10:00:00Z", NOW)).toBe("2 h ago");
    expect(relativeAge("2026-11-05T12:00:00Z", NOW)).toBe("Yesterday");
    expect(relativeAge("2026-11-03T12:00:00Z", NOW)).toBe("3 d ago");
    expect(relativeAge("2026-08-01T12:00:00Z", NOW)).toBe("2026-08-01");
    expect(relativeAge(null, NOW)).toBe("");
  });

  it("meta line is kind, model, cost, age; the phone keeps kind and age", () => {
    const a = { kind: "video", model: "kling-2.5", credits: 0.6, createdAt: "2026-11-04T12:00:00Z" };
    const label = (id: string) => (id === "kling-2.5" ? "Kling 2.5" : id);
    expect(metaLine(a, label, false, NOW)).toBe("Video · Kling 2.5 · 0.6 cr · 2 d ago");
    expect(metaLine(a, label, true, NOW)).toBe("Video · 2 d ago");
    expect(metaLine({ kind: "image", createdAt: null }, label, false, NOW)).toBe("Image");
  });

  it("maps status to the spec tones: draft amber, approved green, rejected red", () => {
    expect(statusTone("draft")).toBe("warn");
    expect(statusTone("approved")).toBe("ok");
    expect(statusTone("rejected")).toBe("bad");
    expect(statusTone("archived")).toBe("neutral");
  });

  it("formats durations and asks for the first frame as the poster", () => {
    expect(formatDuration(5.04)).toBe("0:05");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(Number.NaN)).toBe("");
    expect(posterFrameUrl("https://x/a.mp4?sig=1")).toBe("https://x/a.mp4?sig=1#t=0.1");
  });
});
