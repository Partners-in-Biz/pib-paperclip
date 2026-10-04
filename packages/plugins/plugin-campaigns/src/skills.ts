import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";
import { CHANNELS_REFERENCE, PRIVACY_REFERENCE, SENDERS_REFERENCE } from "./skill-references.js";

export const CAMPAIGN_SKILL = `# Campaigns

Themed email, SMS and WhatsApp programs for PiB's own marketing or a client's, with the \`partnersinbiz.campaigns\` tools. You build and run them; a person approves every launch.

## Scope
- Own work: omit \`client\`. Client work: \`client\` is \`company:<CRM id>\` or \`contact:<CRM id>\`, never a name. \`list-campaigns\` takes the same \`client\`. Client issue titles start with \`[Client name]\`, and a client's issues open in the client's own project.
- Find contacts, tags and clients with \`partnersinbiz.crm:find-records\`. New CRM contacts and clients reach Campaigns within 15 minutes. If one is "not found", wait 15 minutes and try again.

## Build
1. \`create-campaign\`: name, \`delivery\`, audience, \`client\`, optional \`startAt\` (no step is due before it).
2. For a client: \`set-sender-identity\` first (below).
3. \`add-campaign-step\` per message (\`channel\` email, sms or whatsapp; subject and body; \`delayDays\` after the previous step). \`create-ab-variant\` adds a B version; \`set-step-html\` sets an HTML body.
4. \`preflight-campaign\` and fix what it lists, then \`request-campaign-approval\`.
- \`update-campaign\` edits a draft, including moving it to another client (or \`client: "own"\` for own work).
- Templates: \`create-campaign-template\`, \`list-campaign-templates\`, \`create-campaign-from-template\`.
- \`delivery\`: \`issue\` (a task per step, you send it), \`email\` (the Mailbox sends each email) or \`auto\` (every step goes out by itself on its channel; SMS and WhatsApp need it).

## Who it goes out as
- Own marketing may use the Mailbox's default account. A **client's** campaign needs its own sender: \`set-sender-identity\` with \`client\`, \`fromAddress\` (a Gmail mailbox the client connected, or a send-only address on the client's sending domain: \`list-mailboxes\` shows both), \`fromName\`, \`replyTo\`, and \`smsFrom\` / \`whatsappFrom\` for texts. Without it the campaign cannot be approved or sent: it never goes out from PiB's Gmail or number. \`list-sender-identities\` shows what is set; \`remove-sender-identity\` removes one.
- The approver sees the real sender on the approval ("Sent as"). Details: references/senders-and-unsubscribe.md.

## Audience
- \`audienceMode\`: \`tags\` (contacts with any of \`audienceTags\`), \`client_contacts\` (the people at the client company, narrowed by tags), \`client_contact\` (the client contact alone).
- Tags mode with no tags means **all CRM contacts**. It launches only when the approval says "All contacts (N)" and a person approves. Prefer tags.
- Unsubscribed and bounced addresses are never enrolled, emailed or given a step issue. The do-not-email list is **per sender**: someone who unsubscribed from a client's list can still get PiB's own or another client's mail; a hard bounce stops every sender.
- \`enroll-contact\` adds one contact: only someone who fits the approved audience and agreed to hear from us.

## Writing the emails (POPIA)
For a client's campaign, read \`partnersinbiz.crm:get-client-profile\` first (brand voice, audience, banned words). Every email must:
- say who we are: the business name (the client's, for client work) and a real person;
- say why they get it (they are a client, asked about something, signed up);
- make no claims we cannot back up, and use honest subjects.
The plugin adds a footer to every email: who sent it, the person's own unsubscribe link and "reply STOP". With \`email\` or \`auto\` delivery it adds it when it sends (and the unsubscribe header too); with \`issue\` delivery the step issue you get already ends with it, so send the text as written and never cut it. Do not write your own opt-out line in the step text.
Merge tokens: \`{{first_name}}\`, \`{{last_name}}\`, \`{{name}}\`, \`{{company}}\`, \`{{email}}\`, \`{{unsubscribe_url}}\`. Add a fallback for a missing value: \`{{first_name|there}}\` gives "there". Use the fallback in greetings. A misspelt token is sent as typed.

## SMS and WhatsApp
- Opt-in only: a person is texted only with an opt-in on record for that sender and channel. Record what you saw with \`record-channel-consent\` (evidence required; never record an opt-in you did not see). Without opt-ins the approval says nobody can receive it.
- Texts go out only inside the send window (Mon-Fri 08:00-20:00, Sat 09:00-13:00, never Sunday), always say "Reply STOP to opt out." (added unless the text already tells them to reply STOP), and a STOP word stops that sender's campaigns for the person at once. Use \`suppress-phone\` for an opt-out said any other way.
- WhatsApp first messages need an approved template: \`templateRef\` and \`templateVars\`. Keep SMS under 3 parts; a smart quote or emoji makes it 70 characters a part.
- A launch refuses a channel that is not set up (Twilio on the Setup page, which only a person can create). Details and limits: references/channels.md.

## Approval and launch
- \`preflight-campaign\` runs the checks an approval request runs: every step complete, a client sender, a configured channel, the unsubscribe, the sender's domain health, working links, and who can receive each channel. Errors block the request; warnings go to the approver.
- \`request-campaign-approval\` opens the approval issue with the audience and its count, delivery, who it goes out as, start date and every step. With a Reviewer it checks first, comments PASS or CHANGES NEEDED and hands it to the person; nobody but a person marks it done.
- A person marks it **done**: the campaign launches by itself and a comment says how many were enrolled. If it cannot launch, the issue goes back to the person with the reason.
- A person **cancels** it: you get a "Revise campaign" issue. Read their comments, fix the draft, request approval again, then mark it done. Cancel the revise issue instead when they said to drop the campaign.
- Changing a draft after asking (steps, HTML, audience, sender, delivery, dates) cancels that approval (\`approvalReset: true\`). Request again.
- \`launch-campaign\` is only for a paused campaign (it enrolls audience contacts not in it yet) or an approved draft that has not launched.

## Running
- \`issue\` delivery: each due step opens an issue for you with the email filled in for that contact, ending with who we are and their own unsubscribe link (the footer): send it whole. Send it (\`partnersinbiz.mailbox:create-draft\`, then \`send-draft\` when your delegation allows), then mark the issue **done**: that moves them to the next step. **Cancel** the issue to stop the campaign for that contact.
- \`email\` and \`auto\` delivery: the plugin sends each due step. A failed send opens "Email not sent" (or "SMS not sent") for you: fix the cause, then mark it done (or cancel to stop). An SMS or WhatsApp result that is unknown is never repeated by itself: check the Twilio log first.
- \`pause-campaign\`, \`resume-campaign\`, \`complete-campaign\` control the whole campaign.

## Replies
- With Jev: interested or a question stops this campaign for them and opens "Reply from" for you: answer, then log it in the CRM. Not now stops it. Unsubscribe stops that sender's campaigns and adds the address to the do-not-email list. A bounce stops and suppresses. Out of office moves the next step 5 days.
- Jev unsure or not set up: "Check reply from" asks you to read it and choose: \`suppress-address\` (they want no more email), \`stop-enrollment\` (not now, or they want a person), or leave it running.
- A text reply opens the same issue with the message in it. You cannot answer a text from here: call or email them, then record it.
- Record what you did with \`log-reply\` (messageId from the issue, outcome \`answered\` with the mailDraftId, or \`no-reply-needed\` for an automatic reply), then mark the issue done.

## Closing your issues
When you close an issue this module opened, it checks the work; if it reopens, it lists what's missing: finish those.
- Step issue or "Email not sent": the contact moved on (closing it does that) or was stopped.
- "Revise campaign": the draft changed after the refusal and approval was asked again.
- A reply: answered or a decision logged with \`log-reply\`, the contact stopped, or the address suppressed.
- Waiting on a person (a question only the owner can answer)? Leave the issue blocked and say who must do what.

## Do-not-email and do-not-message lists
- \`suppress-address\` records any opt-out you see anywhere ("stop", "remove me", a complaint) at once. Pass \`client\` for the sender they unsubscribed from; without it the opt-out is for every sender. It stops their campaigns and tells the CRM and the Mailbox. (\`partnersinbiz.crm:set-email-status\` does the same for a CRM contact.)
- \`suppress-phone\` is the same for SMS and WhatsApp.
- Opt-outs and hard bounces from the CRM and the Mailbox apply here too. A person's erasure request removes their campaign data (references/privacy.md).

## Results
- \`campaign-stats\`, \`campaign-funnel\`, \`campaign-step-analytics\` (per step: sent, delivered, replies, hard and soft bounces, complaints, unsubscribes, opens, clicks). \`record-step-event\` only for an open or click from a real report; never estimate. Replies, bounces, unsubscribes and SMS delivery are captured; for email through the email provider so are delivered, soft bounces, complaints and, only when tracking is on for the sending domain at the provider, opens and clicks (nothing here switches tracking on).
- A/B: \`suggest-ab-winner\` (20 sends per variant, else inconclusive). A person picks the winner: ask with the suggestion, then \`declare-ab-winner\`.

## Never
- Never mark an approval issue done, email or text a suppressed address, text anyone without a recorded opt-in, send a client's message as PiB, launch to all contacts without the approval saying so, invent numbers, or copy mailbox credentials or the Twilio token into an issue.
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: "campaigns",
    displayName: "Campaigns",
    slug: "pib-campaigns",
    description: "Build, get approved and run email campaigns for PiB or a client, within POPIA.",
    markdown: withFrontmatter(
      { name: "pib-campaigns", description: "Build, get approved and run themed email, SMS and WhatsApp campaigns for PiB or a client: sender identity, audience, POPIA-safe copy, opt-ins, launch on approval, step issues, replies and the per-sender do-not-contact lists." },
      CAMPAIGN_SKILL,
    ),
    files: [
      { path: "references/channels.md", content: CHANNELS_REFERENCE },
      { path: "references/senders-and-unsubscribe.md", content: SENDERS_REFERENCE },
      { path: "references/privacy.md", content: PRIVACY_REFERENCE },
    ],
  },
];
