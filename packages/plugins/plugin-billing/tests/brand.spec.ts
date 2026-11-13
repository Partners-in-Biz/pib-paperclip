import { describe, expect, it } from "vitest";
import { brandColor, clearLogoCache, documentBrand, logoAddress } from "../src/brand.js";
import { documentPdfSpec, renderDocument, type DocView } from "../src/documents.js";
import { pdfImageType } from "@partnersinbiz/pib-plugin-kit";

// 1x1 PNG
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

function fakeCtx(body: Uint8Array | null, status = 200) {
  const calls: string[] = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    http: {
      async fetch(url: string) {
        calls.push(url);
        if (!body) throw new Error("offline");
        return new Response(Buffer.from(body), { status, headers: { "content-type": "image/png" } });
      },
    },
  };
  return { ctx: ctx as any, calls };
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
    const { ctx, calls } = fakeCtx(PNG);
    const settings = { sender: { logoUrl: "https://example.test/a.png", brandColor: "#f59e0b" } };
    const brand = await documentBrand(ctx, { name: "PiB" }, settings);
    expect(pdfImageType(brand.logo)).toBe("png");
    expect(brand.accent).toBe("#f59e0b");
    await documentBrand(ctx, {}, settings);
    expect(calls).toHaveLength(1);
  });

  it("prefers the document's frozen sender over today's settings", async () => {
    clearLogoCache();
    const { ctx, calls } = fakeCtx(PNG);
    await documentBrand(ctx, { logoUrl: "https://example.test/old.png" }, { sender: { logoUrl: "https://example.test/new.png" } });
    expect(calls[0]).toBe("https://example.test/old.png");
  });

  it("gives no logo for a failed fetch or a file that is not PNG/JPEG", async () => {
    clearLogoCache();
    expect((await documentBrand(fakeCtx(null).ctx, { logoUrl: "https://example.test/x.png" }, {})).logo).toBeNull();
    clearLogoCache();
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    expect((await documentBrand(fakeCtx(svg).ctx, { logoUrl: "https://example.test/x.svg" }, {})).logo).toBeNull();
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
