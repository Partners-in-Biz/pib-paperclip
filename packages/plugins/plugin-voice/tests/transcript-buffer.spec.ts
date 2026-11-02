// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { bufferKey, pruneBuffers, readBuffer, writeBuffer } from "../src/ui/transcript-buffer.js";

describe("transcript buffer", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a call under the document key", () => {
    const startedAt = Date.UTC(2026, 9, 30, 8, 0, 0);
    expect(writeBuffer(startedAt, [{ who: "you", text: "hi", at: 1 }])).toBe(true);
    expect(bufferKey(startedAt)).toContain("live-chat-transcript-");
    expect(readBuffer(startedAt)?.entries[0]?.text).toBe("hi");
  });

  it("keeps only the latest 100 entries", () => {
    const entries = Array.from({ length: 130 }, (_, i) => ({ who: "you" as const, text: `m${i}`, at: i }));
    writeBuffer(1, entries);
    const stored = readBuffer(1)!;
    expect(stored.entries).toHaveLength(100);
    expect(stored.entries[0]?.text).toBe("m30");
  });

  it("prunes buffers older than a week and keeps recent ones", () => {
    const now = Date.now();
    writeBuffer(1, [{ who: "you", text: "old", at: 1 }]);
    const oldKey = bufferKey(1);
    localStorage.setItem(oldKey, JSON.stringify({ startedAt: 1, updatedAt: now - 8 * 24 * 3600 * 1000, entries: [] }));
    writeBuffer(now, [{ who: "you", text: "new", at: 2 }]);
    pruneBuffers(now);
    expect(localStorage.getItem(oldKey)).toBeNull();
    expect(readBuffer(now)).not.toBeNull();
  });
});
