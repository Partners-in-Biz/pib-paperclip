import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { webBrokerSettingsView, webBrokerConfigured } from "../src/config.js";
import manifest from "../src/manifest.js";
import { createWebBroker, type FetchLike } from "../src/web/broker.js";
import {
  GOOGLE_CUSTOMER_PRESET,
  GOOGLE_LOGIN_CUSTOMER_PRESET,
  listConnections,
  normalizeGoogleAdsId,
  setGoogleCustomer,
  startGoogleAuthorize,
} from "../src/web/connections.js";
import { webConnectionsReturnPath } from "../src/web/runtime.js";

describe("web ad connections", () => {
  it("normalizes Google customer IDs to digits", () => {
    expect(normalizeGoogleAdsId(GOOGLE_CUSTOMER_PRESET)).toBe("7585296111");
    expect(normalizeGoogleAdsId(GOOGLE_LOGIN_CUSTOMER_PRESET)).toBe("2814293621");
  });

  it("load payload exposes secret names and flags only", () => {
    const view = webBrokerSettingsView({
      webBrokerUrl: "https://partnersinbiz.online",
      webOrgId: "org-uuid",
      webBrokerToken: { type: "secret_ref", secretId: "sec-1" },
    });
    expect(webBrokerConfigured({ webOrgId: "org-uuid", webBrokerToken: "x".repeat(20) })).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/secret_ref|sec-1/);
    expect(view.secrets.webBrokerToken).toEqual({ configured: true });
    expect(view.secrets.webOrgId.value).toBe("org-uuid");
  });

  it("sends broker headers and builds oauth returnPath with tab=web-connections", async () => {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body?: string } }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      if (url.includes("/oauth/authorize")) {
        return { status: 200, ok: true, text: async () => JSON.stringify({ authorizeUrl: "https://google.test/auth" }) };
      }
      if (url.includes("/customer")) {
        return { status: 200, ok: true, text: async () => "" };
      }
      return { status: 200, ok: true, text: async () => JSON.stringify({ connections: [] }) };
    };
    const broker = createWebBroker(fetchFn, {
      baseUrl: "https://partnersinbiz.online",
      token: "tok",
      orgId: "org-id",
      orgSlug: "partners-in-biz",
    });
    await listConnections(broker);
    const auth = await startGoogleAuthorize(broker, { returnPath: "https://paperclip.test/PAR/ads?tab=web-connections" });
    expect(auth.authorizeUrl).toBe("https://google.test/auth");
    await setGoogleCustomer(broker, "conn-1", { customerId: GOOGLE_CUSTOMER_PRESET, loginCustomerId: GOOGLE_LOGIN_CUSTOMER_PRESET });
    expect(calls[0]!.init.headers["X-Org-Slug"]).toBe("partners-in-biz");
    expect(calls[0]!.init.headers["X-Org-Id"]).toBe("org-id");
    expect(JSON.parse(calls[1]!.init.body!).returnPath).toMatch(/tab=web-connections$/);
    expect(JSON.parse(calls[2]!.init.body!)).toEqual({ customerId: "7585296111", loginCustomerId: "2814293621" });
  });

  it("returnPath uses public base URL and issue prefix", async () => {
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.test/" } });
    harness.ctx.companies.get = async () => ({ issuePrefix: "PIB" }) as Awaited<ReturnType<typeof harness.ctx.companies.get>>;
    await expect(webConnectionsReturnPath(harness.ctx, "co-1", "https://paperclip.test/")).resolves.toBe(
      "https://paperclip.test/PIB/ads?tab=web-connections",
    );
  });
});
