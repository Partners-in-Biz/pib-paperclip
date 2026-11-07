import { describe, expect, it, vi } from "vitest";
import { NO_FOLDER, blockedReason, createThumbQueue, folderLabel, folderTabs, visibleFiles, type DriveFile } from "../src/ui/drive-picker.js";

const f = (id: string, folder: string | null, name = `${id}.png`, extra: Partial<DriveFile> = {}): DriveFile => ({
  id,
  name,
  mimeType: "image/png",
  size: 1000,
  folder,
  modifiedTime: null,
  tooLarge: false,
  assetId: null,
  ...extra,
});

describe("From Drive picker logic", () => {
  it("groups by folder with counts, and searches by name inside a folder", () => {
    const files = [f("a", "Assets/Images", "Hero shot.png"), f("b", "Assets/Video", "intro.mp4"), f("c", "Assets/Images", "logo.png"), f("d", null)];
    expect(folderTabs(files)).toEqual([
      ["", "All", 4],
      ["Assets/Images", "Images", 2],
      [NO_FOLDER, "Other", 1],
      ["Assets/Video", "Video", 1],
    ]);
    expect(visibleFiles(files, NO_FOLDER, "").map((x) => x.id)).toEqual(["d"]);
    expect(visibleFiles(files, "Assets/Images", "").map((x) => x.id)).toEqual(["a", "c"]);
    expect(visibleFiles(files, "", "HERO").map((x) => x.id)).toEqual(["a"]);
    expect(folderLabel("Marketing assets/Social/Reels")).toBe("Social / Reels");
  });

  it("says why a too-large file can't be ticked", () => {
    expect(blockedReason(f("a", null, "big.mp4", { size: 7.2 * 1024 * 1024, tooLarge: true }), 5 * 1024 * 1024)).toBe("Too large: 7.2 MB. Studio takes Drive files up to 5.0 MB.");
    expect(blockedReason(f("b", null), 5 * 1024 * 1024)).toBeNull();
  });

  it("asks for previews in batches as cards come into view, each file once, two batches at a time", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const results: Record<string, unknown> = {};
    const fetch = vi.fn(async (ids: string[]) => {
      calls.push(ids);
      return ids.filter((id) => id !== "f3").map((id) => ({ id, url: `data:image/jpeg;base64,${id}` }));
    });
    const q = createThumbQueue(fetch, (r) => Object.assign(results, r), {
      batch: 2,
      parallel: 2,
      delayMs: 10,
    });
    for (const id of ["f1", "f2", "f3", "f4", "f5", "f1", "f2"]) q.want(id);
    await vi.advanceTimersByTimeAsync(20);
    await vi.runAllTimersAsync();
    expect(calls).toEqual([["f1", "f2"], ["f3", "f4"], ["f5"]]);
    expect(results).toMatchObject({
      f1: { url: "data:image/jpeg;base64,f1" },
      f3: { reason: "no_reply" },
      f5: { url: "data:image/jpeg;base64,f5" },
    });
    q.stop();
    q.want("f6");
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(3);
    vi.useRealTimers();
  });

  it("marks a failed batch per file instead of retrying forever", async () => {
    const results: Record<string, unknown> = {};
    const q = createThumbQueue(
      async () => Promise.reject(new Error("CRM down")),
      (r) => Object.assign(results, r),
      { delayMs: 0 },
    );
    q.want("x1");
    q.want("x2");
    await new Promise((r) => setTimeout(r, 5));
    expect(results).toEqual({
      x1: { reason: "failed" },
      x2: { reason: "failed" },
    });
  });

  it("handles 200 files without asking for any preview it wasn't shown", () => {
    const files = Array.from({ length: 200 }, (_, i) => f(`id${i}`, i % 2 ? "Assets/Images" : "Assets/Video"));
    expect(folderTabs(files)[0]).toEqual(["", "All", 200]);
    expect(visibleFiles(files, "Assets/Images", "id19").map((x) => x.id)).toEqual(["id19", "id191", "id193", "id195", "id197", "id199"]);
  });
});
