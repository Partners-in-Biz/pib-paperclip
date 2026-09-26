import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const MAILBOX_DRAFT_SKILL = `# Mailbox draft

Use \`partnersinbiz.mailbox:create-draft\` on an account this agent is delegated to.

- Drafts stay drafts. Call \`send-draft\` only when that delegation has sending turned on.
- The default delegation is draft-only.
- Do not copy mailbox credentials into a Paperclip issue. Accounts store a secret ref.
- This mailbox is the member's own mail. It is separate from CRM sequence sends.
- \`list-inbox\` returns the inbound messages for a mailbox. \`mark-read\` marks an inbound message read. Both need a delegation that allows reading.
- Mail sync and real sending are not connected yet: \`send-draft\` queues the message for a person to send. Say so instead of claiming it was delivered.
- \`create-email-template\` / \`list-email-templates\` keep reusable email copy. Use a template to draft a consistent message, then edit for the recipient.
- \`list-threads\` returns the mailbox messages grouped into threads by subject.
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: "mailbox-draft",
    displayName: "Mailbox draft",
    slug: "pib-mailbox-draft",
    description: "Draft on a delegated mailbox. Send only when that delegation allows it.",
    markdown: withFrontmatter(
      { name: "pib-mailbox-draft", description: "Draft email on a member's delegated mailbox. Read or send only when the delegation allows it." },
      MAILBOX_DRAFT_SKILL,
    ),
  },
];
