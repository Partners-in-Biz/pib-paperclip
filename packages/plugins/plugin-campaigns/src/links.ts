/**
 * Unsubscribe links and the footer every marketing message carries.
 *
 * - A link carries a token signed with a per-company secret (kit
 *   `signUnsubscribeToken`): who (company, address) and from whose list (the
 *   sender key). The secret is generated here and kept in the plugin's own state;
 *   nothing outside the plugin needs it, because Campaigns itself serves the
 *   landing page and records the opt-out.
 * - Two addresses can be built. The landing page is a static file the host
 *   serves publicly (`/_plugins/<uuid>/ui/unsubscribe.html?t=<token>`): the person
 *   confirms, and the page posts the token to the plugin's `unsubscribe` webhook.
 *   It needs `publicBaseUrl` and the plugin's UI address (known once the Campaigns
 *   page has been opened). The one-click address (RFC 8058) is where a mail
 *   client POSTs `List-Unsubscribe=One-Click` by itself; the host's webhook route
 *   cannot carry a per-person address, so a front-door rule has to forward
 *   `<oneClickUnsubscribeUrl>?t=<token>` to the webhook with the token in the
 *   `X-Unsubscribe-Token` header (README has the Caddy rule). Until that setting
 *   is saved the one-click header is not offered: a header that fails when a mail
 *   client posts to it is worse than none.
 */
import { randomBytes } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { pluginUiBase, readConfig, requirePublicBaseUrl, signUnsubscribeToken, verifyUnsubscribeToken, type UnsubscribePayload } from "@partnersinbiz/pib-plugin-kit";

const SECRET_STATE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "campaigns-links", stateKey: "unsubscribe-secret" });
const secrets = new Map<string, string>();

/**
 * The company's token secret. With `create: false` it never makes one (the
 * webhook uses that, so a stranger's token cannot start a secret for any
 * company). Null when there is none.
 */
