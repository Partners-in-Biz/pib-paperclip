/**
 * The client care guidance the Account Manager reads: the short section that goes into the
 * `pib-crm-records` skill, and the long material as references (progressive disclosure, so the
 * skill stays within its size limit).
 */

/** The section in the skill body: what each care tool is for and where the detail is. */
export const CLIENT_CARE_SECTION = `## Client care
- **Monthly report.** On the 1st the CRM opens "Monthly report <client> <YYYY-MM>" with the numbers already gathered. Record what is missing (\`record-client-signal\`), write the summary (\`set-report-narrative\`), then \`send-client-report\`: the email goes to a person for approval. \`skip-client-report\` with a reason when there is nothing to report. \`references/client-report.md\`.
- **Support.** Mail the Mailbox sorts as support becomes a case for a customer; anything else, \`open-support-case\`. Keep it current with \`update-support-case\` (first response, waiting_client, resolved with what you did). A missed target opens an issue for you. After a case is resolved, \`request-feedback\` (a person approves). \`list-support-cases\`. \`references/support-and-health.md\`.
- **Asking a client to do something** (sign off a preview, give access, approve, send information): \`create-client-action\` with the exact https link the client opens, never a board page. A person approves the email, the request then waits on the client, a reminder is drafted for approval after 3 days, and after two you get an issue to reach them another way. Record the outcome with \`update-client-action\`. \`list-client-actions\`. \`references/client-requests.md\`.
- **Health.** \`client-health\` scores a customer 0 to 100 from support, reply speed, invoices, SEO, uptime and how they answer us. A churn-risk issue means act within a working day. \`references/support-and-health.md\`.
- **Privacy.** \`record-consent\` (basis and wording), \`export-person-data\`, \`request-erasure\` (a person approves; never erase anything yourself), \`set-client-sensitivity\`, \`list-data-processing\`. \`references/privacy.md\`. Policy, terms and cookie drafts start from \`references/privacy-policy-template.md\`, \`references/terms-template.md\` and \`references/cookie-notice-template.md\`.
- A site that is down, a certificate or a domain about to expire goes to the Delivery Lead as an issue; \`site-monitoring\` shows a client's sites.
`;

export const CLIENT_REPORT_REFERENCE = `# The monthly client report

On the 1st at 06:00 (South African time) the CRM opens one issue per customer worth reporting on: "Monthly report <client> <YYYY-MM>", for you, in the client's own project. A customer with a service on its profile always gets one; one with no service only when the month has something in it (numbers a module sent or you recorded, a support case, an enquiry, a payment, or work closed in its project), so a client with nothing to say gets no issue (and if something arrives later in the first days of the month, the issue opens then). Its description lists what is in the report and what is missing; the working copy is the **report** document on the issue. Nothing here is typed by hand: you use the tools, and the document is **replaced** from them each time you build, so never edit it (an edit is lost on the next build).

## What is gathered for you
- The CRM's own records: support cases and their targets, enquiries from the client's website forms, uptime, certificate and domain, invoices the CRM was told were paid, calls and emails logged, requests still waiting on the client.
- What the other modules send (\`client.signal\`): SEO, Social, Campaigns, Billing, the Mailbox. Each shows as "sent by the module".
- Internal only, never in the client's copy: the tasks closed in the client's project, their notional effort (agent compute), the health score.

## Your steps
1. Read the issue. For each module it lists as missing, read that module for this client and month, then \`record-client-signal\` (module, period, a few headline numbers with the change on last month, a few plain bullets). Leave a module out when the client does not use it.
   - SEO: \`get-sprint\`, \`list-keywords\`, \`keyword-history\`, \`gsc-query\`, \`audit-summary\`, \`list-ga4-summary\`. Record clicks, impressions, positions gained, tasks done. Put the sprint health (0 to 100) in \`health.score\` with no period too: the health score reads it.
   - Social: \`list-posts\`, \`account-analytics\`, \`post-analytics\`, \`performance-review\`: posts published, engagement, followers, the best post.
   - Campaigns: \`list-campaigns\`, \`campaign-stats\`: sends, opens, clicks, replies.
   - Billing: \`list-open-invoices\`, \`billing-report\`, \`invoice-detail\`: invoices sent and paid, what is overdue (put \`overdueCount\` in \`health\` with no period too).
   - Mailbox: \`list-threads\`, \`mail-status\`: how many messages, how fast we answered.
2. \`build-client-report\` pulls the new numbers in. It is safe to run again; \`dryRun\` true shows the result without storing it. A report that was sent is never rewritten.
3. \`set-report-narrative\`: the summary (3 to 5 plain sentences on how the month went, honest about a bad one), the highlights the client will care about, and what happens next month. Say "more people found you on Google", not "improved SERP CTR". Never paste ticket titles, costs or agent names. Do not promise results.
4. \`send-client-report\` refreshes the numbers and drafts the email with the report as its body. A person approves it by marking the approval issue done; the Mailbox then sends it. You are told when it is sent; then mark your issue done. If a person refuses it, read why on the approval, fix it and send again.
5. Nothing to report (a new client, a paused service): \`skip-client-report\` with the reason.

## Closing checks
Closing the issue is checked: the report must be sent after approval, or skipped with a reason. While the email waits for approval, leave the issue open.

## Notes
- \`list-client-reports\` shows every report with its status: built, awaiting approval, sent, dry run or skipped.
- There is no public share link yet: the report travels in the email. A client portal or a preview link would need new infrastructure.
- The canary client's report is a dry run: the approval works as usual, nothing is sent, the record says so.
- Months are South African months. The report covers the month that just ended unless you pass \`period\`.
- The tools tell you when the report document on the issue could not be updated (\`documentSaved\` false and a \`documentNote\`, for example when a person locked it). The report itself is stored and the email is built from it: work from the tool's result, and do not trust the document until a build says it was saved.
- Emails carry the sending company's own name, taken from the company record. If you see another company's name in a draft, tell a person: do not change it by hand.
`;

