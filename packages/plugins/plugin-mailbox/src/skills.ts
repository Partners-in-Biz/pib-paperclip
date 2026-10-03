import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const MAILBOX_DRAFT_SKILL = `# Mailbox

The company's Gmail hub, with the \`partnersinbiz.mailbox\` tools. Every PiB plugin sends and receives mail through it. You read, draft and (when allowed) send on the mailboxes delegated to you.

## Start here
- \`list-mailboxes\`: every account, its Gmail status, which one is the default sender, the client a mailbox belongs to (\`client\`), and your delegation on it (\`mayRead\`, \`mayDraft\`, \`maySend\`). Use its \`accountId\` in the other tools. The Operator already has read and draft on the company's own mailboxes.
- No delegation on the mailbox you need: that mailbox carries \`askToOwner\`. Pass it to \`partnersinbiz.cockpit:ask-owner\` once, unchanged. The owner's yes creates the access and checks it, and you are woken with it in place: do not ask again, and do not ask in a comment. Sending stays with a person unless they allow it. Access a person removed stays removed.

## Reading
- \`list-inbox\`: inbound mail with triage (\`category\`, \`urgency\` 0 can wait to 3 urgent, \`needs_reply\` probability, client, attachments).
- \`search-mail\` runs a Gmail query (headers and snippets only); \`get-message\` reads one message's text (truncated); \`list-threads\` groups by thread; \`mark-read\` marks read here and in Gmail.
- Read only what the task needs. Never copy mailbox credentials or tokens into an issue.

## Attachments
- \`get-message\` lists each attachment's \`attachmentId\`. \`get-attachment\` (\`messageId\`, \`attachmentId\`, and \`account\` when several mailboxes are connected) returns \`filename\`, \`mime\`, \`bytes\` and an https \`url\` valid 15 minutes.
- Statement files (CSV, OFX, QIF, TXT, MT940) up to 200 KB also come back as \`text\`. Both feed \`partnersinbiz.accounting:import-statement\`: \`text\` as \`content\`, or the \`url\`.
- No \`url\` means private storage (R2) is not set up in the Mailbox settings; statement text still works.

## Drafting and sending
- \`create-draft\` on a mailbox where \`mayDraft\` is true: \`to\` (and \`cc\`, \`bcc\`), subject, \`body\` (optional \`html\`). \`replyToMessageId\` keeps the Gmail thread. \`replyTo\` and \`fromName\` set where replies go and the name shown when it is not the mailbox's own.
- A mailbox that belongs to a client sends only that client's mail, as the client. Never draft another client's or the company's own mail on it, and never put a client's mail on the company's own mailbox to avoid that.
- \`send-draft\` only where \`maySend\` is true. Without a connected Gmail account it queues the draft for a person: say so; never claim it was delivered.
- Every email says who we are. Writing to or for a client: read \`partnersinbiz.crm:get-client-profile\` first (brand voice, banned words). Replies, invoices, quotes and payslips are transactional; campaigns and sequences are marketing and never reach an address that opted out.
- \`create-email-template\` and \`list-email-templates\` keep reusable copy.

## Where inbound mail goes
New mail is triaged every 2 minutes (the sender in the CRM, a reply to mail a plugin sent, then Jev or keyword rules) and labelled \`PiB/<Category>\` in Gmail. Then:

| Mail | Who acts | What happens |
|---|---|---|
| Lead, sender not in the CRM | CRM, then its Account Manager | Handed to the CRM as a lead and re-sent until the CRM answers. The CRM opens the follow-up, so no reply issue here. |
| Lead from a known contact, client, support | Account Manager (else Operator, else owner) | One "Reply needed" issue per thread: read it, draft, send (or queue), log it on the contact (\`partnersinbiz.crm:find-records\` finds it). |
| Reply to an email we sent | The plugin that sent it | Campaigns (follow up, stop, opt-out), CRM sequences, Billing (quote or invoice replies). |
| Proof of payment | Billing | Matched to the invoice; a person confirms the payment. |
| Invoice or bill from a known supplier | Billing | Drafted as a supplier bill to complete. |
| Bank statement | Bookkeeper | Accounting opens "Bank statement received" with the message id, attachment ids and mailbox: \`get-attachment\`, then \`partnersinbiz.accounting:import-statement\`, then reconcile. |
| Newsletter, notification, personal, other | Nobody | Labelled only. |
| Spam or phishing (\`PiB/Suspicious\`) | Nobody | Never open its links, reply or act on it. |

Never answer a legal threat or a money question you cannot check: ask the owner.

## Closing a "Reply needed" issue
When you close an issue this module opened, it checks the work; if it reopens, it lists what's missing: finish those. Done means the thread's newest mail that needs a reply has your reply draft (\`create-draft\` with \`replyToMessageId\`) or a sent reply after it, or \`correct-triage\` set needsReply false because no reply is needed.

## Do-not-email list
- A message whose subject or first line is "unsubscribe" or "stop" (the unsubscribe header sends one) puts the sender on the list for marketing mail. The list is per sender: an opt-out on a client's mailbox is that client's list, the company's own mailbox has its own.
- A hard bounce puts the address on the list for all mail; a delay notice does not.
- Opt-outs from Campaigns and the CRM join the same list, and the Mailbox shares its own (\`contact.suppressed\`).
- Marketing sends leave out every listed address and carry an unsubscribe header (an https one-click link too when there is one); every send leaves out hard bounces. A send with nobody left fails for good with the reason; \`mail-status\` shows it and any recipients left out.
- Someone asks to stop in other words: record it with \`partnersinbiz.crm:set-email-status\` (unsubscribed) for a CRM contact, or \`partnersinbiz.campaigns:suppress-address\` for any address. Either tells every module.
- A person erased on request leaves only a hash behind so they are never mailed again. You never erase mail yourself: the CRM runs an approved erasure (\`references/privacy.md\`).

## Sender domains
Mail from a domain with no SPF, DKIM or DMARC bounces or lands in spam. \`check-sender-domain\` reads the DNS of a domain (SPF, DKIM, DMARC, MX; nothing is changed) and returns healthy, warn or bad with each problem and fix, plus the exact records to add for a new client domain. \`sender-domain-health\` returns the last stored check of every sending domain. Before a campaign goes out from a domain it must be healthy; the Mailbox itself blocks nothing. DNS is edited by whoever controls the domain, so hand them the \`onboarding\` steps in one \`partnersinbiz.cockpit:ask-owner\`, then check again when they say it is done. Never call a domain healthy without a check. Details: \`references/sender-domains.md\`.

## Client mail sent to us
A client's website form or a BCC copy that arrives in a company mailbox is the client's, not the company's own lead. \`list-client-mail-maps\` shows the mappings and the sender domains of mail that looks like a client's but is not mapped; \`map-client-mail\` maps a domain or address to a client (find the client with \`partnersinbiz.crm:find-records\` first), and \`remove-client-mail-map\` undoes one. Mapped mail is filed under the client and its leads go to the CRM in the client's scope. Details: \`references/client-mail.md\`.

## Triage
- \`correct-triage\` fixes the category, urgency, needsReply or client (\`company:<id>\`, \`contact:<id>\`, \`none\`). Corrections improve the accuracy stats.

## Mail other plugins send
- Billing, Payroll, CRM, Campaigns and others send through the Mailbox with events. \`mail-status\` with the request key shows sent, retrying, or failed and why.
`;

