import { describe, expect, it } from "vitest";
import { assertOwnKey, assetKey, objectUrl, sniffMime } from "../src/storage.js";
import { assertModel, higgsfieldProvider, outputUrls } from "../src/provider.js";
import { effectiveCap, assertFits, isCapScope } from "../src/ledger.js";
import { STUDIO_TOOLS } from "../src/tools.js";
import manifest from "../src/manifest.js";

const CO = "11111111-1111-4111-8111-111111111111";
const BUCKET = { accountId: "acct", bucket: "pib-private", accessKeyId: "AK", secretAccessKey: "SK" };

describe("storage paths", () => {
  it("files own work and client work under this company's Studio folder", () => {
    expect(assetKey(CO, null, "a1", 1, "png")).toBe(`studio/${CO}/own/a1/v1.png`);
    expect(assetKey(CO, { kind: "company", id: "c9" }, "a1", 2, "mp4")).toBe(`studio/${CO}/company-c9/a1/v2.mp4`);
  });

  it("refuses unsafe path parts", () => {
    expect(() => assetKey(CO, { kind: "company", id: "../payroll" }, "a1", 1, "png")).toThrow(/Unsafe/);
    expect(() => assetKey(CO, null, "a/../b", 1, "png")).toThrow(/Unsafe/);
  });

  it.each([
    ["another plugin's files", `payroll/${CO}/x/y/v1.pdf`],
    ["billing files", `billing/${CO}/x/y/v1.pdf`],
    ["another company's Studio folder", "studio/22222222-2222-4222-8222-222222222222/own/a/v1.png"],
    ["a climb out of the folder", `studio/${CO}/../../payroll/x/v1.pdf`],
    ["a bare company folder", `studio/${CO}`],
  ])("refuses %s", (_label, key) => {
    expect(() => assertOwnKey(CO, key)).toThrow(/outside/);
    expect(() => objectUrl(BUCKET, CO, "GET", key, 60)).toThrow(/outside/);
  });

  it("signs a key inside the folder", () => {
    expect(objectUrl(BUCKET, CO, "GET", `studio/${CO}/own/a/v1.png`, 60)).toContain("X-Amz-Signature=");
  });
});

describe("file types", () => {
  const pad = (head: number[]) => new Uint8Array([...head, ...new Array(16).fill(0)]);
  const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
  it("reads the type from the bytes", () => {
    expect(sniffMime(pad([0x89, ...ascii("PNG")]))).toBe("image/png");
    expect(sniffMime(pad([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(sniffMime(pad([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]))).toBe("image/webp");
    expect(sniffMime(pad([0, 0, 0, 0, ...ascii("ftypisom")]))).toBe("video/mp4");
    expect(sniffMime(pad([0, 0, 0, 0, ...ascii("ftypqt  ")]))).toBe("video/quicktime");
    expect(sniffMime(pad(ascii("<html>")))).toBeNull();
  });
});

describe("provider helpers", () => {
  it("prefers the original file and drops repeats", () => {
    const urls = outputUrls({ images: [{ url: "https://x/a.jpg", raw: "https://x/raw.png" }], thumb: { url: "https://x/a.jpg" } });
    expect(urls).toEqual(["https://x/raw.png", "https://x/a.jpg"]);
  });

  it("refuses a model id that could change the request path", () => {
    expect(() => assertModel("higgsfield-ai/soul/v2/standard")).not.toThrow();
    for (const bad of ["../requests/1/status", "a//b", "a?b=1", "https://evil/x", ""]) expect(() => assertModel(bad)).toThrow();
  });

  it("refuses a key in the wrong form", () => {
    expect(() => higgsfieldProvider("no-colon")).toThrow(/form/);
  });
});

describe("which cap applies", () => {
  const client = { kind: "company" as const, id: "c1" };
  const caps = (...rows: Array<[string, number]>) => rows.map(([scopeKey, monthlyCredits]) => ({ scopeKey, monthlyCredits }));

  it("takes the client's, then the company's, then the default", () => {
    const all = caps(["company:c1", 5], ["company", 20], ["default", 50]);
    expect(effectiveCap(all, client)).toMatchObject({ monthlyCredits: 5, source: "client", measuredOn: "client" });
    expect(effectiveCap(all, null)).toMatchObject({ monthlyCredits: 20, source: "company", measuredOn: "company" });
    expect(effectiveCap(caps(["company", 20], ["default", 50]), client)).toMatchObject({ monthlyCredits: 20, source: "company" });
    expect(effectiveCap(caps(["default", 50]), client)).toMatchObject({ monthlyCredits: 50, source: "default" });
  });

  it("has no built-in amount: no cap anywhere means off", () => {
    const check = { cap: effectiveCap([], null), used: 0, remaining: null };
    expect(check.cap.monthlyCredits).toBeNull();
    expect(() => assertFits(check, 0.1)).toThrow(/generation is off/);
  });

  it("knows which caps exist", () => {
    for (const ok of ["default", "company", "company:abc", "contact:a-b", "agent:8c0973a2-43bf-4acc-8ac7-dec8a679449f"]) expect(isCapScope(ok)).toBe(true);
    for (const bad of ["", "all", "company:", "company:a b", "other:1", "agent:", "agent:a b"]) expect(isCapScope(bad)).toBe(false);
  });
});

describe("what agents are given", () => {
  it("offers no tool that changes a cap", () => {
    // Whole name parts only: "video-edit-caption" (PAR-8360) is not a spending cap.
    const capLike = /(^|-)caps?(-|$)|limit/;
    expect(["studio-set-cap", "credit-caps", "set-limit"].every((n) => capLike.test(n))).toBe(true);
    expect(STUDIO_TOOLS.map((t) => t.name).filter((n) => capLike.test(n))).toEqual([]);
  });

  it("declares every tool in the manifest and a read-only smoke tool", () => {
    expect(manifest.tools).toBe(STUDIO_TOOLS);
    expect(STUDIO_TOOLS.map((t) => t.name)).toContain("studio-usage");
    expect(manifest.description!.length).toBeLessThan(500);
  });
});
