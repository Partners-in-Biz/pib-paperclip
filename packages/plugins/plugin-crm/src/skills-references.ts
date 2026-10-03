/**
 * Reference material for the CRM skills (progressive disclosure: the skill
 * carries the rules, these files carry the detail). They are installed with the
 * skill as `references/<name>.md` and hashed with it, so a change here
 * refreshes every company's copy.
 */
import { SERVICES } from "./services.js";

export const LEAD_CAPTURE_REFERENCE = `# Lead forms: taking enquiries from a website

A lead form has its own key. Whose lead it is comes from the key: a form made for a client (\`client: company:<id>\`) takes THE CLIENT'S leads; a form with no client takes ours.

## Make one
\`create-lead-endpoint\` with \`client\` (leave out for our own), \`label\` (the same label for the same client returns the same form), optionally \`siteId\` (one of the client's websites), \`consentText\`, \`privacyUrl\`, \`successMessage\`. The result has the key, \`embed.snippet\`, \`embed.curl\` and \`embed.steps\`. If it says the plugin does not know its address yet, a person opens the CRM page once; run it again.

## Install it on the client's site
This is a change to the client's site: do it through the client's repo project (a PR into the work branch) or give it to the client's developer. Never edit the live site by hand.
- **The snippet** is two lines (a comment and a script tag). Put it where the form should appear: a page's HTML, a theme template, or a Custom HTML block in WordPress. It adds an iframe; the form lives on our host. Options on the script tag: \`data-consent\` (the wording by the tick box), \`data-privacy\`, \`data-success\`, \`data-accent\` (#RRGGBB: it takes the client's brand colour from the profile), \`data-fields\` (name,email,phone,company,message), \`data-target\` (a CSS selector), \`data-title\`.
- **Why an iframe:** the host answers the public endpoint with no CORS headers, so a browser on another site cannot post to it directly. The frame is on the host's own origin, so it can. A site that blocks iframes uses the server route below.
- **Test it:** open the page, send one enquiry with an address you own, and check it under Leads from their channels on the client's page (a client's form) or as a lead contact (ours). \`list-lead-sources\` shows the count and the last lead.

## From the client's own server (WordPress PHP, a Next.js route)
POST JSON to \`embed.endpoint\` with \`key\`, \`email\` and what the form has (\`name\`, \`phone\`, \`company\`, \`message\`, \`consent\`, \`consentText\`, \`pageUrl\`, \`referrer\`, \`utm\`, \`fields\` for extras). The signing secret that makes it a server request is a credential: only a PERSON makes it, on the client's Lead forms card (CRM, open the client, Lead forms, "Make a signing secret"), where it is shown once and goes straight into that server's environment. You never see it and never ask for it in chat or in an issue. When a client needs one, put a Needs-you item on the client linking its Lead forms card (\`/crm?client=company%3A<id>\`), and say what you will do when the secret is in: write the server-side code (a PR through the client's repo project) that reads it from the environment. Sign the exact body: \`X-PiB-Timestamp\` (milliseconds) and \`X-PiB-Signature: sha256=<hmac-sha256 of "<timestamp>.<raw body>" with the secret>\`. A signed request skips the browser-only checks, may name the visitor's address (\`visitorIp\`), and has higher limits. \`embed.signedCurl\` is a working recipe.

## What it does about abuse
A honeypot field, a form sent in under 1.5 seconds, more than three links in a message: dropped without a word. Rate limits: 3 a minute and 12 an hour per visitor, 20 a minute and 120 an hour per form. A throwaway-mailbox domain or a bad address: refused with a plain message. One lead per email per form per day (a repeat the same day is ignored). Optional Cloudflare Turnstile when the owner saved the site key and secret in the CRM settings; a form made before that warns in \`list-lead-sources\` until its key is rotated. A request is size-capped, fields are length-capped and control characters removed.

## What happens to a lead
- **Our form:** a lead contact (tag lead, the phone, the campaign tags and page on the contact), a follow-up issue for the Inbound Qualifier.
- **A client's form:** stored on the client's page and handed to the client through an issue in the client's own project. It is never added to our contacts, sequences or campaigns (POPIA). The issue says to check it is real, get it to the client in a Mailbox draft a person approves, and log what you did on the client.
- **Consent:** the marketing tick box is separate from the enquiry and starts unticked. Ticked: a consent record (wording, form, page, time, a keyed hash of the address, never the address) on the sender's own list, and \`consent.recorded\` goes to the other modules. Not ticked: write only about the enquiry. The wording must say who will email them. **A tick on a form is not a confirmed address:** nobody checked that the person owns it, so someone could tick for another person's address. Do not start marketing mail (a sequence, a campaign) on a form tick alone; send one confirmation email the person must click first, or have a person decide. The enquiry itself (answering what they asked) needs no consent.

## Keys
\`rotate-lead-key\`: a new key, the old one works 7 days so the snippet can be swapped. \`update-lead-source\` pauses or resumes a form and changes its wording; only a person switches one off for good. After a leak, rotate, and put a Needs-you item on the client if the form has a signing secret: only a person replaces it (Lead forms card, "New signing secret"); a rotation by you never changes the secret and never shows one.

## Messages you may see
"not active": the key is wrong, paused or switched off. "Too many submissions": a rate limit. "permanent email": a throwaway address. "does not match" / "too far": a bad signature or clock. The host also keeps each delivery in its own webhook log for a few days (what the visitor typed is in it); that log is the host's, and ops prunes it.
`;

