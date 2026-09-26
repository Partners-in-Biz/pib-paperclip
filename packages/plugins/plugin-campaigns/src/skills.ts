import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const CAMPAIGN_SKILL = `# Campaigns

Use the \`partnersinbiz.campaigns\` tools to run themed email programs.

- A campaign groups email steps that target an audience. \`audienceTags\` narrows which CRM contacts are enrolled; empty means every contact. Contacts come from the CRM plugin; if one you just created is missing, ask a person to run CRM \"resync\".
- \`create-campaign\` then \`add-campaign-step\` build the program. A step has a subject, body, and a \`delayDays\` wait after the previous step.
- Every campaign needs approval. \`request-campaign-approval\` opens a Paperclip issue for a person; \`launch-campaign\` refuses to run until that issue is done.
- \`launch-campaign\` enrolls matching contacts (or the \`contactIds\` you pass) and opens each due step's Paperclip issue with the recipient's address. A person sends the email and marks the issue done.
- \`pause-campaign\` and \`resume-campaign\` control a running program. \`complete-campaign\` ends it.
- \`campaign-stats\` reports enrolled, running, and completed counts. \`campaign-funnel\` shows how many contacts are at each step.
- \`enroll-contact\` adds one contact to a campaign. \`complete-step\` advances an enrollment after its issue is done.
- \`create-ab-variant\` adds a B variant to a step so contacts are split between two versions. The enrollment records which variant was sent.
- \`record-step-event\` records an open or click on a step. \`campaign-step-analytics\` reports opens and clicks per step.
- \`set-step-html\` sets the rich HTML body of a step. The plain body stays as a fallback for clients that cannot render HTML.
- \`create-campaign-template\` saves a reusable campaign with its steps. \`create-campaign-from-template\` makes a new draft from one.
- \`declare-ab-winner\` records variant a or b as the winner of an A/B campaign.
- Do not copy mailbox credentials or tokens into a campaign issue. The person sends from their mailbox.
- A contact is enrolled once per campaign. A second running enrollment is refused.
`;
export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: "campaigns",
    displayName: "Campaigns",
    slug: "pib-campaigns",
    description: "Run themed email programs that enroll contacts and open issues for due steps.",
    markdown: withFrontmatter(
      { name: "pib-campaigns", description: "Run approved, themed email programs that enroll CRM contacts and open issues for due steps." },
      CAMPAIGN_SKILL,
    ),
  },
];
