/** Reference pages that ship with the Campaigns skill (progressive disclosure: the skill names them, the agent opens one when it needs it). */

export const CHANNELS_REFERENCE = `# Channels: email, SMS, WhatsApp

## What goes out how
- A step's \`channel\` is \`email\` (default), \`sms\` or \`whatsapp\`. SMS and WhatsApp steps need the campaign's \`delivery\` set to \`auto\`: the plugin sends them itself, nobody can send a text by hand from an issue.
- Email goes through the Mailbox as marketing mail. SMS and WhatsApp go through the messaging provider (Twilio) that the company set up on the Setup page. A launch refuses a channel that is not configured, and the Cockpit shows an active campaign that cannot send.

## Who is texted (opt-in)
- SMS and WhatsApp marketing is opt-in. A person is enrolled in a text campaign only with: a mobile number on the CRM contact (a landline is skipped), an opt-in on record for this sender and channel, and no entry on the sender's do-not-message list.
- Record opt-ins with \`record-channel-consent\`: \`channel\`, \`contactIds\` or \`phones\`, \`client\` (whose list; own by default), \`basis\` (\`consent\`, or \`contract\` for an existing customer on SMS only; WhatsApp always needs consent), \`source\` and \`evidence\` (what they agreed to, where, when). The evidence is kept with the record. Never record an opt-in you did not see. \`granted: false\` records an opt-out.
- The CRM's \`consent.recorded\` events (SMS) arrive by themselves and count the same way.
- A later step on another channel is **skipped** for a contact it cannot reach (no number, no opt-in) and they move on; the campaign does not stop for them.

## Stopping
- STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT and sentences that plainly ask to stop ("stop texting me", "remove me", "do not message me") put the number on that sender's do-not-message list. Their running campaigns of that sender stop, open step issues are cancelled, and the CRM is told as a withdrawn consent. START and UNSTOP lift the person's own opt-out and record a new opt-in; HELP is answered by the provider. A number you blocked by hand stays blocked.
- Twilio also blocks a recipient who said STOP on its side (error 21610); the plugin sees that and records the opt-out.
- Use \`suppress-phone\` for an opt-out said any other way (a call, an email, a long reply).
- Replies are read every 10 minutes (the provider's message list). Any other reply opens a "Reply from" or "Check reply from" issue with the message in it. You cannot answer a text from here: reach the person another way and record it with \`log-reply\`.

## When it is sent
- Only inside the send window in the company's timezone: Mon-Fri 08:00-20:00, Sat 09:00-13:00, never Sunday (South African direct marketing rules); public holidays are blackout dates in the settings. A step that falls outside waits for the window to open.
- Every text ends with "Reply STOP to opt out." unless the step already tells the reader to send STOP (for example "Reply STOP to unsubscribe"). Copy that merely contains the word ("Stop paying too much", "next to the bus stop") still gets the line.

## Length
- SMS: 160 characters in one part (GSM-7); 153 per part when it is longer. A character outside GSM-7 (a curly quote, an emoji, many accented letters) makes the whole message UCS-2: 70, then 67 per part. Each part is billed, so preflight warns above 3 parts. The provider refuses over 1,600 characters.
- WhatsApp: 1,024 characters for a template body, 4,096 for a free-form message.

## WhatsApp templates
- A business-started WhatsApp conversation must open with a template Meta approved (Twilio Content Template Builder). Give the step \`templateRef\` (the Content SID, HX plus 32 characters) and \`templateVars\`: the merge tokens that fill the template's numbered variables in order, for example \`["{{first_name}}", "{{company}}"]\`. The template's own text must say how to opt out.
- A free-form WhatsApp step (no template) only reaches people who wrote to us in the last 24 hours; everyone else is refused by WhatsApp (error 63016) and the step is handed to a person.

## Never repeated
- A send whose result is unknown (the provider did not answer, or answered with a server error) is recorded as unknown and handed to a person, because a text cannot be taken back. Check the Twilio console (Monitor, Logs, Messaging) before doing anything. Only an answer that says "not accepted, try later" (429, 503) is retried, up to 5 times, ten minutes apart.
- A provider that refuses the account or sender leaves the step due and the Cockpit red; nothing is lost. After three provider failures in a row (no answer, a refused account, a rate limit) the plugin leaves the provider alone for ten minutes and the due steps wait, so an outage opens a few issues, not one per contact.
`;