export const SUPPORT_AND_HEALTH_REFERENCE = `# Support cases, feedback and the health score

## Opening and keeping a case
- Mail the Mailbox sorts as support, from a customer, becomes a case on its own. The Mailbox's Reply-needed issue stays the work: answer it there, and the case notes the first response when that issue is done. A new message on a resolved case reopens it.
- Anything else (a call, a lead question, an uptime problem): \`open-support-case\` with the client, a title, a summary and a severity.
- Severity: **urgent** the client cannot work or money is at risk; **high** a key part is broken; **normal** the default; **low** a question or a small request. Targets in calendar hours (first response / resolution): urgent 1 / 8, high 4 / 24, normal 8 / 72, low 24 / 168. Raising the severity tightens the targets; lowering it never gives time back.
- \`update-support-case\`: \`firstResponse\` true when you answered by a route the CRM cannot see (a call); status \`waiting_client\` while the client owes you something (the resolution clock pauses and the waiting time is given back); \`resolved\` needs \`resolution\`, a sentence on what you did.

## When a target runs out
You get an issue ("SLA breached"). Answer the client now (a Mailbox draft a person approves), then record it. Closing the issue is checked against the case.

## Feedback
- \`request-feedback\` drafts an email for approval: **nps** (0 to 10, how likely they are to recommend us; once in 90 days per person) or **csat** (1 to 5, about one resolved case, so pass \`caseId\`). Never at a bad moment: not during an open complaint or an invoice dispute.
- A reply that starts with a number is recorded for you. A score the client gave another way: \`record-feedback\`.
- NPS 6 or less, or CSAT 2 or less, opens an "Unhappy client" issue. Call them within a working day, say what you will fix and by when, and log it on the client.

## The health score
\`client-health\` gives 0 to 100 and says what it is made of. Weights: support load 25, reply speed 15, overdue invoices 20, SEO health 20, website uptime 10, answers to our requests 5, last contact 5. A part with no data is left out and the rest scaled up; it is listed as "not measured". Bands: 75 and over healthy, 50 to 74 watch, under 50 at risk. SEO health and overdue invoices come from the modules: record them with \`record-client-signal\` (no period) until the modules send them.
At risk, or a fall of 25 points, with at least three parts measured, opens one "Churn risk" issue a month. Read the whole client first (\`get-company\`, \`list-support-cases\`, \`list-client-actions\`), then reach out with a fix and a date, and log it. Closing is checked: a follow-up must be logged on the client since the issue opened.

## Websites
\`site-monitoring\` shows a client's sites: up or down and for how long, certificate days left, domain days left. Every 5 minutes the monitor makes one GET of the site's own address (twice if the first fails); twice a day it reads the certificate; once a day it asks the public registry (RDAP) when the domain expires. Down for 5 minutes, a certificate under 14 days or a domain under 30 days opens an issue for the Delivery Lead in the client's project. The public registry has no data for \`.co.za\` (the ending of the sites we run today): for those the domain date is **not known** until you read it from the registrar (or the invoice) and set it with \`set-site-monitoring\` (\`domainExpiresAt\`), so do that for each client's site you meet with no date; \`enabled\` false pauses a site (a site being rebuilt).
`;

