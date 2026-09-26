import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { gscRedirectUri, loadSeoConfig, parseSeoConfig, validateSeoConfig } from "../src/config.js";
import { discoverKeywords, inferIntent, parseAutocomplete, seedVariants } from "../src/integrations/autocomplete.js";
import { parseBingLinkCounts } from "../src/integrations/bing.js";
import {
  aggregateKeywordRows,
  aggregatePageRows,
  buildGscAuthorizeUrl,
  exchangeGoogleCode,
  GoogleApiError,
  GSC_SCOPE,
  pickPropertyForSite,
  refreshGoogleToken,
  tokenNeedsRefresh,
  type GscRow,
} from "../src/integrations/google.js";
import { cwvFindings, parsePagespeed } from "../src/integrations/pagespeed.js";
import { mergeGrants, PLUGIN_TOOLS_GRANT } from "../src/service/agent.js";
import { pagespeedUrls } from "../src/service/jobs.js";

const row = (page: string, query: string, impressions: number, position: number, clicks = 0): GscRow => ({
  keys: [page, query],
  impressions,
  position,
  clicks,
  ctr: impressions ? clicks / impressions : 0,
});

describe("GSC aggregation", () => {
  it("matches queries case-insensitively and weights position by impressions", () => {
    const rows = [
      row("https://acme.co.za/a", "Durban Accountant", 100, 4, 10),
      row("https://acme.co.za/b", "durban  accountant", 300, 12, 3),
      row("https://acme.co.za/a", "tax help", 10, 30),
    ];
    const result = aggregateKeywordRows(rows, [
      { id: "k1", phrase: "durban accountant" },
      { id: "k2", phrase: "vat returns" },
    ]);
    expect(result.has("k2")).toBe(false);
    const k1 = result.get("k1")!;
    expect(k1.impressions).toBe(400);
    expect(k1.clicks).toBe(13);
    expect(k1.position).toBe(10); // (4*100 + 12*300) / 400
    expect(k1.ctr).toBeCloseTo(13 / 400);
    expect(k1.topPage).toBe("https://acme.co.za/b");
  });

  it("totals per page by comparable URL", () => {
    const pages = aggregatePageRows([row("https://acme.co.za/a/", "q1", 10, 5, 1), row("https://ACME.co.za/a", "q2", 30, 9, 2)]);
    expect(pages.get("https://acme.co.za/a")).toMatchObject({ impressions: 40, clicks: 3, position: 8 });
  });

  it("picks the Domain property first, then the matching URL-prefix one", () => {
    const sites = [
      { siteUrl: "https://www.acme.co.za/", permissionLevel: "siteOwner" },
      { siteUrl: "sc-domain:acme.co.za", permissionLevel: "siteFullUser" },
      { siteUrl: "sc-domain:other.com", permissionLevel: "siteOwner" },
    ];
    expect(pickPropertyForSite(sites, "https://acme.co.za")).toBe("sc-domain:acme.co.za");
    expect(pickPropertyForSite(sites.slice(0, 1), "https://acme.co.za")).toBe("https://www.acme.co.za/");
    expect(pickPropertyForSite([{ siteUrl: "sc-domain:acme.co.za", permissionLevel: "siteUnverifiedUser" }], "acme.co.za")).toBeNull();
  });
});