export const SENDER_DOMAINS_REFERENCE = `# Sender domains

## What the check reads
- **MX**: where mail to the domain goes. No MX means replies and bounces cannot arrive. Google Workspace uses the single record \`1 SMTP.GOOGLE.COM\` or the ASPMX set.
- **SPF**: one TXT record at the domain starting \`v=spf1\`. For Gmail it must include \`_spf.google.com\` and end in \`~all\` (or \`-all\`). Two SPF records break both. SPF allows 10 DNS lookups through its includes; the check counts them.
- **DKIM**: a TXT record at \`<selector>._domainkey.<domain>\`. Tried: google, default, selector1, selector2, resend, k1, s1, s2, mail, dkim, smtp, and any selector in the Mailbox settings or the \`selectors\` parameter. At least one valid key is needed. A 1024-bit key is reported as a note: 2048 is current.
- **DMARC**: a TXT record at \`_dmarc.<domain>\` (a subdomain inherits the organisational domain's). \`p=none\` only reports; it is the right first step. It becomes a warning after 30 days of sending: raise it to \`p=quarantine\`, later \`p=reject\`, when the reports (\`rua\`) show only your own mail.

## Reading the result
- \`bad\`: no SPF, two SPF records, SPF over 10 lookups, no DKIM key, or no MX for a domain with a mailbox. Fix before sending marketing mail.
- \`warn\`: no DMARC yet, \`p=none\` for over 30 days, SPF without Google's include, or DNS that could not be read this time. \`unreadable\` is never "missing": the result carries the \`dig\` commands to run by hand.
- \`healthy\`: all in place. \`sendReady\` is true when SPF, a DKIM key and DMARC exist.
- A free-mail domain (gmail.com, outlook.com) is authenticated by its provider: nothing to check.

## A new client domain
1. \`check-sender-domain\` with the domain (and \`clientKind\`/\`clientRef\`): it is watched daily from then on.
2. Its \`onboarding.steps\` are the exact records to add, in order. Put them in one \`partnersinbiz.cockpit:ask-owner\` for whoever controls the DNS (the owner, or the client or their web host). The agent cannot edit DNS.
3. When they say it is done, run \`check-sender-domain\` again. DNS can take a few hours.
4. Only then send campaigns from that domain, from a mailbox set up for that client.
`;

