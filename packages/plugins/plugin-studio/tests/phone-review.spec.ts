import { describe, expect, it } from "vitest";
import { awaitingLine, clipPrompt, nextAfterReview, reviewPill, reviewQueue, type ReviewAsset, type ReviewCard } from "../src/ui/phone-review.js";

const card = (id: string, type: string, x: number, y: number, data: Record<string, string> = {}): ReviewCard => ({ id, type, position: { x, y }, data });
const asset = (id: string, status: string, extra: Partial<ReviewAsset> = {}): ReviewAsset => ({ id, name: `${id}.png`, kind: "image", status, ...extra });

describe("phone board review strip (PAR-8094)", () => {
  it("puts drafts first, then keeps board reading order (top to bottom, left to right)", () => {
    const cards = [
      card("c-approved-top", "output", 400, 0, { assetId: "a1" }),
      card("c-draft-low", "image", 0, 500, { assetId: "a2" }),
      card("c-draft-top-right", "output", 800, 0, { assetId: "a3" }),
      card("c-rejected", "video", 0, 200, { assetId: "a4" }),
      card("c-draft-top-left", "image", 0, 0, { assetId: "a5" }),
    ];
    const assets = [asset("a1", "approved"), asset("a2", "draft"), asset("a3", "draft"), asset("a4", "rejected", { kind: "video" }), asset("a5", "draft")];
    expect(reviewQueue(cards, assets).map((i) => i.assetId)).toEqual(["a5", "a3", "a2", "a1", "a4"]);
  });

  it("lists a file once when an image card and its output card share it, and skips prompts, sources and empty cards", () => {
    const cards = [
      card("img", "image", 0, 0, { assetId: "a1" }),
      card("out", "output", 400, 0, { assetId: "a1" }),
      card("src", "source", 0, 300, { assetId: "lib" }),
      card("prompt", "prompt", 0, 600, { text: "hello" }),
      card("empty", "video", 400, 300),
    ];
    const items = reviewQueue(cards, [asset("a1", "draft"), asset("lib", "draft")]);
    expect(items.map((i) => [i.assetId, i.cardId])).toEqual([["a1", "img"]]);
  });

  it("takes title, prompt, model and cost from the asset, else the card's wired prompt", () => {
    const items = reviewQueue(
      [card("v", "video", 0, 0, { assetId: "a1" }), card("i", "image", 0, 100, { assetId: "a2" })],
      [asset("a1", "draft", { kind: "video", prompt: "Product reveal, 5 s", model: "kling-2.5", credits: 0.6 }), asset("a2", "approved")],
      (id) => (id === "i" ? "a tidy desk in a small South African business office" : ""),
    );
    expect(items[0]).toMatchObject({ kind: "video", title: "Product reveal, 5 s", model: "kling-2.5", credits: 0.6, status: "draft" });
    expect(items[1]).toMatchObject({ kind: "image", title: "A tidy desk in a small…", model: null, credits: null });
  });

  it("keeps an audio asset as kind audio in the review queue", () => {
    const items = reviewQueue([card("c1", "output", 0, 0, { assetId: "a1" })], [asset("a1", "draft", { kind: "audio", name: "voice.mp3" })]);
    expect(items.map((i) => i.kind)).toEqual(["audio"]);
  });

  it("counts drafts against all results", () => {
    const items = reviewQueue(
      ["a", "b", "c", "d"].map((id, n) => card(id, "output", n * 300, 0, { assetId: id })),
      [asset("a", "approved"), asset("b", "draft"), asset("c", "rejected"), asset("d", "approved")],
    );
    expect(awaitingLine(items)).toBe("1 of 4 outputs awaiting review");
    expect(awaitingLine([])).toBe("No results on this board yet.");
    expect(awaitingLine([{ status: "draft" }])).toBe("1 of 1 output awaiting review");
  });

  it("moves to the next draft after a decision, wrapping round, and stays when none is left", () => {
    const items = [{ assetId: "a", status: "draft" }, { assetId: "b", status: "approved" }, { assetId: "c", status: "draft" }];
    expect(nextAfterReview(items, "a")).toBe("c");
    expect(nextAfterReview(items, "c")).toBe("a");
    expect(nextAfterReview([{ assetId: "a", status: "approved" }], "a")).toBe("a");
  });

  it("labels the pill and collapses long prompts at a word", () => {
    expect(reviewPill("draft")).toBe("Draft · needs review");
    expect(reviewPill("approved")).toBe("Approved");
    const long = clipPrompt("A tidy desk in a small South African business office, morning light, laptop open, notebook beside it");
    expect(long.clipped).toBe(true);
    expect(long.text).toBe("A tidy desk in a small South African business office, morning light, laptop…");
    expect(clipPrompt("Short prompt")).toEqual({ text: "Short prompt", clipped: false });
  });
});
