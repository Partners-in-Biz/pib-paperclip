/**
 * Unit tests for sent-copy.ts: PDF naming and fire-and-forget save logic.
 */
import { describe, expect, it } from "vitest";
import { sentCopyName } from "../src/sent-copy.js";

describe("sentCopyName", () => {
  it("formats invoice name with date, kind, number, and padded seq", () => {
    const date = new Date("2026-10-20T14:30:00Z");
    const name = sentCopyName("invoice", "INV-0042", date, 1);
    expect(name).toBe("2026-10-20 Invoice INV-0042 v01.pdf");
  });

  it("formats quote name with date, kind, number, and padded seq", () => {
    const date = new Date("2026-10-20T14:30:00Z");
    const name = sentCopyName("quote", "Q-LUM-007", date, 3);
    expect(name).toBe("2026-10-20 Quote Q-LUM-007 v03.pdf");
  });

  it("sanitizes number: removes non-alphanumeric and dash characters", () => {
    const date = new Date("2026-10-20");
    const name = sentCopyName("invoice", "INV/0042 x", date, 1);
    expect(name).toBe("2026-10-20 Invoice INV0042x v01.pdf");
  });

  it("pads seq to 2 digits", () => {
    const date = new Date("2026-10-20");
    expect(sentCopyName("invoice", "INV-0001", date, 1)).toContain(" v01.pdf");
    expect(sentCopyName("invoice", "INV-0001", date, 10)).toContain(" v10.pdf");
    expect(sentCopyName("invoice", "INV-0001", date, 99)).toContain(" v99.pdf");
  });

  it("matches the required regex pattern", () => {
    const date = new Date("2026-10-20");
    const name = sentCopyName("invoice", "INV-0042", date, 1);
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}\s+.+\s+v\d+\.\w+$/);
  });

  it("handles empty number by keeping the sanitized result", () => {
    const date = new Date("2026-10-20");
    const name = sentCopyName("invoice", "", date, 5);
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}\s+Invoice\s+v05\.pdf$/);
  });
});
