import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const MAILBOX_DRAFT_SKILL = `# Mailbox

The company's Gmail hub, with the \`partnersinbiz.mailbox\` tools. Every PiB plugin sends and receives mail through it. You read, draft and (when allowed) send on the mailboxes delegated to you.

## Start here
- \`list-mailboxes\`: every account, its Gmail status, which one is the default sender, and your delegation on it (\`mayRead\`, \`mayDraft\`, \`maySend\`). Use its \`accountId\` in the other tools.
- No delegation on the mailbox you need: ask the owner once to give you access (Mailbox → Mailboxes → Give an agent access, read and draft). Sending stays with a person unless they allow it.

## Reading
- \`list-inbox\`: inbound mail with triage (\`category\`, \`urgency\` 0 can wait to 3 urgent, \`needs_reply\` probability, client, attachments).
- \`search-mail\` runs a Gmail query (headers and snippets only); \`get-message\` reads one message's text (truncated); \`list-threads\` groups by thread; \`mark-read\` marks read here and in Gmail.
- Read only what the task needs. Never copy mailbox credentials or tokens into an issue.

## Attachments
- \`get-message\` lists each attachment's \`attachmentId\`. \`get-attachment\` (\`messageId\`, \`attachmentId\`, and \`account\` when several mailboxes are connected) returns \`filename\`, \`mime\`, \`bytes\` and an https \`url\` valid 15 minutes.
- Statement files (CSV, OFX, QIF, TXT, MT940) up to 200 KB also come back as \`text\`. Both feed \`partnersinbiz.accounting:import-statement\`: \`text\` as \`content\`, or the \`url\`.
- No \`url\` means private storage (R2) is not set up in the Mailbox settings; statement text still works.

## Drafting and sending
- \`create-draft\` on a mailbox where \`mayDraft\` is true: \`to\` (and \`cc\`, \`bcc\`), subject, \`body\` (optional \`html\`). \`replyToMessageId\` keeps the Gmail thread.
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
- A message whose subject or first line is "unsubscribe" or "stop" (the unsubscribe header sends one) puts the sender on the list for marketing mail.
- A hard bounce puts the address on the list for all mail; a delay notice does not.
- Opt-outs from Campaigns and the CRM join the same list, and the Mailbox shares its own (\`contact.suppressed\`).
- Marketing sends leave out every listed address and carry an unsubscribe header; every send leaves out hard bounces. A send with nobody left fails for good with the reason; \`mail-status\` shows it and any recipients left out.
- Someone asks to stop in other words: record it with \`partnersinbiz.crm:set-email-status\` (unsubscribed) for a CRM contact, or \`partnersinbiz.campaigns:suppress-address\` for any address. Either tells every module.

## Triage
- \`correct-triage\` fixes the category, urgency, needsReply or client (\`company:<id>\`, \`contact:<id>\`, \`none\`). Corrections improve the accuracy stats.

## Mail other plugins send
- Billing, Payroll, CRM, Campaigns and others send through the Mailbox with events. \`mail-status\` with the request key shows sent, retrying, or failed and why.
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: "mailbox-draft",
    displayName: "Mailbox",
    slug: "pib-mailbox-draft",
    description: "Read, draft, send and route company mail on delegated Gmail mailboxes; attachments and the do-not-email list.",
    markdown: withFrontmatter(
      { name: "pib-mailbox-draft", description: "Read, draft and send email on delegated Gmail mailboxes, fetch attachments, know where each kind of inbound mail goes, and respect the do-not-email list. Send only when the delegation allows it." },
      MAILBOX_DRAFT_SKILL,
    ),
  },
];
