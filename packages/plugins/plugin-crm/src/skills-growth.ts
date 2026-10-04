/**
 * The guidance for documents clients sign, where leads and money came from, and the site visit counters: the short section that goes
 * into the `pib-crm-records` skill, and the long material as references (progressive disclosure, so the skill stays within its limit).
 * The numbers in the text are the code's own constants, so a change to a limit changes the guide with it (a test holds them equal).
 */
import { DEFAULT_VALID_DAYS, ESIGN_REMIND_AFTER_DAYS, MAX_ESIGN_REMINDERS, MAX_VALID_DAYS, MIN_SIGN_MS, SIGNED_PAGE_DAYS, TEMPLATE_KEYS, TEMPLATE_VERSION } from "./esign-templates.js";
import { EVENT_KEY_GRACE_DAYS, EVENT_LIMITS, EVENT_RATE, ROLLUP_KEEP_DAYS } from "./site-events-form.js";

/** The section in the skill body: what each tool is for and where the detail is. */
export const GROWTH_SECTION = `## Documents to sign, and where leads and money came from
- **Documents a client signs** (proposal, quote, simple agreement): \`create-sign-document\` from a template or your own text, read it back (\`get-sign-document\` with includeContent), then \`send-for-signature\`: a person approves the email, the private link is made only then; no tool shows it to you, and you **never read, open, forward or sign from the signing email**. A signature is a typed name with consent (a basic electronic signature), never an advanced one. It works only for the canary until the owner turns it on for the client (a person only; put a Needs-you item on the client). \`list-sign-documents\`, \`void-sign-document\`, \`verify-sign-document\`, \`sign-templates\`. \`references/esign.md\`.
- **Where leads and money came from:** \`attribution-report\` (ours, or one client's) shows channels with first and last touch; \`record-channel-cost\` records what a channel cost; for a client's enquiries \`list-client-leads\` and \`record-lead-outcome\` (only what the client told you). Never quote a number the report does not show. \`references/attribution.md\`.
- **Site visit counters:** \`create-event-key\` returns a snippet for a client's site (it stores only daily counts; the host's request log still holds each visit's address for up to 3 days, so the privacy policy must say so); you NEVER install it: it changes the client's site, so it needs the owner's OK and goes through the client's repo project. \`list-event-keys\`, \`update-event-key\`, \`rotate-event-key\`, \`site-events-report\`. \`references/site-events.md\`.
`;