export const CLIENT_REQUESTS_REFERENCE = `# Asking a client to do something

The owner used to carry every sign-off and every grant to the client by hand. \`create-client-action\` does it for you, and a person still approves what is sent.

## Making the request
- \`create-client-action\` with the client, a **kind** (sign_off a preview or deliverable; grant access or a login; approval a decision; info something we need from them), a short title ("Approve the new homepage"), what to click and expect, and **the exact link** the client opens.
- The link must be https and one the client can open: a preview link, a sign-in or consent page. Never a page on our Paperclip board (the client cannot open it) and never a link with a login in it. It is refused otherwise.
- It goes to a person at the client: pass \`contactId\` or \`toEmail\` (one of the client's own people), or leave both and it picks the first with a working address. An address that is not on the client is refused.
- \`dueInDays\` asks for a date; \`remindAfterDays\` (default 3) sets the interval; \`message\` replaces the opening paragraph; \`sourceRef\` says where it came from (a preview id).

## What happens next
1. An approval issue opens (the Reviewer first when the company reviews outward work, then a person) showing the exact email. Nothing is sent until a person marks it done. You cannot send it yourself.
2. After it is sent the request is **waiting on the client**. When they reply, the reminders stop (one already waiting for approval is withdrawn) and "Read the client's answer" appears: read it and decide. If the email could not be sent, the request is cancelled and you get an issue: fix the cause and create it again.
3. No answer after the interval: a reminder is drafted and approved the same way. After two reminders you get an issue ("has not answered") to reach them another way: call, or write to someone else there.
4. Record the outcome with \`update-client-action\` (done with what they answered, or cancelled when it is no longer needed). \`list-client-actions\` shows everything open.

## Rules
- One request, one thing to do. Do not bundle three sign-offs.
- Plain words, no jargon, the date if there is one.
- Never put a secret, a password or a signed link with a token you were told to keep private into a request.
- The Cockpit's ask flow is for the owner only; this is for clients.
`;

