import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { requireWebBrokerUrl, webBrokerSettingsView, webBrokerConfigured } from "../src/config.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { createWebBroker, type FetchLike } from "../src/web/broker.js";
import {
  GOOGLE_CUSTOMER_PRESET,
  GOOGLE_LOGIN_CUSTOMER_PRESET,
  listConnections,
  normalizeGoogleAdsId,
  setGoogleCustomer,
  startGoogleAuthorize,
  startMetaAuthorize,
} from "../src/web/connections.js";
import { webBrokerFor, webConnectionsReturnPath } from "../src/web/runtime.js";
import { AdsError } from "../src/domain.js";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const OWNER = "user-owner";
const userActor = { actor: { type: "user" as const, userId: OWNER, agentId: null, runId: null, companyId: COMPANY }, companyId: COMPANY };
const agentActor = { actor: { type: "agent" as const, userId: null, agentId: "agent-ads", runId: "run-9", companyId: COMPANY }, companyId: COMPANY };

const brokerConfig = {
  publicBaseUrl: "https://paperclip.test",
  webBrokerUrl: "https://partnersinbiz.online",
  webOrgId: "org-uuid",
  webBrokerToken: "tok-secret",
};

describe("web ad connections", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes Google customer IDs to digits and rejects non-10-digit values", () => {
    expect(normalizeGoogleAdsId(GOOGLE_CUSTOMER_PRESET)).toBe("7585296111");
    expect(normalizeGoogleAdsId(GOOGLE_LOGIN_CUSTOMER_PRESET)).toBe("2814293621");
    expect(() => normalizeGoogleAdsId("abc")).toThrow(/10 digits/);
    expect(() => normalizeGoogleAdsId("123")).toThrow(/10 digits/);
  });

  it("rejects non-https broker URLs before any token is used", () => {
    expect(requireWebBrokerUrl({ webBrokerUrl: "https://partnersinbiz.online" })).toBe("https://partnersinbiz.online");
    expect(requireWebBrokerUrl({ webBrokerUrl: "http://localhost:3000/" })).toBe("http://localhost:3000");
    expect(() => requireWebBrokerUrl({ webBrokerUrl: "http://evil.example" })).toThrow(/https/);
    expect(() => requireWebBrokerUrl({ webBrokerUrl: "ftp://partnersinbiz.online" })).toThrow(/https/);
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

  it("refuses a non-https authorize URL from the broker", async () => {
    const fetchFn: FetchLike = async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ authorizeUrl: "http://evil.test/auth" }),
    });
    const broker = createWebBroker(fetchFn, {
      baseUrl: "https://partnersinbiz.online",
      token: "tok",
      orgId: "org-id",
      orgSlug: "partners-in-biz",
    });
    await expect(startGoogleAuthorize(broker, { returnPath: "https://paperclip.test/PAR/ads?tab=web-connections" })).rejects.toThrow(/non-https/);
    await expect(startMetaAuthorize(broker, { returnPath: "https://paperclip.test/PAR/ads?tab=web-connections" })).rejects.toThrow(/non-https/);
  });

  it("maps 401/403 broker responses to BrokerError without leaking the body", async () => {
    const fetchFn: FetchLike = async () => ({
      status: 401,
      ok: false,
      text: async () => JSON.stringify({ message: "token=super-secret-value" }),
    });
    const broker = createWebBroker(fetchFn, {
      baseUrl: "https://partnersinbiz.online",
      token: "tok",
      orgId: "org-id",
      orgSlug: "partners-in-biz",
    });
    await expect(listConnections(broker)).rejects.toMatchObject({
      name: "BrokerError",
      message: "The web broker rejected the credential.",
      status: 401,
    });
  });

  it("returnPath uses public base URL and encodes the issue prefix", async () => {
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.test/" } });
    harness.ctx.companies.get = async () => ({ issuePrefix: "PIB" }) as Awaited<ReturnType<typeof harness.ctx.companies.get>>;
    await expect(webConnectionsReturnPath(harness.ctx, "co-1", "https://paperclip.test/")).resolves.toBe(
      "https://paperclip.test/PIB/ads?tab=web-connections",
    );
    harness.ctx.companies.get = async () => ({ issuePrefix: "P/IB" }) as Awaited<ReturnType<typeof harness.ctx.companies.get>>;
    await expect(webConnectionsReturnPath(harness.ctx, "co-1", "https://paperclip.test/")).resolves.toBe(
      "https://paperclip.test/P%2FIB/ads?tab=web-connections",
    );
  });

  it("webBrokerFor refuses a bad URL before reading the token", async () => {
    const harness = createTestHarness({
      manifest,
      config: { ...brokerConfig, webBrokerUrl: "http://evil.example", webBrokerToken: "must-not-be-sent" },
    });
    let secretReads = 0;
    const secrets = harness.ctx.secrets as { resolve?: (...args: unknown[]) => Promise<string> };
    const original = secrets.resolve?.bind(secrets);
    if (original) {
      secrets.resolve = async (...args) => {
        secretReads += 1;
        return original(...args);
      };
    }
    await expect(webBrokerFor(harness.ctx, COMPANY, { ...brokerConfig, webBrokerUrl: "http://evil.example" })).rejects.toThrow(AdsError);
    expect(secretReads).toBe(0);
  });

  it("webBrokerFor refuses a missing token", async () => {
    const harness = createTestHarness({ manifest, config: { ...brokerConfig, webBrokerToken: "" } });
    await expect(webBrokerFor(harness.ctx, COMPANY, { webOrgId: "org-uuid", webBrokerToken: "", webBrokerUrl: "https://partnersinbiz.online" })).rejects.toThrow(
      /not configured|not saved/,
    );
  });
});