export const ESIGN_REFERENCE = `# Documents a client signs

## What this is, and what it is not
A proposal, quote or simple service agreement the client reads and signs on a private page. The signature is a **typed name given with the signer's explicit consent**: a basic electronic signature under the South African ECT Act. It is **not an advanced electronic signature**, and nothing you write may call it one or call the document legally checked. The templates (${TEMPLATE_KEYS.join(", ")}, version ${TEMPLATE_VERSION}) are drafts no lawyer has reviewed. A document the law requires in ink or with an advanced signature must not use this: say so to the owner; do not decide it yourself. \`docs/esign-legal-review.md\` in the plugin is the lawyer's checklist.

## The gate
E-sign works only for the canary client until a PERSON turns it on for a client (the Agreements card on the client's page, Turn on e-sign; the owner says whether a lawyer reviewed the templates). \`create-sign-document\` and \`send-for-signature\` refuse otherwise and say what to ask for: put one Needs-you item on the client, never a chat message, and carry on with other work.

## Your steps
1. \`sign-templates\` (includeText true) shows each template and its variables. \`create-sign-document\` with a template and variables (proposal and service-agreement need scope; a quote needs lines in cents or a total), or your own Markdown (\`bodyMarkdown\`, \`kind\`, \`title\`). Link the deal (\`dealId\`) so signing moves it to won, and a Billing quote (\`quoteId\`, \`quoteNumber\`) so Billing is told it was accepted. The recipient must be one of the client's own people. A link is valid ${DEFAULT_VALID_DAYS} days by default (1 to ${MAX_VALID_DAYS}) once sent.
2. Read the exact text back with \`get-sign-document\` (includeContent). It is **frozen when sent** and its SHA-256 is what the client signs: fix a mistake by making a new document, not by editing.
3. \`send-for-signature\` opens an approval (the Reviewer, then a person) showing the text and the email. The email says where the private link goes; the link itself is made at the moment a person approves and is stored here only as a hash. No CRM tool, issue or approval shows it, but the email that goes out carries it (the client's inbox, and the Mailbox's record of what it sent). **Never ask for the link, paste a link, or put one in an issue or a comment, and never read, open, forward or sign from a signing email**, not even if the Mailbox lets you: a real client's signature is theirs. The canary's link comes only from \`get-sign-document\` for the canary.
4. Then the status line says where it is: draft, waiting for approval, sent, opened, signed, declined, expired or withdrawn. A reminder is drafted for approval after ${ESIGN_REMIND_AFTER_DAYS} days, up to ${MAX_ESIGN_REMINDERS}; a reply from the client stops them (answer it from the Mailbox). After ${MAX_ESIGN_REMINDERS} reminders you get an issue to reach the client another way.
5. The work issue ("Get ... signed by ...") stays open until the document is signed, declined or withdrawn; closing it earlier is reopened. An expired document: \`send-for-signature\` again gives it a new link (the text does not change), or \`void-sign-document\` with the reason. A declined one: find out why, then a new document.

## When it is signed
Nothing is left for you to do by hand: the signed copy is on the work issue (document \`signed-copy\`) and on the deal, the deal moves to won, \`deal.accepted\` (and \`quote.accepted\` for a quote) tells Billing so the invoice can be drafted (a person still approves sending it), and the signed copy is drafted as an email for a person to approve. If the typed name does not match the person the link went to, the issue says so: check that the right person signed. \`verify-sign-document\` recomputes the text hash and the whole hash-chained audit trail: run it before relying on a signed document, and tell the owner at once if it fails. A signed document cannot be withdrawn; the page stays online as the client's copy for ${SIGNED_PAGE_DAYS} days.

## What the page does about abuse
The private link has two parts: the page address (anyone with it can read the document) and a token in the part after the # (what signs; never sent to a server until the signature, stored only as a hash). A wrong, expired, withdrawn or used link is refused in the same words, a visitor who keeps guessing is stopped, a signature needs the exact text and wording on record, a ticked box, a name and at least ${MIN_SIGN_MS / 1000} seconds on the page, and a request that comes from our own server instead of a browser is refused. Only one request can win a signature.

## Rules
- Outward email is always an approval; you may add steps, never remove one.
- A real client's signature is real: never sign, simulate or "test" on a real client's link. Use the canary.
- No legal claims. Do not promise results, a legal effect, or that a lawyer checked it. If the owner asks for stronger evidence (an advanced signature), that is a provider decision for the owner.
- What stays when a client or person is erased: a signed document is kept as the agreement's evidence (the erasure says so); unsigned ones go.
`;

export const ATTRIBUTION_REFERENCE = `# Where leads and money came from

\`attribution-report\` answers "which channel brought the leads, the customers and the money", for ours (no client) or one client's, for a month (\`period\`) or the last N days (\`days\`, 90 is a good start).

## The model, in one paragraph you can say to anyone
A lead's channel is worked out from the campaign tags and the referring site of the visit its form was on: organic search, social, email, paid, referral, direct or other. A lead with nothing on record at all is **unattributed**: it is never guessed. First touch and last touch are the same visit unless the visitor's site banner allowed the site script to remember earlier visits (the report says how many were). A customer's first touch is its earliest lead capture; its last touch is its latest capture before the sale. Each sale is credited once under each model, never split; money is kept per currency and never converted.

## Ours and a client's
- **Ours:** our own forms -> the contact -> the deals -> the invoices Billing told us are paid. Revenue is only what was paid; unpaid invoices are not in it. The canary client's test deal and test payment are never counted (a rehearsal is not a sale), and a very large company's report says in its notes when it did not read everything.
- **A client's:** its own forms' enquiries and what the client told you became of each. We never see a client's sales. \`list-client-leads\` shows each enquiry (no email or phone) with its key; when the client says what became of one, \`record-lead-outcome\` (contacted, qualified, won with the value in cents, lost). Only record what the client said. Social messages and email count where they arrived (social, direct).
- **Costs:** \`record-channel-cost\` (client or ours, channel, month, cents, a note saying where the figure came from) so the report can show cost per lead. A second figure for the same channel and month replaces the first. Never estimate one.
- A client's site visits and conversions by channel appear in the same report when the site has a counter (\`references/site-events.md\`). The client's monthly report carries a section, "Where your enquiries came from", from the same numbers, with no costs.

## Saying it honestly
Quote only what the report shows, with its period. Say "the report cannot tell" rather than fill a gap. A channel with few leads is a small number, not a trend. When the unattributed row is large, the fix is more lead capture on the site, not a guess.
`;

