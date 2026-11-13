# CRM Telephony

Paperclip plugin `partnersinbiz.crm-telephony`. Version 0.5.1 (the Twilio webhook tries only the companies the call may act for; PAR-11224).

Voice calls, SMS, and WhatsApp messaging integrated with CRM contacts. Secrets are managed exclusively through Paperclip's secrets system; they are never logged or persisted in plain text.

## Numbers (0.5.0)

The company's Twilio numbers are a list under **Numbers** on the Telephony settings page, not fixed secret names. Each entry: the E.164 number, a label ("PiB Cape Town", "US sales"), the regions it serves as country calling codes (27, 1, 44; a few ISO codes like ZA and US are accepted and converted), what it is for (voice, SMS, WhatsApp), enabled, and one default. A call or message to a lead uses the enabled number whose region matches the lead's calling code (longest match), else the default; with no match and no default it refuses with a message that names the settings page. The WhatsApp sender comes from the same list (purpose WhatsApp), falling back to the old "WhatsApp from" setting.

Migration: while a company has saved no numbers, the list is seeded once per read from the old secrets `TWILIO_ZA_NUMBER` (+27, voice and SMS, default), `TWILIO_US_NUMBER` (+1) and `TWILIO_WHATSAPP_FROM` (WhatsApp), and the Voice calling block says so. Press Save once on the Numbers section to keep them; after that the secrets are no longer read. The two number pickers were removed from the plugin's Configuration page.

## Calling from the browser (0.4.0)

The Dialer page (`/<company>/dialer?to=+27…&contactId=…`) places a real call through Twilio Voice:

1. The page asks the worker for a Twilio access token (`voice-token`, signed-in users on the **Voice user IDs** list only) and registers a Twilio `Device` with the user's id as identity.
2. The page calls `voice-dial`. The worker checks the company's calling hours, US calling hours (TCPA) for +1 numbers, the daily call cap, picks the caller ID from the Numbers list (the lead's region, else the default), finds the CRM contact that owns the number, writes the `tel_calls` row, and asks Twilio's REST API to ring the browser (`client:<user id>`) with inline TwiML that dials the contact from that caller ID.
3. Twilio rings the browser; the page accepts that leg, the contact's phone rings, and the page shows connecting, ringing, in call (with a timer and a hang-up button) and the outcome.
4. Twilio posts status callbacks to the `call-status` webhook for both legs. The worker updates the row (ringing, answered, busy, no answer, completed, duration) and, when the call ends, emits `call.noted` with a one-line summary and the duration, so the CRM logs a call activity on the contact and the sales desk counts it. When recording is on and R2 storage is filled in, the TwiML records from answer and the `recording-status` webhook feeds the media pipeline.

Why REST and not a TwiML app: the Paperclip host answers every plugin webhook with its own JSON body, so a plugin cannot return TwiML. The `voice-twiml` endpoint stays declared; a request there is verified and logged with a warning. `TWILIO_TWIML_APP_SID` is therefore optional.

### Setup (once per company)

1. **Company secrets** (Settings → Secrets): add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET` (Twilio console → Account → API keys & tokens → Create API key, Standard). The names are a convention; what matters is step 2.
2. **Plugin configuration** (Settings → Plugins → CRM Telephony → Configuration → Credentials): pick the secret for each field and save. This is the only way the host lets a plugin read a secret: it stores a secret reference at `secrets.<NAME>` with a binding, and `src/secrets.ts` resolves every credential through it. A bare secret name is refused by the host, so a secret that exists but is not picked here reads as Missing.
3. **Telephony settings** (the plugin's own page): add the company's Twilio numbers under **Numbers** (number, label, regions, purposes, one default), set the **Public base URL** (the address Twilio can reach, for example `https://paperclip.partnersinbiz.online`), add the user ids who may call under **Voice user IDs**, and save. The **Voice calling** block at the top lists what is still missing and the webhook addresses.

Nothing has to be pasted into the Twilio console: status and recording callbacks are set on each call. No TwiML app is needed.

### Tables

`tel_calls` holds one row per call (parent call SID, direction, from, to, status, started/answered/ended, duration, recorded). `tel_audit` records `voice.dial`, `voice.dial.blocked` (reason: outside_allowed_hours, outside_us_calling_hours, cap_reached, unsupported_region, caller_id_not_configured) and `voice.dial.failed`.

## Build and test

```
corepack pnpm typecheck && corepack pnpm test && corepack pnpm build
```

The `*.pg.spec.ts` tests start an embedded Postgres and skip where it cannot run.