export const CLIENT_MAIL_REFERENCE = `# Client mail sent to a company mailbox

## Why
The company's own mailboxes are its own, so a lead from them was filed as the company's lead. A client's website form BCC'd or relayed to a company mailbox was misfiled that way (AHS Law, three times).

## Mappings
- \`sender_domain\` / \`sender_address\`: mail FROM the client's site or system (a web host sending the form). The visitor is the person in Reply-To.
- \`recipient_domain\` / \`recipient_address\`: mail TO the client's address or an alias we forward (a BCC copy, \`leads+client@ourdomain\`).
- A specific address beats a domain, the sender beats the recipient. A domain rule covers its subdomains. The company's own domain and free-mail domains are refused.

## What a mapping does
- The message is filed under the client (\`client_kind\`, \`client_ref\`, triage source \`mapping\`).
- A sender mapping with a visitor in Reply-To makes it a lead for that client: \`lead.captured\` goes to the CRM with the client's scope and the visitor as the person (no person when there is no Reply-To: the website's address is not one).
- Without a mapping nothing changes: it stays the company's own. Mail that looks like a client's (a relayed form, or a client's CRM domain) is flagged \`needs_mapping\` and listed by \`list-client-mail-maps\`.
- Adding a mapping files the flagged mail of the last 30 days and re-sends those leads in the client's scope under a new key (\`supersedes\` names the old one). The CRM decides how to merge.

## Doing it
1. \`list-client-mail-maps\`: read a sample with \`get-message\` (the \`sampleMessageId\`).
2. Find the client in the CRM (\`partnersinbiz.crm:find-records\`). Only a real client id is accepted.
3. \`map-client-mail\`. If you are unsure whose it is, ask the owner once rather than guessing: a wrong mapping files a lead under the wrong client (\`remove-client-mail-map\` undoes it).
`;

export const PRIVACY_REFERENCE = `# Erasure, consent and the do-not-email list

- The CRM starts an erasure only after a person approved it. The Mailbox then erases every stored message to or from the address (headers, snippet, triage, drafts), the decisions about them, the send records' recipients and bodies (the record stays so a repeated request is still refused), a lead waiting to reach the CRM, and its copy of the CRM contact. The Reply-needed issue's title and description are replaced.
- It keeps, and says so: a do-not-email marker that holds only a hash of the address (so the person is never emailed again and their old mail is never imported again), and the Gmail copies, which the Mailbox cannot delete permanently: a person deletes them in Gmail if there is no reason to keep them.
- An address that is one of the company's own mailboxes is refused (it would erase the mailbox) and the request stays open for a person.
- A withdrawn marketing consent from another plugin puts the address on that sender's marketing list. A given consent never removes anyone from the list.
- Agents never erase mail or edit the list to undo an opt-out. If someone asks to be forgotten, say the request goes through the CRM and the owner approves it.
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: "mailbox-draft",
    displayName: "Mailbox",
    slug: "pib-mailbox-draft",
    description: "Read, draft, send and route company mail on delegated Gmail mailboxes; attachments, the do-not-email list, sender domain checks and client mail.",
    markdown: withFrontmatter(
      { name: "pib-mailbox-draft", description: "Read, draft and send email on delegated Gmail mailboxes, fetch attachments, know where each kind of inbound mail goes, respect the do-not-email list, check a sender domain's SPF, DKIM and DMARC, and file client mail under its client. Send only when the delegation allows it." },
      MAILBOX_DRAFT_SKILL,
    ),
    files: [
      { path: "references/sender-domains.md", content: SENDER_DOMAINS_REFERENCE },
      { path: "references/client-mail.md", content: CLIENT_MAIL_REFERENCE },
      { path: "references/privacy.md", content: PRIVACY_REFERENCE },
    ],
  },
];