export const PRIVACY_REFERENCE = `# Privacy: consent, access, erasure and where data goes

South African law (POPIA) in the work you do. You are not a lawyer; when a case is not clear, put a Needs-you item on it.

## Why a person may be emailed
- \`record-consent\` writes why: the **purpose** (marketing email, newsletter, service messages...), the **basis** (consent, contract, legitimate interest, legal obligation), where it came from and the wording or evidence: what they wrote or saw, where and when. Without evidence it is not recorded.
- Marketing email goes only to people who agreed, or to existing clients about similar services we sell them, with an opt-out in every message. A website form's tick box records its own consent. A tick on a client's form is not a confirmed address.
- A withdrawal (\`granted\` false) needs no evidence: it marks them unsubscribed, stops their sequences and tells the other modules. Never re-add them.
- The Cockpit shows people in a running email sequence with no basis on file. Fix the record, or stop the sequence.

## Access: "what do you hold about me?"
1. Check the request really comes from the person (the address on file, or another way you can rely on).
2. \`export-person-data\` collects what the CRM holds and says which other modules to ask for the rest (Mailbox, Campaigns, Social, Billing, Accounting).
3. Draft the answer in the Mailbox to the address on file, for a person to approve. Never to a different address.

## Erasure
- Irreversible, so a person decides. \`request-erasure\` needs the evidence (how it came, that it came from them) and \`identityChecked\` true. It opens an approval that shows exactly what will go. When a person approves, the CRM erases and the other modules are asked to erase theirs, and asked again every hour until they answer. Invoices and ledger entries the law makes us keep are kept and reported, not deleted.
- \`marketing_only\` keeps the record and stops all marketing.
- Tell the person you have started. Our target is an answer within 30 days of the request.
- Deals are kept without the person, support cases without their name, and Paperclip issue comments cannot be edited by a plugin: a person removes them if they hold personal data.

## Where the data goes
- \`list-data-processing\` lists every system that holds personal data for us, where it is, how long it keeps it, and whether an agreement is on file. \`unverified\` is a to-do for the owner, not a yes.
- \`set-client-sensitivity\` flags a client whose data is sensitive (health, legal, financial, children, or a contract that limits where data goes). You may raise it; only a person lowers it. A sensitive client's data stays off every system the register does not mark cleared: no Hermes or other outside-model agents, no TypeSafe, no Resend. \`get-client-profile\` shows the flag and the list.

## Policies and terms
Drafts for a client's website start from \`references/privacy-policy-template.md\`, \`references/terms-template.md\` and \`references/cookie-notice-template.md\`. Fill the placeholders from the client's profile and the register, never guess a fact, and put the draft in front of a person (and the client's own lawyer where the stakes are real) before it goes on a site.
`;

export const PRIVACY_POLICY_TEMPLATE = `# Privacy policy template (POPIA)

Draft for {{client_name}}'s website. A template, not legal advice. Fill every {{placeholder}} from the client's profile and the data-processing register; remove a section that does not apply; never invent a fact. A person approves it, and the client's own lawyer where the stakes are real, before it is published.

---

# Privacy policy of {{client_name}}

Last updated: {{date}}

## Who we are
{{client_name}} ({{registration_number}}) is the responsible party for the personal information described here. Contact our information officer: {{information_officer_name}}, {{information_officer_email}}, {{postal_address}}.

## What we collect
We collect: {{list what the website and the business really collect: name, email, phone, message, billing details, website visits, cookies}}.{{If the site counts visits with Partners in Biz's visit counter, keep this and delete it otherwise: We count visits to this website (the pages viewed, the site or search that sent you, and actions such as pressing a phone or WhatsApp link) and keep only daily totals, which are not linked to your name, email or phone number. To keep the site safe and stop abuse, the web server that runs the counter briefly records the internet address and browser of each visit (for up to 3 days), and we keep a scrambled (hashed) form of the address for 2 days. If you agree on our cookie banner we also remember for 90 days which campaign first brought you here. We do nothing if your browser says Do Not Track.}} We collect it from you when you {{fill in a form, buy, email us}}{{, and from other sources: name them, or delete this clause}}.

## Why we use it, and on what basis
| What we do | Why | Basis |
|---|---|---|
| Answer your enquiry | To reply to what you asked | Your request |
| {{Provide the service you bought}} | To perform the contract | Contract |
| {{Send you news and offers}} | Marketing | Your consent, or an existing-customer relationship with an opt-out in every message |
| {{Keep accounting records}} | The law requires it | Legal obligation |

## Who we share it with
We use trusted operators who process information on our behalf under agreements: {{list from the register: hosting, email, analytics, payment provider, with where each is}}. We do not sell your information.

## Sending information out of South Africa
Some operators keep information outside South Africa ({{countries}}). We only do this where the receiver is bound by rules that protect it as POPIA does, or you agree, or it is needed for a contract with you.

## How long we keep it
{{Enquiries: x months. Customer records: for the contract and x years after. Accounting records: the period the law requires.}} After that it is deleted or made anonymous.

## How we protect it
{{Access limited to staff who need it, encrypted connections, backups encrypted, a record of who may see what.}} If something goes wrong with your information we tell you and the Information Regulator as the law requires.

## Your rights
You may ask us to tell you what we hold about you, to correct it, to delete it, or to stop using it for marketing, and you may object to how we use it. Write to {{information_officer_email}}; we answer within {{n}} days. To stop marketing, reply STOP to any message or use the link in it.

## Complaints
If you are not happy with how we handled your information, you may complain to the Information Regulator of South Africa (inforegulator.org.za).

## Cookies
See our cookie notice: {{cookie_notice_link}}.

## Changes
We will put any change here and change the date above.
`;

