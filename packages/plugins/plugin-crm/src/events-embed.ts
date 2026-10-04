/**
 * What a person or agent gives a client's developer to count visits and conversions on a site, built from an event key.
 * Pure text: no host calls. The tools only RETURN this; nothing here installs anything on a client's site (that is a change to
 * the client's site, which goes through their repo project or their developer after the owner's OK).
 *
 * Why a script that talks to an iframe, like the lead form: the host answers the public endpoint with no CORS headers, so a
 * browser on another site cannot post to it directly. The script (`ev.js`, under 2 KB) adds one hidden iframe from the Paperclip host
 * (`ev-frame.html`) and hands it each event; the frame is on the endpoint's own origin, so it can post.
 */
import type { EmbedUrls } from "./lead-embed.js";
import type { ConsentMode } from "./site-events-form.js";

export interface EventUrls {
  scriptUrl: string;
  frameUrl: string;
  endpointUrl: string;
}

/** The addresses of the events script, its frame and the endpoint, from the lead form's (same installation, same origin). */
export function eventUrls(urls: EmbedUrls): EventUrls {
  return {
    scriptUrl: urls.scriptUrl.replace(/lead\.js$/, "ev.js"),
    frameUrl: urls.formUrl.replace(/lead-form\.html$/, "ev-frame.html"),
    endpointUrl: urls.endpointUrl.replace(/\/lead$/, "/ev"),
  };
}

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface EventSnippetSource {
  writeKey: string;
  label: string;
  consentMode: ConsentMode;
}

/** The two lines for the head or the end of the body of every page. */
export function eventSnippet(source: EventSnippetSource, urls: EventUrls): string {
  const attrs = [`data-pib-ev="${attr(source.writeKey)}"`, source.consentMode === "required" ? `data-consent="required"` : null].filter((part): part is string => Boolean(part));
  return [`<!-- PiB site events: ${attr(source.label).replace(/--/g, "- -")} (daily visit counts, no names or visitor ids) -->`, `<script async src="${attr(urls.scriptUrl)}" ${attrs.join(" ")}></script>`].join("\n");
}

/** What to tell the site's owner about privacy, in the words the site's policy needs. */
export const PRIVACY_NOTES: readonly string[] = [
  "The script counts page views, clicks to other sites, and a few named actions (a form sent, a phone number or WhatsApp link pressed). It sends no name, email, phone number, form content or visitor id, and the plugin stores only a daily count per page, action and source, plus a keyed hash of the visitor's address for 2 days to limit abuse.",
  "Say the rest plainly in the privacy policy: the hosting server's request log also records each request, with the visitor's IP address, browser and the page path, for up to 3 days (the plugin cannot change that log). So the daily totals are anonymous, but 'we keep no visitor identifier at all' is not true and must not be written.",
  "It sends nothing at all when the visitor's browser says Do Not Track or Global Privacy Control.",
  "By default it keeps nothing on the visitor's device except a note, for that browser tab only, of how the visit started. Add data-consent=\"required\" and it sends nothing until the site's own cookie banner calls pibEvents.consent(true); then it also remembers the first and last campaign for 90 days, so a conversion can be credited to the channel that first brought the visitor, and the lead form can say so.",
  "Say in the site's privacy policy that anonymous visit counts are kept (the privacy policy template in this skill has a line for it).",
];

/** The steps to put an event key live on a site. */
export function eventInstallSteps(source: EventSnippetSource, urls: EventUrls, site: string | null): string[] {
  return [
    `Put this in the head of every page${site ? ` on ${site}` : ""} (a theme header or layout file; in WordPress the theme's header or a header-scripts setting):\n\n${eventSnippet(source, urls)}`,
    "This changes the client's site. Do it through the client's repo project (a PR into the work branch) or give it to the client's developer, after the owner has said yes. Never edit the live site by hand and never install it yourself.",
    "Name an action yourself when the automatic ones are not enough: pibEvents.track('quote_requested'). Form submissions, tel: links, WhatsApp links and mailto: links are named automatically (form_submitted, call_clicked, whatsapp_clicked, email_clicked).",
    "Open a page, click around, and check the count under site-events-report for the client a few minutes later (the first events show as today's visits).",
    ...PRIVACY_NOTES,
  ];
}

/** A request from a shell, to prove the endpoint answers. */
export function eventCurlExample(source: Pick<EventSnippetSource, "writeKey">, urls: Pick<EventUrls, "endpointUrl">): string {
  const body = JSON.stringify({ k: source.writeKey, o: "https://example.co.za", ev: [{ t: "pv", p: "/", e: 1, v: { s: "test" } }] });
  return [`curl -sS -X POST '${urls.endpointUrl}' \\`, `  -H 'content-type: application/json' \\`, `  -d '${body}'`].join("\n");
}
