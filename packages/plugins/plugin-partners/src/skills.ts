import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const PARTNER_SHARE_SKILL = `# Partner share

Share one named record with a partner company (another Paperclip company), with the \`partnersinbiz.partners\` tools. The record stays where it is; nothing is copied.

## How it works
1. **Link.** \`list-links\` shows this company's partner links: the other company's Paperclip id, \`pending\` or \`active\`, and who has accepted. No link yet: \`propose-link\` (\`otherCompanyId\`, the other Paperclip company's id). A person at each company accepts it on the Partners page.
2. **Grant.** On an \`active\` link, \`propose-grant\` shares one record: \`linkId\`, \`recordType\` (\`contact\`, \`company\`, \`deal\` or \`invoice\`), \`recordId\` (the CRM or Billing id, never a name) and \`granteeCompanyId\` (the other company on the link).
3. **Approval.** A person at our company accepts the grant on the Partners page; only then does the partner see the record. That is the approval step: you never accept a link or a grant yourself.
4. **Check.** \`list-grants\` shows outgoing (ours, shared out) and incoming (shared with us) grants: \`proposed\`, \`active\` or \`revoked\`, each with the next step.
5. **Stop.** \`revoke-grant\` (\`grantId\`) stops sharing one of our records; the CRM or Billing share goes with it. Only the owner company can revoke.

## Rules
- Share only what the task needs, one named record at a time. Never share the whole book or a list of records.
- Share a client's record only when the client agreed to it (POPIA). Not sure: ask before proposing.
- Proposing the same record again for the same partner returns the existing grant (a revoked one is proposed again).
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: "partner-share",
    displayName: "Partner share",
    slug: "pib-partner-share",
    description: "List partner links and grants, and propose or revoke sharing one named record with a partner company.",
    markdown: withFrontmatter(
      { name: "pib-partner-share", description: "Share one named CRM record or invoice with a linked partner company: list links and grants, propose a link or grant (a person accepts), revoke. Never share the whole book." },
      PARTNER_SHARE_SKILL,
    ),
  },
];
