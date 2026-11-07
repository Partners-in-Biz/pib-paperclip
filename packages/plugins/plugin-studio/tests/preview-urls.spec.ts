import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { assetUrlsForPerson } from "../src/assets.js";
import { defaultSigner } from "../src/canvas-share.js";
import { previewPlaceholder, previewReply, URL_REFRESH_MS, URL_RETRY_MS } from "../src/ui/preview-state.js";

const CO = "11111111-1111-4111-8111-111111111111";
const ids = Array.from({ length: 40 }, (_, i) => `asset-${i}`);

/** Studio settings with the R2 key as a secret ref, a counted secret lookup and one asset row per id. */
function fakeCtx(resolve: () => Promise<string>) {
  const secrets = { resolve: vi.fn(resolve) };
  const config = { get: vi.fn(async () => ({ r2: { accountId: "acct", bucket: "pib-private", accessKeyId: "AK", secretAccessKey: { type: "secret_ref", secretId: "sec-1" } } })) };
  const ctx = {
    config,
    secrets,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: {
      namespace: "plugin_studio_test",
      query: async (_sql: string, params: unknown[]) => {
        const id = String(params[1]);
        if (params[0] !== CO || id === "gone") return [];
        return [{ id, company_id: CO, kind: "image", current_version: 1, r2_key: `studio/${CO}/own/${id}/v1.png`, mime: "image/png" }];
      },
    },
  } as unknown as PluginContext;
  return { ctx, secrets, config };
}

describe("asset-urls: one secret lookup per request (PAR-8102)", () => {
  it("signs 40 previews with one settings read and one secret resolve", async () => {
    const { ctx, secrets, config } = fakeCtx(async () => "SK");
    const out = await assetUrlsForPerson(ctx, CO, ids);
    expect(secrets.resolve).toHaveBeenCalledTimes(1);
    expect(config.get).toHaveBeenCalledTimes(1);
    expect(Object.keys(out.urls)).toHaveLength(40);
    expect(out.urls["asset-7"]).toContain(`studio/${CO}/own/asset-7/v1.png`);
    expect(out).toMatchObject({ failed: [], error: null });
  });

  it("leaves a missing asset out quietly", async () => {
    const { ctx } = fakeCtx(async () => "SK");
    const out = await assetUrlsForPerson(ctx, CO, ["asset-1", "gone"]);
    expect(Object.keys(out.urls)).toEqual(["asset-1"]);
    expect(out.error).toBeNull();
  });

  it("reports a failed secret lookup instead of an empty answer, once", async () => {
    const { ctx, secrets } = fakeCtx(async () => {
      throw new Error("Rate limit exceeded for secret resolution");
    });
    const out = await assetUrlsForPerson(ctx, CO, ids);
    expect(secrets.resolve).toHaveBeenCalledTimes(1);
    expect(out.urls).toEqual({});
    expect(out.failed).toHaveLength(40);
    expect(out.error).toMatch(/^Previews couldn't load\./);
    // The host's message stays in the worker log, not on the page.
    expect(out.error).not.toMatch(/Rate limit/);
  });

  it("says when storage isn't set up", async () => {
    const { ctx } = fakeCtx(async () => "");
    const out = await assetUrlsForPerson(ctx, CO, ["asset-1"]);
    expect(out.error).toMatch(/not set up/);
  });

  it("does nothing for an empty list", async () => {
    const { ctx, secrets, config } = fakeCtx(async () => "SK");
    expect(await assetUrlsForPerson(ctx, CO, [])).toEqual({ urls: {}, failed: [], error: null });
    expect(secrets.resolve).not.toHaveBeenCalled();
    expect(config.get).not.toHaveBeenCalled();
  });
});

describe("share pages: one secret lookup per job run", () => {
  it("signs 40 cards with one resolve", async () => {
    const { ctx, secrets } = fakeCtx(async () => "SK");
    const sign = defaultSigner(ctx);
    const urls = await Promise.all(ids.map((id) => sign(CO, id)));
    expect(urls).toHaveLength(40);
    expect(secrets.resolve).toHaveBeenCalledTimes(1);
  });
});

describe("the page's reading of a reply", () => {
  it("renews links on the long timer when all came back", () => {
    expect(previewReply({ urls: { a: "u" }, failed: [], error: null })).toEqual({ urls: { a: "u" }, error: null, retryInMs: URL_REFRESH_MS });
  });

  it("retries soon and says so when links failed", () => {
    const out = previewReply({ urls: {}, failed: ["a"], error: "Previews couldn't load." });
    expect(out.retryInMs).toBe(URL_RETRY_MS);
    expect(out.error).toBe("Previews couldn't load.");
    expect(previewReply({ urls: {}, failed: ["a"] }).error).toMatch(/couldn't load/);
    expect(URL_RETRY_MS).toBeLessThan(URL_REFRESH_MS);
  });

  it("reads an old worker's bare reply as all fine", () => {
    expect(previewReply({ urls: {} }).retryInMs).toBe(URL_REFRESH_MS);
    expect(previewReply(null).urls).toEqual({});
  });

  it("cards say what happened instead of Loading forever", () => {
    expect(previewPlaceholder(null)).toBe("Loading preview…");
    expect(previewPlaceholder("Previews couldn't load.")).toMatch(/didn't load/);
  });
});
