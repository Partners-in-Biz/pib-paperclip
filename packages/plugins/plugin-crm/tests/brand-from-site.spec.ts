import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandFindings } from "@partnersinbiz/pib-plugin-kit";
import { describe, expect, it } from "vitest";
import { brandPatchFrom, extractBrandFromSiteTool, SAVE_SCORE } from "../src/brand-from-site.js";
import type { Viewer } from "../src/domain.js";
import { CRM_TOOLS } from "../src/tools.js";

const findings = (over: Partial<BrandFindings> = {}): BrandFindings => ({
  url: "https://acme.example/",
  siteName: "Acme",
  title: "Acme",
  description: null,
  headings: [],
  primaryColor: "#b5451b",
  secondaryColor: "#2e6b4d",
  accentColor: "#f0b429",
  colors: [
    { hex: "#b5451b", score: 90, evidence: ["theme-color"], role: "primary" },
    { hex: "#2e6b4d", score: 30, evidence: ["var --secondary"], role: "secondary" },
    { hex: "#f0b429", score: 12, evidence: ["used 2 times"] },
  ],
  backgroundColor: "#fffaf2",
  textColor: "#222222",
  fonts: ["Playfair Display", "Inter"],
  fontsDeclared: [],
  shareImage: null,
  generator: null,
  logoUrl: "https://acme.example/logo.svg",
  logoCandidates: ["https://acme.example/logo.svg"],
  notes: [],
  ...over,
});

describe("brandPatchFrom: only well-supported colours are saved", () => {
  it("keeps named and strong colours and leaves a thin one out", () => {
    expect(brandPatchFrom(findings())).toEqual({ primaryColor: "#b5451b", secondaryColor: "#2e6b4d", fonts: ["Playfair Display", "Inter"] });
  });
  it("saves no second colour without a first", () => {
    const weak = findings({ colors: [{ hex: "#b5451b", score: SAVE_SCORE - 1, evidence: ["used 3 times"] }, { hex: "#2e6b4d", score: 30, evidence: ["var --secondary"], role: "secondary" }] });
    expect(brandPatchFrom(weak)).toEqual({ fonts: ["Playfair Display", "Inter"] });
  });
  it("saves nothing from an empty read", () => {
    expect(brandPatchFrom(findings({ primaryColor: null, secondaryColor: null, accentColor: null, colors: [], fonts: [] }))).toEqual({});
  });
});

describe("extract-brand-from-site for own work (no client)", () => {
  const viewer: Viewer = { companyId: "co", userId: null, agentId: "a1", role: "agent" } as unknown as Viewer;
  const html = `<html><head><title>Us</title><meta name="theme-color" content="#E4572E"><link rel="apple-touch-icon" href="/logo.png">
    <style>:root{--brand-primary:#e4572e} h1{font-family:"Instrument Serif",serif} body{background:#f7f6f3;color:#171716}</style></head><body><h1>We run the busywork</h1>${"<p>line</p>".repeat(40)}</body></html>`;
  const ctx = { http: { fetch: async () => ({ status: 200, headers: new Headers(), text: async () => html }) } } as unknown as PluginContext;

  it("reads the site, saves nothing and says what to put in the company profile", async () => {
    const out = (await extractBrandFromSiteTool(ctx, viewer, { url: "us.example" }, "agent")) as Record<string, unknown>;
    expect(out).toMatchObject({
      client: "own",
      site: "https://us.example/",
      applied: [],
      forCompanyProfile: { primaryColor: "#e4572e", fonts: "Instrument Serif", logoUrl: "https://us.example/logo.png" },
    });
    expect((out.found as { headings: string[] }).headings).toEqual(["We run the busywork"]);
    expect(out.found).toMatchObject({ backgroundColor: "#f7f6f3", textColor: "#171716", shareImage: null });
    expect((out.next as string[])[0]).toContain("partnersinbiz.cockpit:update-company-profile");
  });
  it("asks for a client or an address", async () => {
    await expect(extractBrandFromSiteTool(ctx, viewer, {}, "agent")).rejects.toThrow(/Pass client/);
    await expect(extractBrandFromSiteTool(ctx, viewer, { url: "not a site" }, "agent")).rejects.toThrow(/not a website address/);
  });
});

describe("the tool is declared", () => {
  it("extract-brand-from-site takes client, url and apply, none required", () => {
    const tool = CRM_TOOLS.find((t) => t.name === "extract-brand-from-site")!;
    expect(tool).toBeTruthy();
    expect(Object.keys((tool.parametersSchema as { properties: Record<string, unknown> }).properties)).toEqual(["client", "url", "apply"]);
    expect((tool.parametersSchema as { required: string[] }).required).toEqual([]);
  });
});
