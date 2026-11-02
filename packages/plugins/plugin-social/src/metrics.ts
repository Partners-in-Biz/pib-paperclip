/**
 * `collect-metrics` job (every 30 minutes): snapshots at +1h, +24h, +7d and
 * +30d after a destination published, for platforms whose API exposes
 * post metrics.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { envFor } from "./accounts.js";
import { loadSocialConfig, type SocialConfig } from "./config.js";
import {
  accountMeta,
  clearDestinationMetricsError,
  getAccount,
  insertMetrics,
  iso,
  markMetricWindows,
  publishedDestinationsForMetrics,
  setDestinationExternal,
  setDestinationMetricsError,
  type DestinationRow,
} from "./db.js";
import { dueMetricWindow } from "./domain.js";
import { ProviderHttpError, PublishRejected } from "./oauth/http.js";
import { providerFor } from "./oauth/registry.js";
import { socialOn } from "./modules.js";
import { isSocialPlatform } from "./platforms.js";
import { freshAccount } from "./tokens.js";

export const METRICS_PLATFORMS = ["facebook", "instagram", "threads", "linkedin", "x", "youtube", "tiktok", "pinterest", "reddit", "bluesky", "mastodon"];

/** Strip URL query strings and token fragments before a provider message is persisted. */
export function sanitizeMetricsMessage(message: string): string {
  return message
    .replace(/(access_token|refresh_token|token)=[^\s&"']*/gi, "")
    .replace(/(https?:\/\/[^\s?"']*)\?[^\s"']*/gi, "$1")
    .slice(0, 500);
}

type CollectResult = "captured" | "skipped" | "waiting" | "error" | "partial";

async function collectOne(ctx: PluginContext, config: SocialConfig, dest: DestinationRow & { platform: string }): Promise<CollectResult> {
  const decision = dueMetricWindow(iso(dest.published_at), dest.metric_windows ?? []);
  if (!decision.capture) {
    if (decision.skip.length) await markMetricWindows(ctx, dest.id, decision.skip);
    return "skipped";
  }
  if (!isSocialPlatform(dest.platform)) return "skipped";
  const provider = providerFor(dest.platform);
  if (!provider.metrics || !dest.external_id) {
    await markMetricWindows(ctx, dest.id, [...decision.skip, decision.capture]);
    return "skipped";
  }
  const row = await getAccount(ctx, config.companyId, dest.account_id);
  if (!row || !row.token_enc || row.status === "disabled") {
    await markMetricWindows(ctx, dest.id, [...decision.skip, decision.capture]);
    return "skipped";
  }
  const allWindows = [...decision.skip, decision.capture];
  if (dest.platform === "linkedin" && accountMeta(row).kind !== "organization") {
    await markMetricWindows(ctx, dest.id, allWindows);
    await setDestinationMetricsError(ctx, dest.id, { at: new Date().toISOString(), window: decision.capture, kind: "unsupported", message: "LinkedIn personal-profile analytics are not available to this app" });
    return "skipped";
  }
  try {
    const account = await freshAccount(ctx, config, row);
    const env = await envFor(config, dest.platform, account.meta);
    const snapshot = await provider.metrics(env, account, dest.external_id);
    if (!snapshot) {
      if (decision.capture === "30d") await markMetricWindows(ctx, dest.id, [...decision.skip, decision.capture]);
      return "waiting";
    }
    await insertMetrics(ctx, {
      companyId: config.companyId,
      postId: dest.post_id,
      destinationId: dest.id,
      accountId: dest.account_id,
      platform: dest.platform,
      window: decision.capture,
      views: snapshot.views,
      likes: snapshot.likes,
      comments: snapshot.comments,
      shares: snapshot.shares,
      impressions: snapshot.impressions ?? null,
      reach: snapshot.reach ?? null,
      saves: snapshot.saves ?? null,
      clicks: snapshot.clicks ?? null,
      raw: snapshot.raw,
    });
    if (snapshot.externalId && snapshot.externalId !== dest.external_id) {
      await setDestinationExternal(ctx, dest.id, snapshot.externalId, snapshot.url ?? null);
    }
    if (snapshot.insightsError) {
      await setDestinationMetricsError(ctx, dest.id, { at: new Date().toISOString(), window: decision.capture, kind: "insights", message: sanitizeMetricsMessage(snapshot.insightsError) });
      if (decision.skip.length) await markMetricWindows(ctx, dest.id, decision.skip);
      return "partial";
    }
    await clearDestinationMetricsError(ctx, dest.id);
    await markMetricWindows(ctx, dest.id, allWindows);
    return "captured";
  } catch (error) {
    const permanent = error instanceof PublishRejected || (error instanceof ProviderHttpError && !error.retryable && !error.tokenInvalid);
    const message = sanitizeMetricsMessage(error instanceof Error ? error.message : String(error));
    await setDestinationMetricsError(ctx, dest.id, {
      at: new Date().toISOString(), window: decision.capture, kind: "provider",
      ...(error instanceof ProviderHttpError ? { status: error.status } : {}), message,
    }).catch(() => undefined);
    if (permanent) await markMetricWindows(ctx, dest.id, [...decision.skip, decision.capture]);
    ctx.logger.info("Social metrics snapshot failed", { destinationId: dest.id, platform: dest.platform, error: message });
    return "error";
  }
}

export async function collectMetricsJob(ctx: PluginContext, ensureCompany: (companyId: string) => Promise<void>) {
  const summary = { captured: 0, partial: 0, skipped: 0, waiting: 0, errors: 0, errorsByPlatform: {} as Record<string, number> };
  const rows = await publishedDestinationsForMetrics(ctx);
  const byCompany = new Map<string, Array<DestinationRow & { platform: string }>>();
  for (const row of rows) byCompany.set(row.company_id, [...(byCompany.get(row.company_id) ?? []), row]);
  for (const [companyId, list] of byCompany) {
    if (!(await socialOn(ctx, companyId))) continue;
    await ensureCompany(companyId).catch(() => undefined);
    const config = await loadSocialConfig(ctx, companyId);
    if (!config.saved) continue;
    for (const dest of list) {
      const result = await collectOne(ctx, config, dest);
      if (result === "captured") summary.captured += 1;
      else if (result === "partial") {
        summary.partial += 1;
        summary.errorsByPlatform[dest.platform] = (summary.errorsByPlatform[dest.platform] ?? 0) + 1;
      } else if (result === "skipped") summary.skipped += 1;
      else if (result === "waiting") summary.waiting += 1;
      else {
        summary.errors += 1;
        summary.errorsByPlatform[dest.platform] = (summary.errorsByPlatform[dest.platform] ?? 0) + 1;
      }
    }
  }
  return summary;
}
