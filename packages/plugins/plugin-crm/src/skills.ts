import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const CRM_RECORDS_SKILL = `# CRM records and the client lifecycle

The CRM (\`partnersinbiz.crm\`) is the source of truth for clients. A client is a CRM company, or a contact with no company (a sole trader). Name it as \`company:<id>\` or \`contact:<id>\` everywhere, never by name alone; every module's client workspace uses that ref (\`?client=company:<id>\`). Our own work has no client. One client per task.

## Find the client first
- \`find-records\` by name, email, domain, phone or tag before you create anything. Create only when nothing matches, then link people to their company with \`link-contact\`.
- \`get-company\` / \`get-contact\` give the profile, people, open deals, the last 10 activities and \`workspaceLinks\` to each module's client workspace.
- \`get-client-profile\` says how to talk for the client (brand voice, audience, services they buy, website, booking link, banned words, tone). Read it before you write anything for or to them.
- "Record is not visible": stop. Never invent a substitute record.

## Keeping records
- Money is an integer in minor units plus a currency: R 1,500.00 is \`150000\` ZAR.
- Log calls, meetings and decisions with \`log-activity\` (add the \`issueId\`). Set the next step on the contact (nextActionKind and nextActionDueAt).
- A field a person owns keeps its value: fill it only while it is empty. A refused write is noted on the record; do not retry it.
- Merge duplicates only after a person confirmed they are the same person.
- New and changed clients reach the other modules within 15 minutes. If a module does not show a client yet, wait 15 minutes; do not ask anyone to resync.

## The client lifecycle
1. **Lead.** New person or company (lifecycle \`lead\`). Qualify: an owner-led business that needs what we sell, with budget and a reason to start soon.
2. **Qualified.** Set lifecycle \`prospect\` and \`create-deal\` with the value and the client. Fix a deal later with \`update-deal\` (title, value, its client, its stage): a deal without its client or value cannot be quoted, and the CRM overview lists it.
3. **Proposal.** Move the deal to the Proposal stage (\`list-stages\`, \`move-deal\`). Draft the quote in Billing (\`pib-invoice-draft\`) with the deal id, so the customer's acceptance closes the deal. A person approves sending.
4. **Won.** When the customer accepts, Billing tells the CRM and the deal moves to won; or move it yourself (\`move-deal\` to \`won\`). The CRM sets lifecycle \`customer\`, logs the win and tells Billing and the Cockpit. On a first win the Cockpit opens onboarding.
5. **Onboarding** (the Cockpit's onboarding issue). Fill the whole client profile (\`update-client-profile\`) from the proposal, your notes and their website. Then open one hand-off issue per module for the role that owns it, titled \`Hand-off: <what> (company:<id>)\`: social accounts to connect (the owner does the logins), the SEO sprint, the retainer or first invoice, campaigns. Log each hand-off on the client.
6. **Monthly client report** (first week of the month, per customer). For that client only, pull: Billing (invoices sent and paid, what is overdue), SEO (positions and the audit summary), Social (account analytics and the performance review), Campaigns (sends, opens, replies) and the CRM (deals, activity). Write 5-8 plain lines: results, what we did, what is next. Draft the email in the Mailbox for approval and log it on the client.
7. **Offboarding.** Set lifecycle \`churned\` (that stops their sequences), move open deals to lost, then open a hand-off issue for each module that still works for them (stop the SEO sprint, disconnect or pause social, end the retainer). Log it.

## Leads from a client's own channels
A message to a client's own social account or mailbox is that client's lead. The CRM keeps it on the client's page (Leads from their channels), never as our contact. Never add those people to our CRM, sequences or campaigns (POPIA); the client's work in Social answers them.
`;

export const CRM_OUTBOUND_SKILL = `# CRM outbound: leads, sequences and marketing email

## A lead came in
Social and the Mailbox hand leads to the CRM; each opens one "Follow up lead" issue for you with the message, the inbox item or Gmail message id and who replies.
- **Social DM or comment:** the Social agent replies in the Social inbox. Do not reply to it yourself.
- **Email:** you draft the reply in the Mailbox in the same thread (\`pib-mailbox-draft\`); a person approves sending.
- **Your part, within one working day:** qualify, \`log-activity\`, set the next action, \`create-deal\` when they want a quote, lifecycle \`prospect\` once qualified.

## Sequences
- Find one with \`list-sequences\`; \`enroll-contact\` once per contact per sequence.
- **Issue delivery:** each due step opens an issue for you with the step text. Do it, log it, then mark the issue done: that moves the contact on. For \`sent\` sequences mark it done only once the message really went out.
- **Email delivery:** the Mailbox sends each step once a person approved the sequence (\`set-sequence-delivery\` asks; you cannot approve it). Until then due steps wait and show in the Cockpit. If the person refuses, the steps come back to you as issues.
- A won or lost deal, an opt-out, a bounce or lifecycle \`churned\` stops a contact's sequences.
- **Replies** are sorted by Jev: interested or a question stop the sequence and give you a "Reply from" issue (answer from the Mailbox); not now sets an email next action in 30 days; unsubscribe and bounces suppress the address everywhere; out of office moves the next step 5 days. When Jev is unsure you get an issue to decide.

## Merge tokens
\`{{first_name}}\`, \`{{last_name}}\`, \`{{name}}\`, \`{{company}}\`, \`{{email}}\`. Add a fallback for empty values: \`{{first_name|there}}\`. An unknown token is sent as typed, so check the spelling.

## Every marketing email (sequences, campaigns, follow-ups you write)
- **POPIA:** email only people who agreed to hear from us, or existing clients about similar services we sell them. Never bought lists, never a client's leads.
- **Who we are:** say it is Partners in Biz and who is writing; use the sender the sequence or Mailbox sets.
- **Opt-out:** every email says how to stop, e.g. "Reply STOP and we won't email again."
- **An opt-out is final:** the moment someone asks to stop, by any channel, \`set-email-status\` unsubscribed. Never re-add or re-enroll them; only a person can allow email again.
- No claims we cannot back up, no pressure, no guarantees.
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: "crm-records",
    displayName: "CRM records",
    slug: "pib-crm-records",
    description: "Find clients, keep CRM records right, and run the client lifecycle from lead to offboarding.",
    markdown: withFrontmatter(
      { name: "pib-crm-records", description: "Find clients (company:<id> / contact:<id>), keep CRM records and client profiles right, and run the client lifecycle: lead, qualified, proposal, won, onboarding, monthly report, offboarding." },
      CRM_RECORDS_SKILL,
    ),
  },
  {
    skillKey: "crm-outbound",
    displayName: "CRM outbound",
    slug: "pib-crm-outbound",
    description: "Follow up leads, run sequences and replies, and keep every marketing email POPIA-safe.",
    markdown: withFrontmatter(
      { name: "pib-crm-outbound", description: "Follow up leads (who replies to what), run CRM sequences and replies, merge tokens, and the POPIA, opt-out and sender rules for every marketing email." },
      CRM_OUTBOUND_SKILL,
    ),
  },
];