export async function linkSecret(ctx: PluginContext, companyId: string, options: { create: boolean }): Promise<string | null> {
  const cached = secrets.get(companyId);
  if (cached) return cached;
  try {
    const stored = await ctx.state.get(SECRET_STATE(companyId));
    if (typeof stored === "string" && stored.length >= 32) {
      secrets.set(companyId, stored);
      return stored;
    }
    if (!options.create) return null;
    await ctx.state.set(SECRET_STATE(companyId), randomBytes(32).toString("hex"));
    // Two senders may race: whichever wrote last is the secret both then read.
    const final = await ctx.state.get(SECRET_STATE(companyId));
    if (typeof final === "string" && final.length >= 32) {
      secrets.set(companyId, final);
      return final;
    }
  } catch (error) {
    ctx.logger.info("The unsubscribe secret could not be read", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
  return null;
}

export function clearLinkCache(): void {
  secrets.clear();
  configCache.clear();
}

interface LinkConfig {
  publicBase: string | null;
  oneClick: string | null;
  uiBase: string | null;
}

const CONFIG_MS = 60_000;
const configCache = new Map<string, { at: number; value: LinkConfig }>();

/** The addresses the settings allow links to be built on (cached a minute). */
export async function linkConfig(ctx: PluginContext, companyId: string): Promise<LinkConfig> {
  const hit = configCache.get(companyId);
  if (hit && Date.now() - hit.at < CONFIG_MS) return hit.value;
  let publicBase: string | null = null;
  let oneClick: string | null = null;
  try {
    const config = await readConfig(ctx, companyId);
    try {
      publicBase = typeof config.publicBaseUrl === "string" && config.publicBaseUrl.trim() ? requirePublicBaseUrl(config.publicBaseUrl) : null;
    } catch {
      publicBase = null;
    }
    const raw = typeof config.oneClickUnsubscribeUrl === "string" ? config.oneClickUnsubscribeUrl.trim() : "";
    if (raw) {
      try {
        const url = new URL(raw);
        oneClick = url.protocol === "https:" ? url.toString() : null;
      } catch {
        oneClick = null;
      }
    }
  } catch {
    // no settings yet
  }
  const value: LinkConfig = { publicBase, oneClick, uiBase: await pluginUiBase(ctx) };
  configCache.set(companyId, { at: Date.now(), value });
  return value;
}

export interface UnsubscribeLinks {
  /** The page a person opens and confirms on, or null when it cannot be built yet. */
  landing: string | null;
  /** The RFC 8058 one-click address, or null while no front-door rule is saved. */
  oneClick: string | null;
}

/** Why a link cannot be built yet, for the preflight and Setup. Null when the landing page link works. */
export async function unsubscribeLinkProblem(ctx: PluginContext, companyId: string): Promise<string | null> {
  const config = await linkConfig(ctx, companyId);
  if (!config.publicBase) return "The public address is not set (Campaigns settings, Public base URL), so emails cannot carry an unsubscribe link.";
  if (!config.uiBase) return "Open the Campaigns page once so the plugin learns its public address; then unsubscribe links work.";
  return null;
}

export async function unsubscribeLinks(ctx: PluginContext, companyId: string, subject: { email: string; senderKey: string }): Promise<UnsubscribeLinks> {
  const config = await linkConfig(ctx, companyId);
  const secret = await linkSecret(ctx, companyId, { create: true });
  if (!secret) return { landing: null, oneClick: null };
  const token = signUnsubscribeToken({ companyId, email: subject.email, senderKey: subject.senderKey }, secret);
  const landing = config.publicBase && config.uiBase ? `${config.publicBase}${config.uiBase}unsubscribe.html?t=${encodeURIComponent(token)}` : null;
  const oneClick = config.oneClick ? `${config.oneClick}${config.oneClick.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}` : null;
  return { landing, oneClick };
}

/** The company id a token claims, read without checking the signature (only to find which secret to check it with). */
export function claimedCompany(token: string): string | null {
  const at = token.indexOf(".");
  if (at <= 0 || token.length > 2000) return null;
  try {
    const value = JSON.parse(Buffer.from(token.slice(0, at), "base64url").toString("utf8")) as { c?: unknown };
    return typeof value.c === "string" && value.c ? value.c : null;
  } catch {
    return null;
  }
}

/** The payload of a token signed by this company's secret, or null. */
export async function checkUnsubscribeToken(ctx: PluginContext, token: string): Promise<UnsubscribePayload | null> {
  const companyId = claimedCompany(token);
  if (!companyId) return null;
  const secret = await linkSecret(ctx, companyId, { create: false });
  if (!secret) return null;
  const payload = verifyUnsubscribeToken(token, secret);
  // A signature made for another company's secret never verifies, but check the claim matches too.
  return payload && payload.companyId === companyId ? payload : null;
}

// ---------------------------------------------------------------------------
// The footer
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface EmailFooter {
  text: string;
  html: string;
}

/** Who sent it and how to stop, appended to every marketing email (POPIA: say who we are and how to opt out). */
export function emailFooter(input: { senderName: string; link: string | null }): EmailFooter {
  const name = input.senderName.trim() || "us";
  const how = input.link ? `unsubscribe here: ${input.link} or reply STOP` : "reply STOP";
  const text = `\n\n--\nYou are getting this email from ${name}. To stop getting these emails, ${how}.`;
  const htmlHow = input.link ? `<a href="${escapeHtml(input.link)}">unsubscribe here</a> or reply STOP` : "reply STOP";
  const html = `<hr><p style="font-size:12px;color:#666666">You are getting this email from ${escapeHtml(name)}. To stop getting these emails, ${htmlHow}.</p>`;
  return { text, html };
}

/** The footer goes before the closing body tag of a designed email, else at the end. */
export function appendHtmlFooter(html: string, footerHtml: string): string {
  const close = /<\/body\s*>/i.exec(html);
  return close ? `${html.slice(0, close.index)}${footerHtml}${html.slice(close.index)}` : `${html}\n${footerHtml}`;
}

/** True when the email text already carries an unsubscribe link of its own (the {{unsubscribe_url}} token, or a written link). */
export function hasOwnUnsubscribe(template: string): boolean {
  return /\{\{\s*unsubscribe_url\b/i.test(template);
}

/** The links in a text or HTML body (http and https only), without duplicates, in order. */
export function extractLinks(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (!found.includes(url)) found.push(url);
  }
  return found;
}