describe("Google OAuth", () => {
  it("builds the consent URL with the bridge redirect, offline access and consent prompt", () => {
    const redirectUri = gscRedirectUri("https://paperclip.partnersinbiz.online/", "/_plugins/051bbf0b-aeb5-42d7-b0b6-c4cabd271cdc/ui/");
    expect(redirectUri).toBe("https://paperclip.partnersinbiz.online/_plugins/051bbf0b-aeb5-42d7-b0b6-c4cabd271cdc/ui/oauth-callback.html");
    const url = new URL(buildGscAuthorizeUrl({ clientId: "cid.apps.googleusercontent.com", redirectUri, state: "st-1" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(GSC_SCOPE);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("st-1");
  });

  it("exchanges the code with a form body", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("redirect_uri")).toBe("https://x/cb");
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
      return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: GSC_SCOPE }), { status: 200 });
    });
    const tokens = await exchangeGoogleCode(fetchImpl, { clientId: "c", clientSecret: "s", redirectUri: "https://x/cb", code: "code" }, 1_000);
    expect(tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 3_601_000, scope: GSC_SCOPE });
    expect(fetchImpl).toHaveBeenCalledWith("https://oauth2.googleapis.com/token", expect.anything());
  });

  it("keeps the refresh token on refresh and flags revoked grants for reconnect", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ access_token: "new", expires_in: 100 }), { status: 200 }));
    const refreshed = await refreshGoogleToken(ok, { clientId: "c", clientSecret: "s", refreshToken: "rt" }, 0);
    expect(refreshed).toMatchObject({ accessToken: "new", refreshToken: "rt", expiresAt: 100_000 });
    const revoked = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 }));
    const error = await refreshGoogleToken(revoked, { clientId: "c", clientSecret: "s", refreshToken: "rt" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as GoogleApiError).reconnect).toBe(true);
    expect(tokenNeedsRefresh({ expiresAt: Date.now() + 60_000 })).toBe(true);
    expect(tokenNeedsRefresh({ expiresAt: Date.now() + 3_600_000 })).toBe(false);
  });
});

describe("PageSpeed", () => {
  const lighthouse = {
    categories: { performance: { score: 0.62 }, seo: { score: 0.91 }, accessibility: { score: 0.8 }, "best-practices": { score: 1 } },
    audits: {
      "largest-contentful-paint": { numericValue: 3400 },
      "cumulative-layout-shift": { numericValue: 0.04 },
      "render-blocking-resources": { title: "Eliminate render-blocking resources", score: 0.3, details: { type: "opportunity", overallSavingsMs: 900 } },
    },
  };
  it("prefers URL field data (CLS reported ×100) and keeps lab values", () => {
    const record = parsePagespeed({
      lighthouseResult: lighthouse,
      loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2100 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12 }, INTERACTION_TO_NEXT_PAINT: { percentile: 180 } } },
    }, "https://acme.co.za/", "mobile");
    expect(record).toMatchObject({ performance: 62, seo: 91, source: "field", lcpMs: 2100, cls: 0.12, inpMs: 180, labLcpMs: 3400, labCls: 0.04, fieldScope: "url" });
    expect(record.opportunities[0]).toMatchObject({ id: "render-blocking-resources", savingsMs: 900 });
    expect(cwvFindings(record).map((f) => f.finding)).toEqual(["CLS 0.12 (field); target < 0.1"]);
  });
  it("falls back to lab audits when field data is only origin-level", () => {
    const record = parsePagespeed({ lighthouseResult: lighthouse, originLoadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 1900 } } } }, "u", "mobile");
    expect(record).toMatchObject({ source: "lab", lcpMs: 3400, cls: 0.04, inpMs: null, fieldScope: "origin", fieldLcpMs: 1900 });
    expect(cwvFindings(record)[0]).toMatchObject({ severity: "medium" });
  });
  it("rotates up to 3 target pages after the home page", () => {
    const urls = ["https://acme.co.za/a", "https://acme.co.za/b", "https://acme.co.za/c", "https://acme.co.za/d", "https://acme.co.za/"];
    expect(pagespeedUrls("https://acme.co.za", urls, 0)).toEqual(["https://acme.co.za/", "https://acme.co.za/a", "https://acme.co.za/b", "https://acme.co.za/c"]);
    expect(pagespeedUrls("https://acme.co.za", urls, 1)).toEqual(["https://acme.co.za/", "https://acme.co.za/b", "https://acme.co.za/c", "https://acme.co.za/d"]);
    expect(pagespeedUrls("https://acme.co.za", [], 5)).toEqual(["https://acme.co.za/"]);
  });
});

describe("Bing", () => {
  it("sums inbound link counts from GetLinkCounts", () => {
    const parsed = parseBingLinkCounts({ d: { Links: [{ Url: "https://acme.co.za/", Count: 12 }, { Url: "https://acme.co.za/a", Count: 3 }], TotalPages: 1 } });
    expect(parsed).toEqual({ totalInboundLinks: 15, pages: [{ url: "https://acme.co.za/", count: 12 }, { url: "https://acme.co.za/a", count: 3 }], totalPages: 1 });
    expect(() => parseBingLinkCounts({ d: { Something: 1 } })).toThrow(/Unexpected/);
  });
});

