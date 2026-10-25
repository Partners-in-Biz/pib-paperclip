# Public plugin endpoints: single-company scoping audit

Audited 2026-10-24 on `development` at 3b45448a3 (PAR-5155, Hosted clients phase 1, task 1.5). Read-only audit: no code changed.

## What is public

A plugin is public in **two** places, both reachable without a board session:

1. `POST /api/plugins/<plugin id>/webhooks/<endpointKey>`. The host hands the worker the raw body, parsed body and headers, and nothing else (no company, no caller).
2. `GET /_plugins/:pluginId/ui/*` (`server/src/routes/plugin-ui-static.ts:230`). It serves everything in a plugin's `dist/ui/` to anyone who knows the URL. The session check (`assertCompanyAccess`, `:291`) runs only if the request carries `?companyId=`.

Every `apiRoutes` entry is `auth: "board"` (`board-or-agent` in `plugin-llm-wiki`, and in an upstream example), so none of those is public. **Social** (client approval goes through issue approvals), **SEO** (previews are board UI; its routes `oauth-*` and `client-summary` are `board`) and **Partners** (no routes or webhooks; grants arrive through the CRM and Billing `/grants` board route) have no public route of their own beyond the OAuth callback pages below.

## Public static files (`dist/ui/`)

| File | Company-specific content? | Protection | Reach of someone who holds the URL |
|---|---|---|---|
| CRM `ui/s/<page id>.html` (`plugin-crm/src/esign-pages.ts:4-10`, `esign-link.ts:5`) | **Yes**: the rendered document (title, text, signer details, state). | The 24-character base32 page id (`esign-pages.ts:38-40`, 120 bits) is the read capability for that one document. | Reads that one document. Nothing about any other document or company. |
| CRM `ui/lead.js`, `lead-form.html`, `lead-example.html` (`lead-embed.ts:17-23`) | No. Generic script and form; the form key is passed by the embed snippet. | None needed. | Nothing company-specific. |
| CRM `ui/pib-connector.zip` (`plugin-crm/esbuild.config.mjs:9`, `sites.ts:394`) | No. Built from the bundled Connector, with no site keys. | None needed. | Nothing company-specific. |
| Campaigns `ui/unsubscribe.html` (`plugin-campaigns/esbuild.config.mjs:8,21`) | No. Static page; the signed token comes in the URL and is posted to the `unsubscribe` webhook. | Token (see table below). | Nothing. |
| `ui/oauth-callback.html` and `.js` for Ads, SEO, Mailbox, Social (`esbuild.config.mjs` of each) | No. Static; they pass the provider's code on to a board route (`oauth-complete`, `auth: "board"`). | Board session on the completing route. | Nothing. |

## One row per route

Webhooks. Columns: how the company is resolved, the ownership check, the bot/signature check, the rate limit, and what a holder of company A's key or link can do to company B.

