import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderHttpError } from "../src/oauth/http.js";
import { clearDestinationMetricsError, setDestinationMetricsError } from "../src/db.js";
import { fakeCtx } from "./helpers.js";

const providerMetrics = vi.fn();
vi.mock("../src/oauth/registry.js", () => ({ providerFor: () => ({ metrics: providerMetrics }) }));
vi.mock("../src/modules.js", () => ({ socialOn: async () => true }));
vi.mock("../src/config.js", () => ({ loadSocialConfig: async () => ({ saved: true, companyId: "co" }) }));
vi.mock("../src/accounts.js", () => ({ envFor: async () => ({}) }));
const freshAccount = vi.fn(async () => ({ id: "a1", meta: {} }));
vi.mock("../src/tokens.js", () => ({ freshAccount: (...a: unknown[]) => freshAccount(...(a as [])) }));

const { collectMetricsJob, sanitizeMetricsMessage } = await import("../src/metrics.js");

const publishedAt = new Date(Date.now() - 2 * 3600_000).toISOString();

function setup(platform: string, meta: Record<string, unknown> = {}, opts: { throwAccount?: boolean } = {}) {
  const dest = { id: "d1", company_id: "co", post_id: "p1", account_id: "a1", platform, external_id: "ext1", published_at: publishedAt, metric_windows: [] };
  return fakeCtx({}, {
    queryResult: (sql: string) => {
      if (sql.includes("FROM plugin_social_e70c4e79f2.accounts")) {
        if (opts.throwAccount) throw new Error("db down");
        return [{ id: "a1", token_enc: "x", status: "connected", meta }];
      }
      if (sql.includes("destinations")) return [dest];
      return [];
    },
  });
}
const writes = (ctx: ReturnType<typeof fakeCtx>) => ctx.fakeDb.executes;
const marked = (ctx: ReturnType<typeof fakeCtx>) => writes(ctx).filter((e) => e.sql.includes("metric_windows")).map((e) => JSON.parse(e.params[1] as string));
const errorWrites = (ctx: ReturnType<typeof fakeCtx>) => writes(ctx).filter((e) => e.sql.includes("jsonb_build_object('metricsError'"));

beforeEach(() => {
  providerMetrics.mockReset();
  freshAccount.mockClear();
});

describe("metrics error helpers", () => {
  it("set merges atomically without reading result", async () => {
    const ctx = fakeCtx();
    await setDestinationMetricsError(ctx, "d1", { at: "t", window: "1h", kind: "provider", status: 400, message: "m" });
    const [w] = ctx.fakeDb.executes;
    expect(w.sql).toContain("COALESCE(result, '{}'::jsonb) || jsonb_build_object('metricsError', $2::jsonb)");
    expect(w.params).toEqual(["d1", JSON.stringify({ at: "t", window: "1h", kind: "provider", status: 400, message: "m" })]);
    expect(ctx.fakeDb.queries).toHaveLength(0);
  });
  it("clear removes only the key and only when present", async () => {
    const ctx = fakeCtx();
    await clearDestinationMetricsError(ctx, "d1");
    expect(ctx.fakeDb.executes[0].sql).toContain("result - 'metricsError'");
    expect(ctx.fakeDb.executes[0].sql).toContain("result ? 'metricsError'");
    expect(ctx.fakeDb.executes[0].params).toEqual(["d1"]);
  });
});

describe("collect-metrics", () => {
  it("partial snapshot: inserts, persists insights error, does not mark the capture window", async () => {
    providerMetrics.mockResolvedValue({ views: 5, likes: 1, comments: 0, shares: 0, insightsError: "no impressions" });
    const ctx = setup("facebook");
    const summary = await collectMetricsJob(ctx, async () => undefined);
    expect(summary).toMatchObject({ partial: 1, captured: 0, errorsByPlatform: { facebook: 1 } });
    expect(writes(ctx).some((e) => e.sql.includes("INSERT INTO"))).toBe(true);
    expect(JSON.parse(errorWrites(ctx)[0].params[1] as string)).toMatchObject({ kind: "insights", window: "1h", message: "no impressions" });
    expect(marked(ctx).flat()).not.toContain("1h");
  });
  it("clean snapshot clears the error and marks the capture window", async () => {
    providerMetrics.mockResolvedValue({ views: 5, likes: 1, comments: 0, shares: 0 });
    const ctx = setup("facebook");
    const summary = await collectMetricsJob(ctx, async () => undefined);
    expect(summary.captured).toBe(1);
    expect(writes(ctx).some((e) => e.sql.includes("result - 'metricsError'"))).toBe(true);
    expect(marked(ctx).flat()).toContain("1h");
  });
  it("permanent provider error is persisted and marked", async () => {
    providerMetrics.mockRejectedValue(new ProviderHttpError(400, JSON.stringify({ error: { message: "bad https://x.test/p?access_token=SECRET" } })));
    const ctx = setup("facebook");
    const summary = await collectMetricsJob(ctx, async () => undefined);
    expect(summary).toMatchObject({ errors: 1, errorsByPlatform: { facebook: 1 } });
    const err = JSON.parse(errorWrites(ctx)[0].params[1] as string);
    expect(err).toMatchObject({ kind: "provider", status: 400 });
    expect(err.message).not.toContain("SECRET");
    expect(err.message).not.toContain("?");
    expect(marked(ctx).flat()).toContain("1h");
  });
  it("retryable provider error is persisted but not marked", async () => {
    providerMetrics.mockRejectedValue(new ProviderHttpError(503, "down"));
    const ctx = setup("facebook");
    await collectMetricsJob(ctx, async () => undefined);
    expect(errorWrites(ctx)).toHaveLength(1);
    expect(marked(ctx)).toHaveLength(0);
  });
  it("a throwing account read makes zero writes", async () => {
    const ctx = setup("facebook", {}, { throwAccount: true });
    await expect(collectMetricsJob(ctx, async () => undefined)).rejects.toThrow("db down");
    expect(writes(ctx)).toHaveLength(0);
    expect(providerMetrics).not.toHaveBeenCalled();
  });
  it("LinkedIn personal profile: no provider call, unsupported marker, all windows marked", async () => {
    const ctx = setup("linkedin", { kind: "person" });
    const summary = await collectMetricsJob(ctx, async () => undefined);
    expect(summary.skipped).toBe(1);
    expect(providerMetrics).not.toHaveBeenCalled();
    expect(freshAccount).not.toHaveBeenCalled();
    expect(JSON.parse(errorWrites(ctx)[0].params[1] as string)).toMatchObject({ kind: "unsupported", message: "LinkedIn personal-profile analytics are not available to this app" });
    expect(marked(ctx).flat()).toContain("1h");
  });
  it("LinkedIn organization still calls the provider", async () => {
    providerMetrics.mockResolvedValue({ views: 1, likes: 0, comments: 0, shares: 0 });
    const ctx = setup("linkedin", { kind: "organization" });
    await collectMetricsJob(ctx, async () => undefined);
    expect(providerMetrics).toHaveBeenCalledTimes(1);
  });
});

describe("sanitizeMetricsMessage", () => {
  it("strips query strings and token fragments", () => {
    const out = sanitizeMetricsMessage("GET https://graph.test/v1/x?access_token=abc&fields=id failed; access_token=zzz");
    expect(out).toContain("https://graph.test/v1/x");
    expect(out).not.toMatch(/abc|zzz|fields|\?/);
  });
});
