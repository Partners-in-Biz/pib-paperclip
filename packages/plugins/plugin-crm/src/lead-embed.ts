/**
 * What a person or agent installs on a client's site to take leads, built
 * from a lead source: the embed snippet, a curl example and a signed
 * server-to-server example. Pure text: no host calls.
 *
 * Why an embedded form and not a script that posts straight to the endpoint:
 * the host answers the public webhook without CORS headers, so a browser on
 * another site cannot POST to it. The form lives in an iframe served from the
 * Paperclip host itself (same origin as the endpoint); the snippet only adds
 * the iframe and passes the page's UTM tags and referrer to it.
 */
import { LEAD_ENDPOINT_KEY } from "./lead-form.js";
import { PLUGIN_ID } from "./namespace.js";

/** Where the lead script is served, and the endpoint it sends to. */
export interface EmbedUrls {
  /** `<origin>/_plugins/<installation uuid>/ui/lead.js` */
  scriptUrl: string;
  /** `<origin>/_plugins/<installation uuid>/ui/lead-form.html` */
  formUrl: string;
  /** `<origin>/api/plugins/partnersinbiz.crm/webhooks/lead` */
  endpointUrl: string;
  /** `<origin>/_plugins/<installation uuid>/ui/lead-example.html` */
  exampleUrl: string;
}

export const DEFAULT_PUBLIC_BASE = "https://paperclip.partnersinbiz.online";

/**
 * The addresses for this installation. `uiBase` is `/_plugins/<uuid>/ui/`, which
 * the CRM page reports the first time it is opened (kit `pluginUiBase`); without
 * it there is no static address yet and this returns null.
 */
export function embedUrls(publicBaseUrl: string | null | undefined, uiBase: string | null | undefined): EmbedUrls | null {
  if (!uiBase || !/^\/_plugins\/[0-9a-f-]{36}\/ui\/$/.test(uiBase)) return null;
  let origin = DEFAULT_PUBLIC_BASE;
  if (publicBaseUrl && publicBaseUrl.trim()) {
    try {
      origin = new URL(publicBaseUrl.trim()).origin;
    } catch {
      origin = DEFAULT_PUBLIC_BASE;
    }
  }
  return {
    scriptUrl: `${origin}${uiBase}lead.js`,
    formUrl: `${origin}${uiBase}lead-form.html`,
    endpointUrl: `${origin}/api/plugins/${PLUGIN_ID}/webhooks/${LEAD_ENDPOINT_KEY}`,
    exampleUrl: `${origin}${uiBase}lead-example.html`,
  };
}

/** What the snippet needs to know about a source. */
export interface EmbedSource {
  publicKey: string;
  label: string;
  consentText: string | null;
  privacyUrl: string | null;
  successMessage: string | null;
  turnstileSiteKey: string | null;
  /** The client's main brand colour (`#RRGGBB`) from the client profile: the form's buttons use it. */
  accent?: string | null;
}

/** The wording shown beside the marketing tick box when a source sets none. */
export const DEFAULT_CONSENT_TEXT = "Yes, you may email me news and offers. I can unsubscribe at any time.";

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The two lines to paste where the form should appear. */
export function leadSnippet(source: EmbedSource, urls: EmbedUrls): string {
  const attrs = [
    `data-pib-lead="${attr(source.publicKey)}"`,
    source.consentText ? `data-consent="${attr(source.consentText)}"` : null,
    source.privacyUrl ? `data-privacy="${attr(source.privacyUrl)}"` : null,
    source.successMessage ? `data-success="${attr(source.successMessage)}"` : null,
    source.turnstileSiteKey ? `data-turnstile="${attr(source.turnstileSiteKey)}"` : null,
    source.accent && /^#[0-9a-f]{6}$/i.test(source.accent) ? `data-accent="${attr(source.accent)}"` : null,
  ].filter((part): part is string => Boolean(part));
  return [`<!-- PiB lead form: ${attr(source.label).replace(/--/g, "- -")} -->`, `<script async src="${attr(urls.scriptUrl)}" ${attrs.join(" ")}></script>`].join("\n");
}

/** A request from a shell, to prove the endpoint answers. The address is a placeholder: use one you own. */
export function curlExample(source: Pick<EmbedSource, "publicKey">, urls: Pick<EmbedUrls, "endpointUrl">): string {
  const body = JSON.stringify({ key: source.publicKey, name: "Jane Smith", email: "jane@example.com", message: "Test enquiry", consent: false, utm: { source: "test" } });
  return [`curl -sS -X POST '${urls.endpointUrl}' \\`, `  -H 'content-type: application/json' \\`, `  -d '${body}'`].join("\n");
}

/** The same request, signed with the source's server secret (for the client's own server: WordPress PHP, a Next.js route). */
export function signedCurlExample(source: Pick<EmbedSource, "publicKey">, urls: Pick<EmbedUrls, "endpointUrl">): string {
  const body = JSON.stringify({ key: source.publicKey, name: "Jane Smith", email: "jane@example.com", message: "Test enquiry", visitorIp: "203.0.113.7" });
  return [
    `BODY='${body}'`,
    `TS=$(( $(date +%s) * 1000 ))`,
    `SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$PIB_LEAD_SECRET" -hex | sed 's/^.* //')`,
    `curl -sS -X POST '${urls.endpointUrl}' \\`,
    `  -H 'content-type: application/json' -H "X-PiB-Timestamp: $TS" -H "X-PiB-Signature: sha256=$SIG" \\`,
    `  -d "$BODY"`,
  ].join("\n");
}

/** The steps a person or agent follows to put a source live on a site. */
export function installSteps(source: EmbedSource, urls: EmbedUrls, site: string | null): string[] {
  return [
    `Paste this where the form should appear${site ? ` on ${site}` : ""} (a page's HTML, a theme template, or a Custom HTML block in WordPress):\n\n${leadSnippet(source, urls)}`,
    "A client's site is changed through its own repo project (a PR into the work branch) or by the client's developer, never by editing the live site by hand.",
    `Open the page, send one test enquiry with an address you own, and confirm it shows under Leads on the client's CRM page. A page that never loads the form blocks iframes: use the server example in the lead capture guide instead.`,
    `A copy of the form with placeholder values: ${urls.exampleUrl}`,
  ];
}
