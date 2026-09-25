export const CAMPAIGN_SKILL = `# Campaigns

Use the \`partnersinbiz.campaigns\` tools to run themed email programs.

- A campaign groups email steps that target an audience. \`audienceTags\` narrows which contacts are enrolled; empty means every visible contact.
- \`create-campaign\` then \`add-campaign-step\` build the program. A step has a subject, body, and a \`delayDays\` wait after the previous step.
- \`launch-campaign\` enrolls matching contacts and opens the first step's Paperclip issue. A person sends the email and marks the issue done.
- \`pause-campaign\` and \`resume-campaign\` control a running program. \`complete-campaign\` ends it.
- \`campaign-stats\` reports enrolled, running, and completed counts.
- \`enroll-contact\` adds one contact to a campaign. \`complete-step\` advances an enrollment after its issue is done.
- Do not copy mailbox credentials or tokens into a campaign issue. The person sends from their mailbox.
- A contact is enrolled once per campaign. A second running enrollment is refused.
`;