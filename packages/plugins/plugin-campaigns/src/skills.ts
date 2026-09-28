import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const CAMPAIGN_SKILL = `# Campaigns

Themed email programs for PiB's own marketing or a client's, with the \`partnersinbiz.campaigns\` tools. You build and run them; a person approves every launch.

## Scope
- Own work: omit \`client\`. Client work: \`client\` is \`company:<CRM id>\` or \`contact:<CRM id>\`, never a name. \`list-campaigns\` takes the same \`client\`. Client issue titles start with \`[Client name]\`.
- Find contacts, tags and clients with \`partnersinbiz.crm:find-records\`. New CRM contacts and clients reach Campaigns within 15 minutes. If one is "not found", wait 15 minutes and try again.

## Build
1. \`create-campaign\`: name, \`delivery\`, audience, \`client\`, optional \`startAt\` (no step is due before it).
2. \`add-campaign-step\` per email (subject, body, \`delayDays\` after the previous step). \`create-ab-variant\` adds a B version; \`set-step-html\` sets an HTML body.
3. \`request-campaign-approval\`.
- \`update-campaign\` edits a draft, including moving it to another client (or \`client: "own"\` for own work).
- Templates: \`create-campaign-template\`, \`list-campaign-templates\`, \`create-campaign-from-template\`.

## Audience
- \`audienceMode\`: \`tags\` (contacts with any of \`audienceTags\`), \`client_contacts\` (the people at the client company, narrowed by tags), \`client_contact\` (the client contact alone).
- Tags mode with no tags means **all CRM contacts**. It launches only when the approval says "All contacts (N)" and a person approves. Prefer tags.
- Unsubscribed and bounced addresses are never enrolled, emailed or given a step issue.
- \`enroll-contact\` adds one contact: only someone who fits the approved audience and agreed to hear from us.

## Writing the emails (POPIA)
For a client's campaign, read \`partnersinbiz.crm:get-client-profile\` first (brand voice, audience, banned words). Every email must:
- say who we are: the business name (the client's, for client work) and a real person;
- say why they get it (they are a client, asked about something, signed up);
- say how to opt out: "Reply STOP and we will not email you again." Email delivery also adds an unsubscribe header.
- make no claims we cannot back up, and use honest subjects.
Merge tokens: \`{{first_name}}\`, \`{{last_name}}\`, \`{{name}}\`, \`{{company}}\`, \`{{email}}\`. Add a fallback for a missing value: \`{{first_name|there}}\` gives "there". Use the fallback in greetings. A misspelt token is sent as typed.

## Approval and launch
- \`request-campaign-approval\` opens the approval issue with the audience and its count, delivery, start date and every step. With a Reviewer it checks first, comments PASS or CHANGES NEEDED and hands it to the person; nobody but a person marks it done.
- A person marks it **done**: the campaign launches by itself and a comment says how many were enrolled. If it cannot launch, the issue goes back to the person with the reason.
- A person **cancels** it: you get a "Revise campaign" issue. Read their comments, fix the draft, request approval again, then mark it done. Cancel the revise issue instead when they said to drop the campaign.
- Changing a draft after asking (steps, HTML, audience, sender, delivery, dates) cancels that approval (\`approvalReset: true\`). Request again.
- \`launch-campaign\` is only for a paused campaign (it enrolls audience contacts not in it yet) or an approved draft that has not launched.

## Running
- \`issue\` delivery: each due step opens an issue for you with the email filled in for that contact. Send it (\`partnersinbiz.mailbox:create-draft\`, then \`send-draft\` when your delegation allows), then mark the issue **done**: that moves them to the next step. **Cancel** the issue to stop the campaign for that contact.
- \`email\` delivery: the Mailbox sends each due step as marketing mail. A failed send opens "Email not sent" for you: fix the cause, send it yourself, then mark it done (or cancel to stop).
- \`pause-campaign\`, \`resume-campaign\`, \`complete-campaign\` control the whole campaign.

## Replies
- With Jev: interested or a question stops this campaign for them and opens "Reply from" for you: answer, then log it in the CRM. Not now stops it. Unsubscribe stops every campaign and adds the address to the do-not-email list. A bounce stops and suppresses. Out of office moves the next step 5 days.
- Jev unsure or not set up: "Check reply from" asks you to read it and choose: \`suppress-address\` (they want no more email), \`stop-enrollment\` (not now, or they want a person), or leave it running.
- Record what you did with \`log-reply\` (messageId from the issue, outcome \`answered\` with the mailDraftId, or \`no-reply-needed\` for an automatic reply), then mark the issue done.

## Closing your issues
When you close an issue this module opened, it checks the work; if it reopens, it lists what's missing: finish those.
- Step issue or "Email not sent": the contact moved on (closing it does that) or was stopped.
- "Revise campaign": the draft changed after the refusal and approval was asked again.
- A reply: answered or a decision logged with \`log-reply\`, the contact stopped, or the address suppressed.
- Waiting on a person (a question only the owner can answer)? Leave the issue blocked and say who must do what.

## Do-not-email list
- \`suppress-address\` records any opt-out you see anywhere ("stop", "remove me", a complaint) at once. It stops their campaigns and tells the CRM and the Mailbox. (\`partnersinbiz.crm:set-email-status\` does the same for a CRM contact.)
- The list is shared: opt-outs and hard bounces from the CRM and the Mailbox apply here too.

## Results
- \`campaign-stats\`, \`campaign-funnel\`, \`campaign-step-analytics\`. \`record-step-event\` only for an open or click from a real report; never estimate.
- A/B: \`suggest-ab-winner\` (20 sends per variant, else inconclusive). A person picks the winner: ask with the suggestion, then \`declare-ab-winner\`.

## Never
- Never mark an approval issue done, email a suppressed address, launch to all contacts without the approval saying so, invent numbers, or copy mailbox credentials into an issue.
`;
export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: "campaigns",
    displayName: "Campaigns",
    slug: "pib-campaigns",
    description: "Build, get approved and run email campaigns for PiB or a client, within POPIA.",
    markdown: withFrontmatter(
      { name: "pib-campaigns", description: "Build, get approved and run themed email campaigns for PiB or a client: audience, POPIA-safe copy, launch on approval, step issues, replies and the shared do-not-email list." },
      CAMPAIGN_SKILL,
    ),
  },
];
