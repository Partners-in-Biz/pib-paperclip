import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";
import { CANARY_REFERENCE, LEAD_CAPTURE_REFERENCE, NEW_CLIENT_REFERENCE, SERVICES_REFERENCE } from "./skills-references.js";
import { CARE_REFERENCE_FILES, CLIENT_CARE_SECTION } from "./skills-care.js";
import { GROWTH_REFERENCE_FILES, GROWTH_SECTION } from "./skills-growth.js";
import { DATA_STEWARD_SKILL, DEAL_DESK_SKILL, INBOUND_QUALIFY_SKILL, SALES_LEAD_SKILL } from "./skills-sales.js";
import { CLIENT_SITES_SKILL, IOS_RELEASE_SKILL } from "./skills-sites.js";

export const CRM_RECORDS_SKILL = `# CRM records and the client lifecycle

The CRM (\`partnersinbiz.crm\`) is the source of truth for clients. A client is a CRM company, or a contact with no company (a sole trader). Name it as \`company:<id>\` or \`contact:<id>\` everywhere, never by name alone; every module's client workspace uses that ref (\`?client=company:<id>\`). Our own work has no client. One client per task, except for a person who works for several companies (see below).

## Find the client first
- \`find-records\` by name, email, domain, phone or tag before you create anything. Create only when nothing matches, then link people to their company with \`link-contact\`.
- \`get-company\` / \`get-contact\` give the profile, people, open deals, the last 10 activities and \`workspaceLinks\` to each module's client workspace.
- \`get-client-profile\` says how to talk for the client (brand voice, audience, services they buy from a fixed list, website, booking link, banned words, tone) and holds their brand kit (logo key, colours, fonts, tone examples) and proposal references. Read it before you write anything for or to them.
- "Record is not visible": stop. Never invent a substitute record.

## A person who works for several companies
\`get-contact\` lists every company they are linked to (\`companies\`, each with its ref, role and lifecycle). Work for or to that person (an email, a call, a quote) draws on every one of those companies, not just the first:
1. For each company: \`get-company\` (profile, deals, activity), \`get-client-profile\` (voice, banned words) and \`partnersinbiz.cockpit:memory-recall\` with that \`company:<id>\` as \`client\`. Recall for the issue alone also covers all of them when the person's name is in the issue, but a call per company is the sure way.
2. Say which company each fact comes from. Never put one company's prices, deals, brand voice or private details into a message that is about another, and tell the person only what they are entitled to hear: a company's private details go only to someone who works there in a role that may know them.
3. Use the voice and banned words of the company the message is about. A message about several of them uses ours.
4. Log the result on the person (\`log-activity\`) and, when a lesson belongs to one company, save it with \`partnersinbiz.cockpit:memory-add\` and that company as \`client\`; the Learned: line of a closing comment files under only one of them.

## Keeping records
- Money is an integer in minor units plus a currency: R 1,500.00 is \`150000\` ZAR.
- Log calls, meetings and decisions with \`log-activity\` (add the \`issueId\`). Set the next step on the contact (nextActionKind and nextActionDueAt).
- A field a person owns keeps its value: fill it only while it is empty. A refused write is noted on the record; do not retry it.
- One record per person and company: the CRM refuses a second contact with the same email or phone (it updates the existing one) and a second company with the same website. Contacts that share an email are merged with \`merge-contacts\` (the Data Steward's job); likely but uncertain duplicates go to a person.
- New and changed clients reach the other modules within 15 minutes. If a module does not show a client yet, wait 15 minutes; do not ask anyone to resync.

A company's billing details (billingEmail, phone, address, vatNumber, registrationNumber on create-company / update-company) print in the Bill to block of its quotes and invoices, and a set billing email receives them. Fill them at onboarding from the signed proposal or ask the client; never guess a VAT or registration number. A person can lock them like any field.

## The client lifecycle
1. **Lead.** New person or company (lifecycle \`lead\`). Qualify: an owner-led business that needs what we sell, with budget and a reason to start soon. Not a fit: log why and set lifecycle \`churned\`.
2. **Qualified.** Set lifecycle \`prospect\` and \`create-deal\` with the value and the client. Fix a deal later with \`update-deal\` (title, value, its client, its stage): a deal without its client or value cannot be quoted, and the CRM overview lists it.
3. **Proposal.** Move the deal to the Proposal stage (\`list-stages\`, \`move-deal\`). Draft the quote in Billing (\`pib-invoice-draft\`) with the deal id, so the customer's acceptance closes the deal. A person approves sending.
4. **Won.** When the customer accepts, Billing tells the CRM and the deal moves to won; or move it yourself (\`move-deal\` to \`won\`). The CRM sets lifecycle \`customer\`, logs the win and tells Billing and the Cockpit. On a first win the Cockpit opens onboarding.
5. **Onboarding** (the Cockpit's onboarding issue on a first win). Fill the whole client profile (\`update-client-profile\`) from the proposal, your notes and their website, with the services they bought from the fixed list. Then open one hand-off issue per module for the role that owns it, titled \`Hand-off: <what> (company:<id>)\`: social accounts to connect (the owner does the logins), the SEO sprint, the retainer or first invoice, campaigns. Log each hand-off on the client. A service added to a customer later opens its own step (see Services below).
6. **Monthly client report** (the CRM opens it on the 1st, per customer): "Monthly report <client> <YYYY-MM>" arrives with the numbers gathered. Record what is missing, write the summary, \`send-client-report\` for approval, then close. Detail: \`references/client-report.md\`.
7. **Offboarding.** Set lifecycle \`churned\` (that stops their sequences), move open deals to lost, then open a hand-off issue for each module that still works for them (stop the SEO sprint, disconnect or pause social, end the retainer). Log it.

## Services, the brand kit and proposals
- **Services** are keys, not free text: seo, ads, social, campaigns, lead-capture, reporting, website, development, bookkeeping, payroll, branding, support. Wording you send is mapped when it can be and kept as text otherwise (the tool says which). When a customer's services change the CRM tells the other modules and opens one step per added service for the role that owns it, in the client's own project; closing it needs proof logged on the client. A prospect's services open nothing. Table and rules: \`references/services.md\`.
- **Brand kit** (\`update-client-profile\`): logoKey (an R2 key inside this company's folder, such as social/<company id>/logo.png: the CRM keeps the key only), primaryColor, secondaryColor, accentColor (hex), fonts, toneExamples (short pieces in their voice). Use them for anything made for the client.
- **Proposals** start from the client's scopeTemplateRef and termsRef (references to the scope template and the standard terms). A proposal, quote or agreement the client signs online goes through \`create-sign-document\` and \`send-for-signature\` (see Documents to sign below); a signed copy that came by email or in person a person logs on the client.

## Starting a new client
\`start-new-client\` (client, optionally projectId and services) links the project and returns what is still to do for the Delivery Lead and for you: project and git workspace, the development branch rule, the agent guide, website, lead form, brand kit, one step per service, one grant ask, billing. The project and repo are made by the ops tool new-client-project.py, which then calls \`crm.link-client-project\`. Details and the contract: \`references/new-client.md\`.

${CLIENT_CARE_SECTION}
${GROWTH_SECTION}
## The canary client
Acceptance runs use one internal test client (\`create-canary-client\`, \`cleanup-canary\`). Anything flagged canary is a draft or a dry run: no real send, post, invoice or payment, and its address ends @canary.invalid. Rules and the journey: \`references/canary.md\`.

## Leads from a client's own channels
A message to a client's own social account, mailbox or website form is that client's lead. The CRM keeps it on the client's page (Leads from their channels), never as our contact. Never add those people to our CRM, sequences or campaigns (POPIA); the client's work in Social answers them.

## Closing CRM issues
When you close an issue this module opened, it checks the work; if it reopens, it lists what's missing: finish those.
- **Link the won deal to its client:** the deal has a company or contact (\`update-deal\`).
- **Pick the deal for an accepted quote:** \`move-deal\` the deal it closes to won, with the issue's \`quoteId\`.
- **Start a service** (a step for a service a customer bought): proof logged on the client since the step opened (\`log-activity\` with the link or id).
- **A client's lead** (from the client's website form): something logged on the client since it came in, saying what you did with it.
- **Monthly report:** sent after a person approved it, or skipped with a reason.
- **Support case, or a missed target:** the case is answered (first response recorded) or resolved with what you did.
- **A client has not answered:** the outcome is recorded (\`update-client-action\`).
- **Churn risk, or an unhappy client:** your follow-up is logged on the client since the issue opened.
`;