export const TERMS_TEMPLATE = `# Terms of service template

Draft standard terms for {{client_name}}. A template, not legal advice. Fill every {{placeholder}}; remove clauses that do not apply; a person (and a lawyer where the stakes are real) approves it before it is used. Prices, limits and dates come from the client, never from a guess.

---

# {{client_name}}: terms of service

Last updated: {{date}}

## 1. Who and what
These terms apply when {{client_name}} ({{registration_number}}) ("we") provides {{service description}} to you ("the customer").

## 2. The service
We will provide {{scope in plain words, with a link to the scope document}}. Anything outside it is a change and is agreed and priced before we start.

## 3. Fees and payment
Fees: {{amounts and what they include}}. Invoices are payable within {{n}} days by {{EFT / card}}. Late payment: {{interest or suspension rule}}. Amounts exclude VAT unless stated; {{VAT status}}.

## 4. Term and ending
The agreement starts on {{start date}} and runs {{month to month / for the fixed term}}. Either side may end it with {{n}} days' written notice. We keep what is paid for work already done.

## 5. What we need from you
Timely access, content and decisions. Delays on your side move our dates.

## 6. Ownership
You own {{what the customer owns}} once paid. We keep our tools and know-how, and may show the finished work in our portfolio unless you tell us not to.

## 7. Your information
We handle personal information as our privacy policy says ({{privacy_policy_link}}). Where we process personal information for you, we do it only on your instructions and keep it secure.

## 8. Limits
We take reasonable care but do not promise particular results (for example rankings or sales). Our total liability is limited to {{cap, for example the fees paid in the last 12 months}}, except where the law does not allow a limit.

## 9. Disputes and law
South African law applies. We will first try to settle a dispute by talking; then {{mediation or the courts of ...}}.

## 10. Changes
We may change these terms with {{n}} days' notice. Continuing to use the service means you accept the change.
`;

export const COOKIE_NOTICE_TEMPLATE = `# Cookie notice template

Draft for {{client_name}}'s website. A template, not legal advice. Fill from what the site really sets (look at the site: its cookies and the scripts it loads), never from a guess. A person approves it before it is published.

---

# Cookies on {{website}}

Last updated: {{date}}

A cookie is a small file a website saves on your device. We use them for:

| Cookie or tool | What it does | Kept for | Needed? |
|---|---|---|---|
| {{session or login cookie}} | Keeps you signed in | Until you close the browser | Yes |
| {{analytics tool}} | Counts visits so we can improve the site | {{period}} | No: only with your agreement |
| {{marketing pixel}} | Measures our adverts | {{period}} | No: only with your agreement |

Cookies that are not needed are only set after you agree in the banner. You can change your mind at any time with {{the cookie settings link}} or in your browser settings.

Information from cookies is handled as our privacy policy says: {{privacy_policy_link}}.
`;

/** The files the `pib-crm-records` skill ships. */
export const CARE_REFERENCE_FILES = [
  { path: "references/client-report.md", content: CLIENT_REPORT_REFERENCE },
  { path: "references/support-and-health.md", content: SUPPORT_AND_HEALTH_REFERENCE },
  { path: "references/client-requests.md", content: CLIENT_REQUESTS_REFERENCE },
  { path: "references/privacy.md", content: PRIVACY_REFERENCE },
  { path: "references/privacy-policy-template.md", content: PRIVACY_POLICY_TEMPLATE },
  { path: "references/terms-template.md", content: TERMS_TEMPLATE },
  { path: "references/cookie-notice-template.md", content: COOKIE_NOTICE_TEMPLATE },
] as const;