| Plugin / endpoint | Company resolved by | Ownership check (file:line) | Signature / bot check | Rate limit | Cross-company reach (A holds the token) |
|---|---|---|---|---|---|
| CRM `lead` | Form key in the body → `lead_sources` row → `source.companyId` (`plugin-crm/src/lead-store.ts:185`, `lead-capture.ts:283`) | Every write after the lookup uses `source.companyId`; the client row is read with `row.companyId === companyId` (`lead-capture.ts:112`, `:293`); a dead client revokes the form (`:298-301`) | Honeypot and fill-time (`:323-324`), Turnstile when the source has a site key (`:327-331`), or HMAC with the source secret (`:311-318`) | Per source and per visitor hash (`:320`, `overLimit` defined at `:185`, hourly cap `:189`) | None. Key A only reaches the source it names. Rotated keys work 7 days, then `null` (`lead-store.ts:190`). |
| CRM `sign` | Page id in the body → `sign_documents` row → `doc.companyId` (`esign-public.ts:159`, `esign-store.ts:249`) | The document row is the only scope; all moves and events use `doc.companyId` (`esign-public.ts:192`, `:195`) | `view` needs the page id only (`:170`, `view()` at `:185-197`); `sign` and `decline` also need the signing token, checked against the document (`:214-217`) and a browser-origin check (`:210-211`) | Per visitor, per page and bad-token limits (`:122-129`, `SIGN_RATE` at `:52`); per-document attempts on sign and decline `:227-228` | None. A page id opens one document. Anyone holding the page id can mark it viewed and raise its view count (`:170`, write at `:192`, event `:195`): the view count and "viewed" state are not proof the signer saw it. |
| CRM `events` | Site event key in the body → `event_keys` row → `key.companyId` (`site-events.ts:175`) | Rollups are written with `key.companyId` (`:209`) | Origin allow-list (`:198`, spoofable by non-browsers; it limits mistakes, it is not authentication) | Per key and per visitor (`overLimit`, `site-events.ts:151-158`); unknown keys counted per visitor only (`:187-193`) | Counts only, into the key's own company. |
| Billing `stripe` | Delivery names our link id → `payment_links` row → `link.company_id` (`plugin-billing/src/pay/webhook.ts:70-76`, `store.ts:38`) | Invoice must match: `invoice.company_id !== link.company_id` is ignored (`pay/confirm.ts:92`, `:201`) | Stripe signature shape first (`webhook.ts:79-86`), then that company's own secret (`:87-96`) | No count; shape check and a one-minute secret cache (`pay/settings.ts:124,132`) stop a flood spending the host's secret resolves | None. A delivery signed with A's secret fails for B's link. |
| Billing `payfast` | `m_payment_id` → same link lookup | Same as above | Company's PayFast signature, source address and server confirmation (`webhook.ts:87-96`) | As above | None. |
| Campaigns `unsubscribe` | `c` claim in the unsigned token → that company's link secret (`plugin-campaigns/src/links.ts:126-146`) | `payload.companyId === companyId` after verifying with that company's secret (`:145`) | HMAC token; a bad token returns 200 and changes nothing (`webhook.ts:59-67`) | **None** (see finding 1) | None. A token signed for A fails B's secret. Writes go only to `payload.companyId`. |
| Campaigns `messaging-inbound` | `companyId` in the body (`inbound.ts:294`) | `configSaved` for that company, then everything keyed to that `companyId`; campaign must satisfy `campaign.companyId === companyId` (`inbound.ts:98`) | Shared secret header per company, constant-time, min 16 chars (`:297-301`) | **None** (finding 1) | Holding A's secret lets you post as A only. Naming B with A's secret is refused ("Not accepted."). |
| Mailbox `resend` | Svix signature checked against each candidate company's webhook secret; the `pib_company` tag only orders the tries (`plugin-mailbox/src/esp/webhook.ts:117-135`) | The company whose secret verifies is the company; `applyEspEvent` runs scoped to it (`:137-143`) | Svix shape and age first (`:114-115`), then HMAC (`:128`) | Size cap (`:113`); candidate list cached one minute (`:48`); refusals logged once a minute (`:52`) | None unless two companies **share one webhook secret**: the tag then decides the order and the first match wins (finding 2). |
| Mailbox `ses` | `TopicArn` and region must equal a company's saved SNS topic; with several matches the signed `pib_company` tag must pick one (`esp/sns.ts:323-350`) | Notification applied only to `matched` (`:350`); ambiguous or untagged is refused (`:340-352`) | AWS certificate URL pinned to the SNS host (`:312`), signature verified (`:377`) | Size cap (`:267`), miss re-read throttled 10 s (`:328-338`) | None for one topic per company. Two companies saving the same topic ARN fall back to the tag. |
| Mailbox `unsubscribe` | `c` claim in the unsigned token → that company's `unsubscribe.secret` (`plugin-mailbox/src/unsubscribe.ts:119-122`) | `payload.companyId !== companyId` is rejected (`:125`); suppression stored with that company id (`:132`) | HMAC token; always returns normally, nothing shown to the caller (`:115`, returns `:120-140`) | **None** (finding 1) | None. |
| CRM-telephony `wa-inbound`, `wa-status`, `recording-status` | Tries every company's `TWILIO_AUTH_TOKEN` until a signature verifies (`plugin-crm-telephony/src/company-resolve.ts:72-114`) | The verifying company is used for all writes (`whatsapp.ts:67`, `:199`, `recording-intake.ts:76`) | Twilio signature (`twilio-signature.ts`) | **None** (finding 3) | None while each company has its own auth token. `voice-twiml` and `call-status` are declared (`manifest.ts:52`, `:57`) but have no handler: they fall through and are acknowledged (`worker.ts:100`). |

