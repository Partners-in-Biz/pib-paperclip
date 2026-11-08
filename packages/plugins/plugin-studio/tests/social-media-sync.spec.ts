import { describe, expect, it } from "vitest";
import { parseMediaAdded, socialSourceRef } from "../src/social-media-sync.js";
import { folderPath } from "../src/ui/drive-picker.js";

describe("social media sync", () => {
  it("reads a media.added payload", () => {
    expect(parseMediaAdded({ mediaId: "m1", url: "https://cdn.example/x.mp4", name: " Clip ", client: { kind: "company", id: "c1" } })).toEqual({
      mediaId: "m1", url: "https://cdn.example/x.mp4", name: "Clip", altText: null, client: { kind: "company", id: "c1" },
    });
    expect(parseMediaAdded({ mediaId: "m1", url: "http://insecure/x.mp4" })).toBeNull();
    expect(parseMediaAdded(null)).toBeNull();
  });
  it("keys the copy on the scope and media id", () => {
    expect(socialSourceRef(null, "m1")).toBe("social:own:m1");
    expect(socialSourceRef({ kind: "company", id: "c1" }, "m1")).toBe("social:company:c1:m1");
  });
  it("shows the whole Drive folder path", () => {
    expect(folderPath("Assets/Marketing")).toBe("Assets / Marketing");
    expect(folderPath(null)).toBe("No folder");
  });
});
