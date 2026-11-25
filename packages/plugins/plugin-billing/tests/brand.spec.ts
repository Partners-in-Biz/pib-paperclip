import { describe, expect, it } from "vitest";
import { brandColor, clearLogoCache, documentBrand, downloadLogo, isPrivateAddress, logoAddress } from "../src/brand.js";
import { documentPdfSpec, renderDocument, type DocView } from "../src/documents.js";
import { pdfImageType } from "@partnersinbiz/pib-plugin-kit";

// 1x1 PNG
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

const ctx = { logger: { info() {}, warn() {} } } as any;
const hostOk = async () => true;

function fakeFetch(body: Uint8Array | null, status = 200) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    if (!body) throw new Error("offline");
    return new Response(Buffer.from(body), { status, headers: { "content-type": "image/png" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const view: DocView = {
  kind: "invoice", number: "TVI-001", status: "sent", currency: "ZAR", issuedAt: "2026-11-13T00:00:00Z", dueAt: "2026-11-27T00:00:00Z",
  sender: { name: "Partners in Biz" }, customer: { name: "Client" },
  lines: [{ description: "Deposit", quantity: 1, unitAmountMinor: 100, taxCode: null, rateBp: 0, netMinor: 100, vatMinor: 0, grossMinor: 100 }],
  groups: [], subtotalMinor: 100, vatMinor: 0, totalMinor: 100, pricesIncludeVat: false, legacy: false, outstandingMinor: 100,
};

describe("document brand", () => {
  it("accepts only https logo addresses and hex colours", () => {
    expect(logoAddress("https://example.test/logo.png")).toBe("https://example.test/logo.png");
    expect(logoAddress("http://example.test/logo.png")).toBeNull();
    expect(logoAddress("javascript:alert(1)")).toBeNull();
    expect(brandColor("14304F")).toBe("#14304f");
    expect(brandColor("#abc")).toBe("#abc");
    expect(brandColor("navy")).toBeNull();
  });

  it("fetches the logo from settings when the document has none, and caches it", async () => {
    clearLogoCache();
    const { fetchImpl, calls } = fakeFetch(PNG);
    const settings = { sender: { logoUrl: "https://example.test/a.png", brandColor: "#f59e0b" } };
    const brand = await documentBrand(ctx, { name: "PiB" }, settings, { fetchImpl, hostOk });
    expect(pdfImageType(brand.logo)).toBe("png");
    expect(brand.logo).toEqual(PNG);
    expect(brand.accent).toBe("#f59e0b");
    await documentBrand(ctx, {}, settings, { fetchImpl, hostOk });
    expect(calls).toHaveLength(1);
  });

  it("prefers the document's frozen sender over today's settings", async () => {
    clearLogoCache();
    const { fetchImpl, calls } = fakeFetch(PNG);
    await documentBrand(ctx, { logoUrl: "https://example.test/old.png" }, { sender: { logoUrl: "https://example.test/new.png" } }, { fetchImpl, hostOk });
    expect(calls[0]).toBe("https://example.test/old.png");
  });

  it("gives no logo for a failed fetch or a file that is not PNG/JPEG", async () => {
    clearLogoCache();
    expect((await documentBrand(ctx, { logoUrl: "https://example.test/x.png" }, {}, { fetchImpl: fakeFetch(null).fetchImpl, hostOk })).logo).toBeNull();
    clearLogoCache();
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    expect((await documentBrand(ctx, { logoUrl: "https://example.test/x.svg" }, {}, { fetchImpl: fakeFetch(svg).fetchImpl, hostOk })).logo).toBeNull();
  });

  it("refuses private hosts, plain http redirects and oversize files", async () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("172.20.0.1")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("65.108.146.144")).toBe(false);
    expect(isPrivateAddress("2a01:4f9::1")).toBe(false);
    await expect(downloadLogo("https://127.0.0.1/a.png", { fetchImpl: fakeFetch(PNG).fetchImpl })).rejects.toThrow(/public/);
    await expect(downloadLogo("https://localhost/a.png", { fetchImpl: fakeFetch(PNG).fetchImpl })).rejects.toThrow(/public/);
    const redirect = (async () => new Response(null, { status: 302, headers: { location: "http://example.test/a.png" } })) as unknown as typeof fetch;
    await expect(downloadLogo("https://example.test/a.png", { fetchImpl: redirect, hostOk })).rejects.toThrow(/https/);
    const toPrivate = (async () => new Response(null, { status: 302, headers: { location: "https://10.0.0.1/a.png" } })) as unknown as typeof fetch;
    await expect(downloadLogo("https://example.test/a.png", { fetchImpl: toPrivate })).rejects.toThrow();
    const big = fakeFetch(new Uint8Array(2 * 1024 * 1024 + 1)).fetchImpl;
    await expect(downloadLogo("https://example.test/a.png", { fetchImpl: big, hostOk })).rejects.toThrow(/2 MB/);
  });

  it("passes the brand to the PDF and still renders with a broken logo", async () => {
    const spec = documentPdfSpec({ ...view, brand: { logo: PNG, accent: "#123456" } });
    expect(spec.logo).toBe(PNG);
    expect(spec.accent).toBe("#123456");
    expect(spec.brandName).toBe("Partners in Biz");
    const withLogo = await renderDocument({ ...view, brand: { logo: PNG, accent: "#123456" } });
    const plain = await renderDocument(view);
    expect(withLogo.length).toBeGreaterThan(plain.length);
    const broken = await renderDocument({ ...view, brand: { logo: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 1, 2]), accent: null } });
    expect(Buffer.from(broken.subarray(0, 5)).toString()).toBe("%PDF-");
  });
});
