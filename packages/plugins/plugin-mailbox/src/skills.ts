export const MAILBOX_DRAFT_SKILL = `# Mailbox draft

Use \`partnersinbiz.mailbox:create-draft\` on an account this agent is delegated to.

- Drafts stay drafts. Call \`send-draft\` only when that delegation has sending turned on.
- The default delegation is draft-only.
- Do not copy mailbox credentials into a Paperclip issue. Accounts store a secret ref.
- This mailbox is the member's own mail. It is separate from CRM sequence sends.
`;
