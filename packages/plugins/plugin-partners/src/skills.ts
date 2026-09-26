import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const PARTNER_SHARE_SKILL = `# Partner share

Use \`partnersinbiz.partners:propose-link\` and \`partnersinbiz.partners:propose-grant\`.

- A link stays pending until both Paperclip companies accept it.
- Propose a grant for one named CRM record or invoice. Do not copy the record into the other company.
- A person at the company that owns the record accepts the grant. That acceptance is what makes the named record visible to the other company.
- \`revoke-grant\` removes a shared record; the CRM or Billing share is removed with it. Only the company that owns the record can revoke it.
- Do not share the whole book.
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: "partner-share",
    displayName: "Partner share",
    slug: "pib-partner-share",
    description: "Propose a named grant. Do not copy the record into the other company.",
    markdown: withFrontmatter(
      { name: "pib-partner-share", description: "Share one named CRM record or invoice with a linked partner company. Never share the whole book." },
      PARTNER_SHARE_SKILL,
    ),
  },
];
