import type { PluginContext } from "@paperclipai/plugin-sdk";
import { SecretResolver, requirePublicBaseUrl } from "@partnersinbiz/pib-plugin-kit";
import { AdsError } from "../domain.js";
import { WEB_ORG_SLUG, webBrokerConfigured, webBrokerUrlOf, webOrgIdOf, type WebBrokerSettingsView, webBrokerSettingsView } from "../config.js";
import { createWebBroker, type FetchLike, type WebBroker } from "./broker.js";

export async function webBrokerFor(ctx: PluginContext, companyId: string, raw: Record<string, unknown>, fetchFn: FetchLike = globalThis.fetch.bind(globalThis)): Promise<WebBroker> {
  if (!webBrokerConfigured(raw)) throw new AdsError("Ad connections are not configured. Save the web broker token and organization ID in the Paid ads plugin settings.");
  const secrets = new SecretResolver(ctx, companyId, raw);
  const token = await secrets.get("webBrokerToken");
  if (!token) throw new AdsError("The web broker token is not saved.");
  const orgId = webOrgIdOf(raw);
  if (!orgId) throw new AdsError("The web organization ID is not set.");
  return createWebBroker(fetchFn, { baseUrl: webBrokerUrlOf(raw), token, orgId, orgSlug: WEB_ORG_SLUG });
}

export async function webConnectionsReturnPath(ctx: PluginContext, companyId: string, publicBaseUrlRaw: unknown): Promise<string> {
  const publicBaseUrl = requirePublicBaseUrl(publicBaseUrlRaw).replace(/\/$/, "");
  const company = await ctx.companies.get(companyId);
  if (!company?.issuePrefix) throw new AdsError("This company's issue prefix is not known yet.");
  return `${publicBaseUrl}/${company.issuePrefix}/ads?tab=web-connections`;
}

export async function loadWebConnectionsMeta(ctx: PluginContext, companyId: string, raw: Record<string, unknown>): Promise<WebBrokerSettingsView & { configured: boolean; brokerReady: boolean }> {
  const view = webBrokerSettingsView(raw);
  return { ...view, configured: webBrokerConfigured(raw), brokerReady: webBrokerConfigured(raw) };
}