describe("ads.web-* actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function readyHarness(config: Record<string, unknown> = brokerConfig) {
    const harness = createTestHarness({ manifest, config });
    harness.seed({
      companies: [{ id: COMPANY, name: "Partners in Biz", issuePrefix: "PIB" } as never],
    });
    await plugin.definition.setup(harness.ctx);
    return harness;
  }

  function stubFetch(handler: FetchLike) {
    vi.stubGlobal("fetch", handler);
  }

  it("requireUser gates oauth-start for an agent", async () => {
    const harness = await readyHarness();
    await expect(harness.performAction("ads.web-oauth-start", { platform: "google" }, agentActor)).rejects.toThrow(/signed-in person/);
  });

  it("maps a rejected authorize call to AdsError (return await)", async () => {
    const harness = await readyHarness();
    stubFetch(async () => ({
      status: 403,
      ok: false,
      text: async () => JSON.stringify({ message: "nope" }),
    }));
    await expect(harness.performAction("ads.web-oauth-start", { platform: "google" }, userActor)).rejects.toThrow(AdsError);
    await expect(harness.performAction("ads.web-oauth-start", { platform: "google" }, userActor)).rejects.toThrow(/rejected the credential/);
  });

  it("starts Meta authorize and returns an https authorizeUrl", async () => {
    const harness = await readyHarness();
    stubFetch(async (url) => {
      if (String(url).includes("/meta/authorize")) {
        return { status: 200, ok: true, text: async () => JSON.stringify({ authorizeUrl: "https://facebook.test/dialog" }) };
      }
      return { status: 404, ok: false, text: async () => "missing" };
    });
    const result = await harness.performAction<{ authorizeUrl: string }>("ads.web-oauth-start", { platform: "meta" }, userActor);
    expect(result.authorizeUrl).toBe("https://facebook.test/dialog");
  });

  it("rejects a bad broker URL on oauth-start without calling fetch", async () => {
    const harness = await readyHarness({ ...brokerConfig, webBrokerUrl: "http://evil.example" });
    let fetches = 0;
    stubFetch(async () => {
      fetches += 1;
      return { status: 200, ok: true, text: async () => "{}" };
    });
    await expect(harness.performAction("ads.web-oauth-start", { platform: "google" }, userActor)).rejects.toThrow(/https/);
    expect(fetches).toBe(0);
  });

  it("loads connections status through ads.web-connections.load", async () => {
    const harness = await readyHarness();
    stubFetch(async () => ({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          connections: [
            { id: "g1", provider: "google", status: "connected" },
            { id: "m1", provider: "meta", connected: true },
          ],
        }),
    }));
    const result = await harness.performAction<{ google: boolean; meta: boolean; googleConnectionId: string | null }>(
      "ads.web-connections.load",
      {},
      userActor,
    );
    expect(result).toMatchObject({ google: true, meta: true, googleConnectionId: "g1", configured: true });
  });

  it("lists Google customers and sets a customer id", async () => {
    const harness = await readyHarness();
    stubFetch(async (url, init) => {
      if (String(url).includes("/customers") && init.method === "GET") {
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ customers: [{ customerId: "7585296111", descriptiveName: "PiB" }] }),
        };
      }
      if (String(url).includes("/customer") && init.method === "PATCH") {
        return { status: 200, ok: true, text: async () => "" };
      }
      return { status: 404, ok: false, text: async () => "missing" };
    });
    const listed = await harness.performAction<{ customers: Array<{ customerId: string }> }>(
      "ads.web-google-customers",
      { connectionId: "g1" },
      userActor,
    );
    expect(listed.customers[0]!.customerId).toBe("7585296111");
    await expect(
      harness.performAction("ads.web-google-set-customer", { connectionId: "g1", customerId: GOOGLE_CUSTOMER_PRESET, loginCustomerId: GOOGLE_LOGIN_CUSTOMER_PRESET }, userActor),
    ).resolves.toEqual({ ok: true });
    await expect(
      harness.performAction("ads.web-google-set-customer", { connectionId: "g1", customerId: "abc" }, userActor),
    ).rejects.toThrow(/10 digits/);
  });

  it("surfaces BrokerError from load as AdsError", async () => {
    const harness = await readyHarness();
    stubFetch(async () => ({
      status: 401,
      ok: false,
      text: async () => JSON.stringify({ message: "bad" }),
    }));
    await expect(harness.performAction("ads.web-connections.load", {}, userActor)).rejects.toBeInstanceOf(AdsError);
    await expect(harness.performAction("ads.web-connections.load", {}, userActor)).rejects.toThrow(/rejected the credential/);
  });
});
