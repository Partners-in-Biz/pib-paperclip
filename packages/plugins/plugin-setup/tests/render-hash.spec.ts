import { describe, expect, it } from "vitest";
import { renderHash } from "../src/render-hash.js";

describe("renderHash", () => {
  it("returns the first 16 chars of sha256 hex hash", () => {
    const hash = renderHash("fixture");
    expect(hash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
  });

  it("is stable across multiple calls", () => {
    const text = "test content for hashing";
    const hash1 = renderHash(text);
    const hash2 = renderHash(text);
    expect(hash1).toBe(hash2);
  });

  it("differs after a single character change", () => {
    const hash1 = renderHash("hello world");
    const hash2 = renderHash("hello World");
    expect(hash1).not.toBe(hash2);
  });

  it("computes the expected hash for 'fixture'", () => {
    // sha256("fixture") hex = f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d
    // First 16 chars = "f16d05ec6b29248d"
    const expected = "f16d05ec6b29248d";
    expect(renderHash("fixture")).toBe(expected);
  });
});
