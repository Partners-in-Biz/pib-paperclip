import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sharePath } from "../src/canvas-share.js";
import { shareUrl } from "../src/ui/share-url.js";

describe("Copy link", () => {
  it("builds the share page's full address from the plugin's served folder", () => {
    expect(shareUrl(sharePath("abc"), "/_plugins/75935dd8-f5ea-4922-82df-7c3a780ae993/ui/", "https://paperclip.example.com")).toBe(
      `https://paperclip.example.com/_plugins/75935dd8-f5ea-4922-82df-7c3a780ae993/ui/${sharePath("abc")}`,
    );
  });
  it("never resolves against import.meta.url, which is a blob: address on the host", () => {
    expect(() => new URL(sharePath("abc"), "blob:https://paperclip.example.com/uuid")).toThrow();
    const source = readFileSync(new URL("../src/ui/ShareMenu.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/new URL\([^)]*import\.meta\.url/);
    expect(source).not.toMatch(/=\s*import\.meta\.url/);
  });
});