describe("keyword discovery", () => {
  it("guesses intent and builds seed variants", () => {
    expect(seedVariants("crm")).toEqual(["crm alternative", "crm vs", "best crm", "how to crm", "crm for small business", "crm pricing"]);
    expect(inferIntent("how to file vat")).toBe("problem");
    expect(inferIntent("best accountant durban")).toBe("solution");
    expect(inferIntent("acme accounting reviews", ["Acme"])).toBe("brand");
    expect(inferIntent("accountant durban")).toBe("solution");
    expect(parseAutocomplete(["crm", ["crm software", "crm meaning", 3]])).toEqual(["crm software", "crm meaning"]);
  });
  it("combines autocomplete with variants, de-duplicated and excluding tracked keywords", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const q = new URL(url).searchParams.get("q") ?? "";
      return new Response(JSON.stringify([q, [`${q} software`, "crm software"]]), { status: 200 });
    });
    const result = await discoverKeywords(fetchImpl, { seeds: ["crm"], exclude: ["crm pricing"], limit: 50 });
    const phrases = result.map((c) => c.phrase);
    expect(phrases).toContain("crm software");
    expect(phrases.filter((p) => p === "crm software")).toHaveLength(1);
    expect(phrases).not.toContain("crm pricing");
    expect(result.find((c) => c.phrase === "how to crm")?.source).toBe("seed-variant");
    expect(new URL(fetchImpl.mock.calls[0]![0] as string).searchParams.get("client")).toBe("firefox");
  });
});

describe("config", () => {
  it("resolves secret refs with the company and config path", async () => {
    const resolve = vi.fn(async (_ref: unknown, opts?: { companyId?: string; configPath?: string }) => `secret-for-${opts?.configPath}`);
    const ctx = {
      config: { get: vi.fn(async (companyId?: string) => (companyId === "co-1" ? {
        publicBaseUrl: "https://paperclip.partnersinbiz.online",
        encryptionKey: { type: "secret_ref", secretId: "s1" },
        google: { clientId: "cid", clientSecret: { type: "secret_ref", secretId: "s2", version: "latest" } },
        timezone: "Mars/Olympus",
      } : {})) },
      secrets: { resolve },
    } as unknown as PluginContext;
    const loaded = await loadSeoConfig(ctx, "co-1");
    expect(loaded.config).toMatchObject({ saved: true, timezone: "Africa/Johannesburg", dailyHourLocal: 6, defaultAutopilotMode: "safe", googleClientId: "cid" });
    expect(await loaded.secrets.get("google.clientSecret")).toBe("secret-for-google.clientSecret");
    expect(await loaded.secrets.get("google.clientSecret")).toBe("secret-for-google.clientSecret");
    expect(await loaded.secrets.get("pagespeedApiKey")).toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ type: "secret_ref", secretId: "s2", version: "latest" }, { companyId: "co-1", configPath: "google.clientSecret" });
    expect((ctx.config.get as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(["co-1"]);
    expect(parseSeoConfig({}).saved).toBe(false);
  });

  it("validates settings", () => {
    expect(validateSeoConfig({ timezone: "Nope/Zone", dailyHourLocal: 25, publicBaseUrl: "http://example.com" }).errors).toHaveLength(3);
    const ok = validateSeoConfig({ timezone: "Africa/Johannesburg", dailyHourLocal: 6, publicBaseUrl: "https://paperclip.partnersinbiz.online" });
    expect(ok.ok).toBe(true);
    expect(validateSeoConfig({}).warnings[0]).toMatch(/Public base URL/);
  });
});

describe("agent tool grant", () => {
  it("merges the plugin-tools grant into existing grants without duplicates", () => {
    const existing = [{ permissionKey: "tasks:assign", scope: null }, { permissionKey: "tools:use", scope: { providerType: "paperclip_self" } }];
    const first = mergeGrants(existing, PLUGIN_TOOLS_GRANT);
    expect(first.added).toBe(true);
    expect(first.grants).toHaveLength(3);
    expect(first.grants).toContainEqual({ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } });
    const again = mergeGrants(first.grants, { permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } });
    expect(again).toEqual({ grants: first.grants, added: false });
  });
});