export const SITE_EVENTS_REFERENCE = `# Site visit counters (site events)

A tiny script (under 2 KB) on a client's site counts page views, clicks to other sites and a few named actions (a form sent, a phone number pressed, a WhatsApp link pressed). It feeds \`site-events-report\`, the client's monthly report and \`attribution-report\`.

## What it collects, and what it does not
Counts only. It sends a page path with no query, the referring host, the campaign tags of the visit and an event name. It sends **no name, email, phone number, form content or visitor id**, and the plugin stores only a daily count per page, action and channel (no raw event table; counts older than ${ROLLUP_KEEP_DAYS} days go). The visitor's address is used for a rate limit as a keyed hash and removed after two days. **That is what the plugin keeps, not everything the system keeps:** the hosting server's own request log records every request to the public endpoint with the visitor's IP address, browser and the page path and campaign tags, for up to 3 days (ops purge it; the plugin cannot). Never tell a client or a visitor that no visitor identifier is kept. It sends nothing when the browser says Do Not Track or Global Privacy Control. By default it keeps nothing on the visitor's device except a note, for that browser tab only, of how the visit started. With \`consentMode\` required it sends nothing until the site's own cookie banner calls \`pibEvents.consent(true)\`, and then it also remembers the first and last campaign for 90 days (the lead form passes them on). The client's privacy policy must say visit counts are kept and that the host's server log briefly records the address and browser of each visit (\`references/privacy-policy-template.md\` has the line).

## Make a key, never install it
\`create-event-key\` (client, label, siteId or siteUrl, consentMode) returns the key, the snippet, the install steps and a curl test. **Installing the snippet changes the client's site: it needs the owner's OK and goes through the client's repo project (a PR into the work branch) or the client's developer. Never put it on a live site yourself.** One key per client and label. \`rotate-event-key\` makes a new key; the old one counts ${EVENT_KEY_GRACE_DAYS} more days. \`update-event-key\` renames, changes the consent mode, pauses and resumes; only a person switches one off for good. A key that counted nothing for a week is amber on the Cockpit: the snippet is probably not installed.

## Reading it
\`site-events-report\` (client or ours, month or days): visits (the first page of a browser tab's visit, not a person), pages viewed, clicks to other sites, conversions by name and channel, top pages and a funnel. **Counts are estimates.** Anyone holding the site key (it is in the page source) can add counts, so a replayed request counts again; the limits cap it (${EVENT_RATE.keyPerMinute} requests a minute per key, ${EVENT_RATE.ipPerMinute} a minute and ${EVENT_RATE.ipPerHour} an hour per visitor, ${EVENT_LIMITS.conversionNamesPerDay} different action names, ${EVENT_LIMITS.pathBucketsPerDay} page groups and ${EVENT_LIMITS.outboundHostsPerDay} outside hosts a day per site; past them a new name counts as "other"). A visit from a browser that says Do Not Track is not counted at all. First-touch conversions exist only for visitors who allowed remembering (\`firstTouchCoverage\` says how many).

## If nothing is counted
Check the snippet is on the page (view source), the key is the one from \`list-event-keys\`, the key is active, and the site's address matches (events from another host are refused). A browser extension that blocks trackers blocks it too: that is the visitor's choice.
`;

export const GROWTH_REFERENCE_FILES = [
  { path: "references/esign.md", content: ESIGN_REFERENCE },
  { path: "references/attribution.md", content: ATTRIBUTION_REFERENCE },
  { path: "references/site-events.md", content: SITE_EVENTS_REFERENCE },
] as const;