export const CRM_OUTBOUND_SKILL = `# CRM outbound: leads, sequences and marketing email

## A lead came in
Social and the Mailbox hand leads to the CRM; each opens one "Follow up lead" issue for you with the message, the inbox item or Gmail message id and who replies.
- **Social DM or comment:** the Social agent replies in the Social inbox. Do not reply to it yourself.
- **Email:** you draft the reply in the Mailbox in the same thread (\`pib-mailbox-draft\`); a person approves sending.
- **Our website form:** the issue carries the phone, the message, the page and campaign tags, and whether they ticked the marketing box. Draft the reply to the address they gave. Ticked: they agreed to hear from us. Not ticked: write only about their enquiry.
- **A client's website form** is the client's lead, not ours: it is on the client's CRM page and the issue (in the client's project) says to check it is real, get it to the client in a Mailbox draft a person approves, and log it on the client. Never add that person to our contacts, sequences or campaigns.
- **Your part, within one working day:** qualify, \`log-activity\`, set the next action, \`create-deal\` when they want a quote, lifecycle \`prospect\` once qualified.

## Lead forms (taking enquiries from a website)
\`create-lead-endpoint\` makes a form for a client (or for us) and returns its snippet; \`list-lead-sources\` shows how each is doing and warns about one that never took a lead; \`rotate-lead-key\` swaps a key (the old one works 7 days); \`update-lead-source\` pauses, resumes or rewords a form (only a person switches one off for good). The snippet goes on the client's site through their repo project, never by hand on the live site. The marketing tick box is separate from the enquiry, starts unticked and must say who will email them. A signing secret for a client's own server is a credential: only a person makes it (Lead forms card), so put a Needs-you item on the client; you never see or ask for it. Spam protection, server requests and troubleshooting: \`references/lead-capture.md\`.

## Sequences
- Find one with \`list-sequences\`; \`enroll-contact\` once per contact per sequence.
- **Issue delivery:** each due step opens an issue for you with the step text. Do it, log it, then mark the issue done: that moves the contact on. For \`sent\` sequences mark it done only once the message really went out.
- **Email delivery:** the Mailbox sends each step once a person approved the sequence (\`set-sequence-delivery\` asks; you cannot approve it). Until then due steps wait and show in the Cockpit. If the person refuses, the steps come back to you as issues.
- A won or lost deal, an opt-out, a bounce or lifecycle \`churned\` stops a contact's sequences.
- **Replies** are sorted by Jev: interested or a question stop the sequence and give you a "Reply from" issue (answer from the Mailbox); not now sets an email next action in 30 days; unsubscribe and bounces suppress the address everywhere; out of office moves the next step 5 days. When Jev is unsure you get an issue to decide.

## Closing CRM issues
When you close an issue this module opened, it checks the work; if it reopens, it lists what's missing: finish those.
- **Lead follow-up:** something logged on them since the lead came in, plus a next action, a deal, or a lifecycle decision (prospect, or churned when not a fit).
- **Reply from / Check reply:** the answer logged (\`log-activity\`), or a decision recorded: a next action, a deal move, or \`set-email-status\`.
- **Sequence step:** the step logged on the contact; only then does closing move them to the next step.
- **Email not sent:** the address fixed, the contact reached and logged, or \`set-email-status\` bounced.
- An opt-out or a stopped sequence also counts as finished.

## Merge tokens
\`{{first_name}}\`, \`{{last_name}}\`, \`{{name}}\`, \`{{company}}\`, \`{{email}}\`. Add a fallback for empty values: \`{{first_name|there}}\`. An unknown token is sent as typed, so check the spelling.

## Every marketing email (sequences, campaigns, follow-ups you write)
- **POPIA:** email only people who agreed to hear from us, or existing clients about similar services we sell them. Never bought lists, never a client's leads.
- **Who we are:** say it is Partners in Biz and who is writing; use the sender the sequence or Mailbox sets.
- **Opt-out:** every email says how to stop, e.g. "Reply STOP and we won't email again."
- **An opt-out is final:** the moment someone asks to stop, by any channel, \`set-email-status\` unsubscribed. Never re-add or re-enroll them; only a person can allow email again.
- No claims we cannot back up, no pressure, no guarantees.
`;