## Findings (no cross-company read or write found)

1. **Unsigned company claim reaches a secret read, with no rate limit** (Campaigns `links.ts:138-141`, Mailbox `unsubscribe.ts:122`, Campaigns `inbound.ts:296-297`). Anyone can post a token whose `c` names any company id and make the plugin read that company's secret on every request. Billing and Mailbox `resend` already guard against this with a shape check and a one-minute cache, because the host allows 30 secret resolves a minute per company. Impact: availability only (a flood can burn a hosted client's secret-resolve budget and delay its own sends). Suggested fix: refuse tokens for company ids the plugin does not know and cache the resolved secret for a minute. Not changed here (three plugins, runtime behaviour, needs a stop-first decision from the Delivery Lead).
2. **Shared Resend signing secret.** If two companies save the same webhook secret, a delivery without a usable `pib_company` tag goes to the first candidate. Each hosted client must have its own Resend webhook (own secret). Add a check in Setup that no two companies save the same secret.
3. **Telephony tries every company's token per request** (`company-resolve.ts:82-105`): cost grows with the number of companies, and a flood spends every company's secret resolves. It has no shape check or cache. Telephony is not in the list of installed plugins in `PIB-GUIDE.md`; fix before it is installed for hosted clients.
4. **Turnstile fails open** (`lead-capture.ts:236-254`): if Cloudflare is unreachable or returns non-OK the lead passes (logged as `turnstile_unavailable`). Spam risk only; a missing secret is refused (`misconfigured`).

Follow-up tickets (availability findings are deferred, each tracked): see the list at the end of the PR description and on PAR-5155. Finding 1: Campaigns/Mailbox unsigned company claim; finding 3: Telephony company resolve; finding 4: Turnstile fail-open. Tickets: PAR-5167 (finding 1), PAR-5168 (finding 3), PAR-5169 (finding 4). Finding 2 is a Setup rule, no ticket yet.

## How to add a new public route safely

1. Prefer no public route. Use a board route (`auth: "board"` with `companyResolution`) and let the host check the session.
2. If it must be public, declare it in `webhooks` and treat the request as untrusted: the host gives you no company.
3. Resolve the company from a row you own, never from the request: a key, link or page id looked up in your own table (`row.companyId`), or the company whose saved secret verifies the signature. A `companyId` in the body or an unsigned token claim only says which secret to try first.
4. Use `row.companyId` for every later read and write. Where you load a second row (client, invoice, campaign), check it has the same company id (`row.companyId === companyId`) as the Billing and CRM code does.
5. Verify before you believe: signature or HMAC with that company's secret, constant-time compare, age window. Refuse malformed input before resolving any secret (the host allows 30 secret resolves a minute per company) and cache a resolved secret for a minute.
6. Rate-limit by key and by visitor hash (`countPublicHits` in the CRM); cap the body size; add Turnstile on forms that a browser posts.
7. Answer every refusal with one short sentence that does not say which check failed or whether a company exists. Never log the body, token or address.
8. Add a test that company A's key or secret cannot touch company B's row, and add a row to the table above with the file and line of each check.
9. Anything you put in `dist/ui/` is public to anyone who knows the URL (`plugin-ui-static.ts:230`). It must hold no company data unless the file name is an unguessable per-record id (like the CRM page id), and keys and page ids must be random and long.
10. A new `webhooks` entry or `capability` makes the release stop-first; say so in the PR.
