import { describe, expect, it } from "vitest";
import { computeWinner, computeFatigue, DEFAULT_VARIANT_CONFIG, type AdDailyRow } from "../src/variants.js";

const config = DEFAULT_VARIANT_CONFIG;
const today = "2026-10-18";

const mockAdDaily = (id: string, day: string, impressions: number, clicks: number, conversions: number, frequency: number, spendMinor = 10000): AdDailyRow => ({
  account_id: "acc1",
  campaign_external_id: "camp1",
  ad_external_id: id,
  day,
  spend_minor: spendMinor,
  impressions,
  clicks,
  conversions,
  frequency,
});

describe("variants: winner computation", () => {
  it("marks an ad as winner when it is the only qualifying ad in the campaign", () => {
    const rows = [mockAdDaily("ad1", "2026-10-15", 2000, 40, 15, 0), mockAdDaily("ad1", "2026-10-16", 2000, 40, 15, 0), mockAdDaily("ad1", "2026-10-17", 2000, 40, 15, 0)];
    const all = rows;
    const isWinner = computeWinner(rows, all, config, today);
    expect(isWinner).toBe(true);
  });

  it("rejects winner when below minimum impressions", () => {
    const rows = [mockAdDaily("ad1", "2026-10-17", 500, 10, 15, 0)];
    const all = rows;
    const isWinner = computeWinner(rows, all, config, today);
    expect(isWinner).toBe(false);
  });

  it("rejects winner when below minimum conversions", () => {
    const rows = [mockAdDaily("ad1", "2026-10-17", 2000, 40, 5, 0)];
    const all = rows;
    const isWinner = computeWinner(rows, all, config, today);
    expect(isWinner).toBe(false);
  });

  it("selects the ad with lowest CPA when multiple qualify", () => {
    const rows1 = [mockAdDaily("ad1", "2026-10-17", 1000, 20, 10, 0, 20000)]; // CPA = 2000
    const rows2 = [mockAdDaily("ad2", "2026-10-17", 1000, 20, 10, 0, 15000)]; // CPA = 1500
    const all = [...rows1, ...rows2];
    expect(computeWinner(rows1, all, config, today)).toBe(false);
    expect(computeWinner(rows2, all, config, today)).toBe(true);
  });

  it("returns false when no data in the window", () => {
    const rows = [mockAdDaily("ad1", "2026-09-15", 2000, 40, 15, 0)]; // Outside 14-day window
    const all = rows;
    const isWinner = computeWinner(rows, all, config, today);
    expect(isWinner).toBe(false);
  });
});

describe("variants: fatigue computation", () => {
  it("marks fatigue when CTR drops, threshold exceeded, frequency above threshold", () => {
    const rows = [
      mockAdDaily("ad1", "2026-10-16", 1000, 50, 10, 3.5), // CTR = 0.05
      mockAdDaily("ad1", "2026-10-17", 1000, 40, 10, 3.8), // CTR = 0.04
      mockAdDaily("ad1", "2026-10-18", 1000, 20, 10, 4.2), // CTR = 0.02
    ];
    const isFatigued = computeFatigue(rows, config, today);
    // CTR drop: (0.05 - 0.02) / 0.05 = 60% > 20% threshold
    // Last day frequency 4.2 > 3 threshold
    expect(isFatigued).toBe(true);
  });

  it("rejects fatigue when CTR does not drop each day", () => {
    const rows = [
      mockAdDaily("ad1", "2026-10-16", 1000, 50, 10, 3.5), // CTR = 0.05
      mockAdDaily("ad1", "2026-10-17", 1000, 50, 10, 3.8), // CTR = 0.05 (no drop)
      mockAdDaily("ad1", "2026-10-18", 1000, 20, 10, 4.2), // CTR = 0.02
    ];
    const isFatigued = computeFatigue(rows, config, today);
    expect(isFatigued).toBe(false);
  });

  it("rejects fatigue when overall CTR drop is under threshold", () => {
    const rows = [
      mockAdDaily("ad1", "2026-10-16", 1000, 50, 10, 3.5), // CTR = 0.05
      mockAdDaily("ad1", "2026-10-17", 1000, 48, 10, 3.8), // CTR = 0.048
      mockAdDaily("ad1", "2026-10-18", 1000, 46, 10, 4.2), // CTR = 0.046, drop = 8% < 20%
    ];
    const isFatigued = computeFatigue(rows, config, today);
    expect(isFatigued).toBe(false);
  });

  it("rejects fatigue when frequency is below threshold on last day", () => {
    const rows = [
      mockAdDaily("ad1", "2026-10-16", 1000, 50, 10, 3.5), // CTR = 0.05
      mockAdDaily("ad1", "2026-10-17", 1000, 40, 10, 2.8), // CTR = 0.04
      mockAdDaily("ad1", "2026-10-18", 1000, 20, 10, 2.5), // CTR = 0.02, freq = 2.5 <= 3
    ];
    const isFatigued = computeFatigue(rows, config, today);
    expect(isFatigued).toBe(false);
  });

  it("rejects fatigue when consecutive days are missing", () => {
    const rows = [
      mockAdDaily("ad1", "2026-10-16", 1000, 50, 10, 3.5),
      // Gap: 2026-10-17 missing
      mockAdDaily("ad1", "2026-10-18", 1000, 20, 10, 4.2),
    ];
    const isFatigued = computeFatigue(rows, config, today);
    expect(isFatigued).toBe(false);
  });

  it("returns false when impressions are zero (avoid divide by zero)", () => {
    const rows = [
      mockAdDaily("ad1", "2026-10-16", 1000, 50, 10, 3.5),
      mockAdDaily("ad1", "2026-10-17", 0, 40, 10, 3.8), // Zero impressions
      mockAdDaily("ad1", "2026-10-18", 1000, 20, 10, 4.2),
    ];
    const isFatigued = computeFatigue(rows, config, today);
    expect(isFatigued).toBe(false);
  });

  it("needs exactly 3 consecutive days", () => {
    const rows = [
      mockAdDaily("ad1", "2026-10-18", 1000, 50, 10, 3.5),
    ];
    const isFatigued = computeFatigue(rows, config, today);
    expect(isFatigued).toBe(false);
  });
});