function salesSkill(skillKey: string, slug: string, displayName: string, description: string, body: string): PluginManagedSkillDeclaration {
  return { skillKey, displayName, slug, description, markdown: withFrontmatter({ name: slug, description }, body) };
}

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: "crm-records",
    displayName: "CRM records",
    slug: "pib-crm-records",
    description: "Find clients, keep CRM records right, and run the client lifecycle from lead to offboarding.",
    markdown: withFrontmatter(
      { name: "pib-crm-records", description: "Find clients (company:<id> / contact:<id>), keep CRM records and client profiles right, and run the client lifecycle: lead, qualified, proposal, won, onboarding, monthly report, offboarding, and client care: support cases, requests to clients, health, privacy." },
      CRM_RECORDS_SKILL,
    ),
    files: [
      { path: "references/services.md", content: SERVICES_REFERENCE },
      { path: "references/new-client.md", content: NEW_CLIENT_REFERENCE },
      { path: "references/canary.md", content: CANARY_REFERENCE },
      ...CARE_REFERENCE_FILES.map((file) => ({ path: file.path, content: file.content })),
      ...GROWTH_REFERENCE_FILES.map((file) => ({ path: file.path, content: file.content })),
    ],
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
    files: [{ path: "references/lead-capture.md", content: LEAD_CAPTURE_REFERENCE }],
  },
  salesSkill("sales-lead", "pib-sales-lead", "Sales Lead", "Run the pipeline: chase stale deals, keep every open deal owned and moving, and write the weekly pipeline summary.", SALES_LEAD_SKILL),
  salesSkill("inbound-qualify", "pib-inbound-qualify", "Inbound qualifying", "Answer new leads the same day, qualify them (need, budget, timeline, decision maker) and hand qualified deals on.", INBOUND_QUALIFY_SKILL),
  salesSkill("data-steward", "pib-data-steward", "CRM data steward", "Keep one CRM record per person and company: merge exact duplicates, ask about likely ones, and report weekly on data hygiene.", DATA_STEWARD_SKILL),
  salesSkill("deal-desk", "pib-deal-desk", "Deal desk", "Turn qualified deals into quotes within the pricing guardrails, ask to send them, and handle quote replies.", DEAL_DESK_SKILL),
  {
    skillKey: "wp-sites",
    displayName: "Client websites (WordPress)",
    slug: "pib-wp-sites",
    description: "Client websites: the PiB Connector for WordPress SEO changes, pairing it over SFTP, and deploying our own WordPress plugins over SFTP with backup and rollback.",
    markdown: withFrontmatter(
      { name: "pib-wp-sites", description: "Work on client WordPress sites: PiB Connector tools (wp-seo, wp-schema, wp-redirects, wp-robots, wp-sitemap, wp-verify, undo), pairing the Connector over SFTP, and the SFTP deploy routine for our own plugins (backup, upload, sha256 readback, live check, rollback)." },
      CLIENT_SITES_SKILL,
    ),
  },
  {
    skillKey: "ios-release",
    displayName: "iOS releases (Mac build host)",
    slug: "pib-ios-release",
    description: "Build, sign and upload a client's native iOS app from the Mac build environment with xcodebuild and the asc CLI; App Review submission needs a person.",
    markdown: withFrontmatter(
      { name: "pib-ios-release", description: "Build and ship a client's native iOS app on the Mac build environment: check the host, pick the App Store Connect key, archive and export with API-key signing, upload to TestFlight with asc, and ask a person before submitting for review." },
      IOS_RELEASE_SKILL,
    ),
  },
];
