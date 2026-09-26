import { afterEach, describe, expect, it, vi } from "vitest";
import { assertUploadable, mediaKey, presignUpload } from "../src/media.js";
import { assertPublicUrl, isPrivateAddress, setHostResolver } from "../src/oauth/http.js";
import { fakeCtx } from "./helpers.js";

afterEach(() => setHostResolver(async () => ["93.184.216.34"]));

describe("media keys and limits", () => {
  it("keys uploads by company and month under the social prefix", () => {
    const key = mediaKey("co-1", "video/mp4", "Launch Reel FINAL.mp4");
    expect(key).toMatch(/^social\/co-1\/\d{4}-\d{2}\/[0-9a-f-]{36}-launch-reel-final\.mp4$/);
    expect(mediaKey("co-1", "image/jpeg")).toMatch(/\.jpg$/);
  });

  it("accepts social media types up to 512 MB", () => {
    expect(() => assertUploadable({ mime: "image/png", bytes: 10 })).not.toThrow();
    expect(() => assertUploadable({ mime: "application/pdf", bytes: 10 })).toThrow(/Unsupported/);
    expect(() => assertUploadable({ mime: "video/mp4", bytes: 513 * 1024 * 1024 })).toThrow(/512 MB/);
    expect(() => assertUploadable({ mime: "video/mp4", bytes: 0 })).toThrow(/size/);
  });

  it("presigns an R2 PUT and returns the public URL", async () => {
    const ctx = fakeCtx({
      config: {
        get: async () => ({
          publicBaseUrl: "https://paperclip.example.com",
          r2: { accountId: "acc", bucket: "media", accessKeyId: "AK", secretAccessKey: { type: "secret_ref", secretId: "s" }, publicMediaBaseUrl: "https://media.example.com" },
        }),
      },
      secrets: { resolve: vi.fn(async () => "SK") },
    });
    const out = await presignUpload(ctx, "co-1", { fileName: "hero.png", mime: "image/png", bytes: 1234 });
    expect(out.uploadUrl.startsWith(`https://acc.r2.cloudflarestorage.com/media/${out.key}?`)).toBe(true);
    expect(out.uploadUrl).toContain("X-Amz-Signature=");
    expect(out.publicUrl).toBe(`https://media.example.com/${out.key}`);
    expect(out.headers).toEqual({ "Content-Type": "image/png" });
  });
});

describe("URL safety for server-side downloads", () => {
  it("detects private and loopback addresses", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("only allows https URLs on public hosts", async () => {
    setHostResolver(async () => ["93.184.216.34"]);
    await expect(assertPublicUrl("https://media.example.com/a.jpg")).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("http://media.example.com/a.jpg")).rejects.toThrow(/https/);
    await expect(assertPublicUrl("https://localhost/a.jpg")).rejects.toThrow(/public host/);
    await expect(assertPublicUrl("https://127.0.0.1/a.jpg")).rejects.toThrow(/public host/);
    await expect(assertPublicUrl("https://user:pw@media.example.com/a")).rejects.toThrow(/credentials/);
    setHostResolver(async () => ["10.0.0.8"]);
    await expect(assertPublicUrl("https://rebind.example.com/a.jpg")).rejects.toThrow(/public host/);
  });
});