export const NEW_CLIENT_REFERENCE = `# Starting a new client

\`start-new-client\` with \`client\` returns the checklist from the CRM's own records, and links a project when you pass \`projectId\` and sets the services when you list them. It reads the records; it creates nothing outside the CRM.

## Who does what
- **Account Manager:** the profile (\`update-client-profile\`: brand voice, audience, services from the fixed list, website, booking link, banned words, tone, then the brand kit and proposal references), the client's sites (\`save-client-site\`), a lead form when the client bought lead capture (\`create-lead-endpoint\`), ONE grant ask for everything the client must give (never one per item).
- **Delivery Lead:** the project and its git workspace, the \`development\` branch policy, the agent guide (AGENTS.md), staging. Hand it one issue in the client's project. main only changes with Peet's approval.
- **The role that owns each service:** its onboarding step (below).

## The project: the contract between the ops tool and the CRM
A plugin cannot create projects or repos. The ops tool \`new-client-project.py\` creates the Paperclip project with a git workspace and the branch policy, then calls the board action that links it to the client:

\`POST /api/plugins/partnersinbiz.crm/actions/crm.link-client-project\` with the board token and \`{ "companyId": "<Paperclip company id>", "params": { "client": "company:<crm id>", "projectId": "<project uuid>" } }\`. Answer: \`{ "data": { "projectId", "name", "client", "linked": true } }\`, or \`alreadyLinked: true\`. A project that belongs to another client is refused (a person unlinks it first). \`crm.find-records\` (\`params\`: \`query\`, \`kind\`) finds the client by name or domain. The agent tool \`link-client-project\` does the same link. Client work then opens in that project, never in ours.

## Checklist keys
crm-record, profile, services, project, repo (the project has a git workspace), branch-policy and agent-guide (the CRM cannot see the repo: check and say so on the client), site, lead-form, brand-kit, one \`service:<key>\` per service, grants, billing. A state is done, todo, waits (for something earlier, or for the client to become a customer), or unknown (the CRM cannot see it).
`;

function serviceTable(): string {
  return SERVICES.map((service) => `| \`${service.key}\` | ${service.label} | ${service.role} | ${service.module ?? "none"} | ${service.start[0]} |`).join("\n");
}

export const SERVICES_REFERENCE = `# The services a client buys

The profile's \`services\` is a list of these keys. Free wording is mapped when it can be ("SEO retainer" is seo, "Facebook ads" is ads, "SEO and social" is both) and kept as text otherwise; \`update-client-profile\` tells you what stayed as text.

| Key | Service | Owner role | Module | First move |
|---|---|---|---|---|
${serviceTable()}

## What the CRM does when services change
- It tells the other modules with the hand-off \`client.services.changed\` (\`services\`, \`added\`, \`removed\`).
- For a CUSTOMER, each service added opens ONE step for the owner role (origin \`crm:service-onboard:...\`), in the client's own project when it has one, assigned like any CRM work (the role, else the Operator, else the owner). A prospect's services open nothing: they have not bought yet.
- While the Cockpit's first-win onboarding issue for the client is open, the services flagged then are covered by it and get no step of their own.
- The daily \`services-check\` job gives the same step to customers whose services were set before this existed (up to 8 new steps per company a day), and saves older free-text profiles in the list. A step that was cancelled stays cancelled until the service is added again.

## Working a step
First open the module's client workspace: if the service already runs (a sprint set up by hand), log it on the client (\`log-activity\` with the link or id) and close. Otherwise do what starting means, then log the proof on the client and close. Closing is checked: proof must be logged on the client since the step opened. Removing a service cancels its open step.
`;

export const CANARY_REFERENCE = `# The canary client

One internal test client for proving lead, qualify, quote, invoice and payment proof end to end without touching a real client. \`create-canary-client\` finds or creates it (asking again returns the same one). It has a company (PiB Canary Co), a contact whose address ends @canary.invalid, and a canary lead form. Everything about it is flagged: its ids start with \`canary-\`, its records carry the tag and custom field \`canary\`, and the \`.invalid\` name can never exist, so no mail system can deliver to it.

## Rules (every module and agent)
- Everything outward is a draft or a dry run: no email, SMS, post, ad, invoice or payment request reaches a real person. A CRM sequence email to a canary contact is recorded as a dry run and never queued.
- Never put a real address on it. Say in each request that it is the canary.
- Approvals still run as usual: the Reviewer, then a person where the module needs one.
- Money is test money: a payment proof is a test row, never a real bank line.

## The journey
1. **Lead:** send one test enquiry to the canary form (\`leadForm.curl\`, address ending @canary.invalid). It shows under Leads from their channels and opens a lead issue.
2. **Qualify:** log what you found (\`log-activity\`), set the contact's lifecycle to prospect.
3. **Quote:** \`create-deal\` for the canary company; draft the quote in Billing with the deal id (\`pib-invoice-draft\`).
4. **Won:** the customer accepts in Billing; the CRM moves the deal to won and the Cockpit opens the onboarding issue once.
5. **Invoice:** convert the quote to an invoice as a draft; never send it.
6. **Payment proof:** record the payment as a test payment in Billing; the CRM logs \`invoice.paid\` on the client.
7. **Clean up:** \`cleanup-canary\` with \`confirm: true\`. It removes only the canary's own records (company, flagged contacts, deals, leads, forms, notes) and tells the other modules (\`company.deleted\`). Quotes and invoices other modules hold for it are theirs to remove. A record with the canary id that is not flagged is left alone.
`;
