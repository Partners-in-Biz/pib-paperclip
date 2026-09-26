import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const MAILBOX_DRAFT_SKILL = `# Mailbox

The Mailbox is the company's Gmail hub. Every PiB plugin sends and receives mail through it.

## Drafting and sending

- Use \`partnersinbiz.mailbox:create-draft\` on an account this agent is delegated to. Give \`to\` (and \`cc\`/\`bcc\`), a subject and a body (\`body\` text, optional \`html\`). To answer a message, pass \`replyToMessageId\` so the reply stays in the Gmail thread.
- Drafts stay drafts. Call \`send-draft\` only when that delegation has sending turned on. It sends through the connected Gmail account and returns the Gmail ids.
- If the mailbox has no connected Gmail account, \`send-draft\` queues the draft for a person. Say so instead of claiming it was delivered.
- The default delegation is draft-only. Do not copy mailbox credentials into a Paperclip issue.
- \`create-email-template\` / \`list-email-templates\` keep reusable email copy.

## Reading

- \`list-inbox\` returns inbound messages with triage chips: \`category\`, \`urgency\` (0 can wait … 3 urgent), \`needs_reply\` (probability), \`client_kind\`/\`client_ref\`.
- \`search-mail\` runs a Gmail query and returns headers and snippets only.
- \`get-message\` fetches one message's text on demand (truncated). Read only what the task needs.
- \`mark-read\` marks a message read here and in Gmail. \`list-threads\` groups messages by Gmail thread.
- All reads need a delegation that allows reading.

## Triage

- New mail is triaged automatically (CRM sender match, replies to mail a plugin sent, then Jev) and labelled in Gmail as \`PiB/<Category>\`.
- When a triage is wrong, fix it with \`correct-triage\` (category, urgency, needsReply, client). Corrections improve the accuracy stats.

## Mail other plugins send

- Billing, Payroll, CRM, Campaigns and others send through the Mailbox with events. \`mail-status\` with the request key shows whether it was sent, is retrying, or failed and why.
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: "mailbox-draft",
    displayName: "Mailbox",
    slug: "pib-mailbox-draft",
    description: "Draft, send, read, search and triage mail on a delegated Gmail mailbox.",
    markdown: withFrontmatter(
      { name: "pib-mailbox-draft", description: "Draft and send email on a delegated Gmail mailbox, read and search mail, and correct triage. Send only when the delegation allows it." },
      MAILBOX_DRAFT_SKILL,
    ),
  },
];
