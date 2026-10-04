/**
 * What a service call needs: the plugin context, the company, its settings, and the platform adapters. Production builds it with
 * `runtimeFor`; tests pass a mock provider and a fixed clock. Every service takes a runtime, so no service reaches for a global.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { adsConfigFrom, loadAdsConfig, type AdsConfig } from "./config.js";
import { AdsError } from "./domain.js";
import { realProvider } from "./providers/registry.js";
import type { AdsProvider, ProviderApp, ProviderEnv } from "./providers/types.js";
import type { StoredPlatform } from "./platforms.js";

/** The clock the services read. Production never touches it; tests move it so the worker's own handlers and the services agree on the time. */
export const clock = { now: (): Date => new Date() };

/** Which adapter serves a platform. Production never touches it; tests point it at a mock so the worker's own handlers use the mock too. */
export const providers: { resolve: (platform: StoredPlatform) => AdsProvider } = { resolve: realProvider };

export interface AdsRuntime {
  ctx: PluginContext;
  companyId: string;
  config: AdsConfig;
  provider(platform: StoredPlatform): AdsProvider;
  fetchImpl?: typeof fetch;
  now(): Date;
}

export async function runtimeFor(
  ctx: PluginContext,
  companyId: string,
  overrides: Partial<Pick<AdsRuntime, "provider" | "fetchImpl" | "now" | "config">> = {},
): Promise<AdsRuntime> {
  return {
    ctx,
    companyId,
    config: overrides.config ?? (await loadAdsConfig(ctx, companyId)),
    provider: overrides.provider ?? ((platform) => providers.resolve(platform)),
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    now: overrides.now ?? (() => clock.now()),
  };
}

/** For tests: a runtime on a config built from plain values. */
export function runtimeFromRaw(ctx: PluginContext, companyId: string, raw: Record<string, unknown>, overrides: Partial<Pick<AdsRuntime, "provider" | "fetchImpl" | "now">> = {}, uiBase: string | null = null): AdsRuntime {
  return { ctx, companyId, config: adsConfigFrom(ctx, companyId, raw, uiBase), provider: overrides.provider ?? ((platform) => providers.resolve(platform)), ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}), now: overrides.now ?? (() => clock.now()) };
}

/** The adapter's environment. The test platform has no app; a real platform must be switched on and complete (its refusal says what is missing). */
export async function providerEnv(rt: AdsRuntime, platform: StoredPlatform, options: { needRedirect?: boolean } = {}): Promise<ProviderEnv> {
  let redirectUri = "";
  try {
    redirectUri = rt.config.redirectUri();
  } catch (error) {
    if (options.needRedirect) throw new AdsError(error instanceof Error ? error.message : String(error));
  }
  if (platform === "mock") {
    if (!rt.config.platform("mock").enabled) throw new AdsError("The test platform is switched off in the plugin settings.");
    const app: ProviderApp = { platform: "meta", clientId: "", clientSecret: "" };
    return { app, redirectUri, ...(rt.fetchImpl ? { fetchImpl: rt.fetchImpl } : {}) };
  }
  let app: ProviderApp;
  try {
    app = await rt.config.app(platform);
  } catch (error) {
    throw new AdsError(error instanceof Error ? error.message : String(error), "platform_off");
  }
  return { app, redirectUri, ...(rt.fetchImpl ? { fetchImpl: rt.fetchImpl } : {}) };
}