export const SENDERS_REFERENCE = `# Who a campaign goes out as, and how people unsubscribe

## Sender identities
- A sender is \`own\` (PiB's marketing) or a client (\`company:<id>\` or \`contact:<id>\`). \`set-sender-identity\` gives a sender: \`fromAddress\` (an address the Mailbox sends from: a connected Gmail mailbox, or a send-only address on a verified sending domain of the email provider; the Mailbox refuses an address that is neither), \`fromName\`, \`replyTo\`, \`smsFrom\` and \`whatsappFrom\`. Omitted fields stay; an empty string clears one. \`remove-sender-identity\` removes it.
- The campaign's own \`fromName\` and \`replyTo\` override the identity's. \`fromLocal\` no longer chooses anything.
- Own marketing without an identity uses the Mailbox's default account. A client's marketing without an identity is refused at approval, at launch and at every send: it must never go out as PiB's Gmail or number. Getting the client a sending account is one of two one-time jobs: a Google sign-in by the client (their Gmail), or their sending domain's DNS records added by the owner or their web host (the Setup page lists both). A send-only address has no inbox: give the identity a \`replyTo\` somebody reads, and replies to it are matched to the campaign step by that mailbox and the address the email went to.
- Changing an identity cancels the open approval of that sender's drafts, because the approver saw the old one.

## The footer and the unsubscribe
- Every marketing email gets a footer: who sent it, an unsubscribe link and "reply STOP". When the plugin sends it the footer is added at send time; with \`issue\` delivery (and a failed send handed to you) the issue already ends with the same footer and the person's own link, to be sent as written. The link opens a page that asks the person to confirm (so a mail scanner opening it does not unsubscribe anyone) and records the opt-out for that sender only. A signed token in the link says whose list; it cannot be forged and unsubscribing twice is harmless.
- The one-click header (RFC 8058, \`List-Unsubscribe-Post\`) is added only once the operator has set up the front-door rule and saved the address; until then the footer link, the reply STOP and the Mailbox's mailto header still work, and preflight warns.
- The links need the public base URL in the settings and the Campaigns page opened once.

## Preflight
- \`preflight-campaign\` checks: every step has what it needs; a client has its own sender; each channel is configured; an unsubscribe link can be built (an error for a client's email); the sender's domain health when the Mailbox has reported it (SPF, DKIM, DMARC, and for a client's sending domain its bounce and complaint rates: bad is an error for a domain only the email provider sends from and a warning for a Gmail domain, unknown a warning; a domain held for its bounce or complaint rate stays blocked until a person lifts the hold on the Mailboxes page, so put it in one \`partnersinbiz.cockpit:ask-owner\` and do not look for a way round it); every link is https, not a test address, and answers (404 or an unknown host is an error, a site that blocks robots a warning); who can receive each channel.
- Fix errors with the tool the message names; warnings go to the approver.

## What the email provider reports, opens and clicks
- Campaigns does not track opens or clicks itself: a tracking pixel and redirect links need a public endpoint that answers a GET with an image or a redirect to a checked address, which the host cannot serve, and an unchecked redirect would be an open redirect.
- For email the email provider took (a client's sending domain), the Mailbox announces what became of each message and Campaigns records it per step: \`delivered\`, \`bounce\` (hard: the address is stopped for every sender), \`soft_bounce\`, \`complaint\` (the address leaves THIS client's marketing list), \`failed\`. Opens and clicks arrive only if somebody switched tracking on for the domain in the provider's dashboard (the Mailbox never does, and refuses a client's signing email through such a domain), and each is counted once per send. With the provider off none of this arrives and Campaigns works as before.
- Replies, bounces, unsubscribes and SMS delivery results are captured as well. If you have a real report from a link tracker, \`record-step-event\` stores it.
`;

export const PRIVACY_REFERENCE = `# Consent, erasure and retention (POPIA)

## What is kept
- Per sender: the do-not-email list (address, reason, when, source), the do-not-message list (phone number), SMS and WhatsApp opt-ins with their evidence, every SMS and WhatsApp message (number, text, provider id, status), enrollments, step events and reply logs.
- Issue titles and descriptions mention the contact by name; issue comments are written by agents and live in Paperclip.

## Erasure
- When a person asks to be erased, the CRM asks one person to approve, then sends the request to every plugin. Campaigns removes the person's enrollments, step events, reply log, mail send requests and text messages, their opt-in records, and the name and message text in their step, reply and failed-send issues (the issues stay, cancelled). Their do-not-contact entries stay as a one-way hash, so they are never emailed or texted again, and the issue comments agents wrote stay because a plugin cannot edit them. Both are reported back as kept, with the reason.
- You never erase by hand. If someone asks you to, tell the owner: erasure is irreversible and needs a person's approval first.
- A request limited to marketing only adds the opt-outs and stops the running campaigns.

## Consent
- A withdrawn consent from the CRM or another plugin puts the person on the do-not-contact list of the sender the event names: PiB's own marketing for an event with no client, or that one client's list. A client's unsubscribe never silences PiB or another client. Record opt-ins only from what you saw, with evidence.

## Webhook log
- The host keeps the headers and body of every delivery to the plugin's public webhooks in its own log (an unsubscribe token contains the address). The server operator prunes that log (the README says how).
`;
