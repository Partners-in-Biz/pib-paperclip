import { describe, expect, it } from "vitest";
import { CARD_SIZE, freeSpot, placeCard, visibleArea } from "../src/ui/board.js";

describe("placeCard (full view)", () => {
  it("finds a free spot just outside a full view and says it is out of view", () => {
    const area = { x: 0, y: 0, width: 600, height: 400 };
    const nodes = [{ position: { x: 0, y: 0 }, measured: { width: 600, height: 400 } }];
    const placed = placeCard(nodes, area)!;
    expect(placed.inView).toBe(false);
    const s = placed.spot;
    const clear = s.x + CARD_SIZE.width <= 0 || s.x >= 600 || s.y + CARD_SIZE.height <= 0 || s.y >= 400;
    expect(clear).toBe(true);
  });
  it("stays in view when there is room", () => {
    expect(placeCard([], { x: 0, y: 0, width: 1000, height: 800 })?.inView).toBe(true);
  });
});

const board = { x: 0, y: 0, width: 1440, height: 900 };

describe("visibleArea (board minus the side panel)", () => {
  it("is the whole board with no panel", () => {
    expect(visibleArea(board, null)).toEqual(board);
  });
  it("trims the width for a right-hand panel", () => {
    expect(visibleArea(board, { x: 1040, y: 0, width: 400, height: 900 })).toEqual({ x: 0, y: 0, width: 1040, height: 900 });
  });
  it("trims the height for a phone bottom sheet", () => {
    const phone = { x: 0, y: 0, width: 390, height: 800 };
    expect(visibleArea(phone, { x: 0, y: 400, width: 390, height: 400 })).toEqual({ x: 0, y: 0, width: 390, height: 400 });
  });
  it("keeps the board when the panel sits beside it", () => {
    expect(visibleArea({ x: 0, y: 0, width: 1000, height: 900 }, { x: 1000, y: 0, width: 400, height: 900 })).toEqual({ x: 0, y: 0, width: 1000, height: 900 });
  });
});

describe("freeSpot (where a new card lands)", () => {
  const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    a.x < b.x + CARD_SIZE.width && b.x < a.x + CARD_SIZE.width && a.y < b.y + CARD_SIZE.height && b.y < a.y + CARD_SIZE.height;

  it("lands in the centre of an empty area", () => {
    const spot = freeSpot([], { x: 0, y: 0, width: 1000, height: 800 });
    expect(spot).not.toBeNull();
    expect(Math.abs(spot!.x - (500 - CARD_SIZE.width / 2))).toBeLessThanOrEqual(24);
    expect(Math.abs(spot!.y - (400 - CARD_SIZE.height / 2))).toBeLessThanOrEqual(24);
  });

  it("never overlaps an existing card and stays inside the area", () => {
    const area = { x: 0, y: 0, width: 1000, height: 800 };
    const nodes = [{ position: { x: 372, y: 230 } }, { position: { x: 0, y: 0 } }];
    const spot = freeSpot(nodes, area)!;
    for (const n of nodes) expect(overlaps(spot, n.position)).toBe(false);
    expect(spot.x).toBeGreaterThanOrEqual(area.x);
    expect(spot.x + CARD_SIZE.width).toBeLessThanOrEqual(area.x + area.width);
    expect(spot.y + CARD_SIZE.height).toBeLessThanOrEqual(area.y + area.height);
  });

  it("moves a result that would land off-screen (under the panel) into the visible area, near its spot", () => {
    const area = { x: 0, y: 0, width: 1040, height: 900 };
    const spot = freeSpot([{ position: { x: 400, y: 200 } }], area, { x: 1200, y: 200 })!;
    expect(spot.x + CARD_SIZE.width).toBeLessThanOrEqual(1040);
    expect(spot.x).toBeGreaterThan(400);
  });

  it("uses measured sizes and returns null when the area is full", () => {
    const area = { x: 0, y: 0, width: 600, height: 400 };
    expect(freeSpot([{ position: { x: 0, y: 0 }, measured: { width: 600, height: 400 } }], area)).toBeNull();
    expect(freeSpot([], { x: 0, y: 0, width: 100, height: 100 })).toBeNull();
  });
});
