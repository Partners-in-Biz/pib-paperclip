export const CRM_RECORDS_SKILL = `# CRM records

Use the \`partnersinbiz.crm\` tools to keep people and the companies they work for.

- A CRM company is the account. It is not the Paperclip workspace.
- Create contacts and companies, then link them. A contact may link to many companies. Put the role on the link (\`buyer\`, \`staff\`, or a label this workspace uses).
- Log activities on the contact, company, or deal. Include \`issueId\` when the note belongs to a Paperclip issue.
- Deal amounts are integers in minor units plus a currency code.
- Moving a deal to a won or lost stage stops that contact's running sequence enrollments.
- Human-owned fields keep the person's value. You may fill an empty human-owned field. You may not replace one that already has a value. A refused write stores a fact and leaves the value unchanged.
- If a tool returns "Record is not visible", stop. Do not invent a substitute record.
- \`share-record\` names a board user or an agent. Sharing with another Paperclip company is a partner grant, not this tool.
- \`create-product\` and \`update-product\` keep the product or service catalog. Use it when a deal or invoice needs a line item. Amounts are integers in minor units plus a currency code.
- \`score-contact\` returns a 0-100 lead score with a breakdown. Use it to prioritise follow-up. A score is a hint, not a fact: never overwrite a human-owned field because a score says so.
- \`find-duplicates\` returns contacts that share an email. \`merge-contacts\` folds a duplicate into a primary, moving its links, deals, activities, facts, and enrollments. Only merge when a person confirms the two are the same person.
`;

export const CRM_OUTBOUND_SKILL = `# CRM outbound

Use \`partnersinbiz.crm:enroll-contact\` and \`partnersinbiz.crm:complete-step\`.

- Enroll a contact once. A second running enrollment in the same sequence is refused.
- A due step opens a Paperclip issue. Do not copy tokens or mailbox credentials into that issue.
- \`manual\` sequences complete when a person marks that issue done. Call \`complete-step\` only after the issue status is done.
- \`sent\` sequences complete when you set \`sentConfirmed\` after the message has actually been sent.
- Won or lost deals stop running enrollments for the contact. Do not re-enroll them in the same sequence while it is still running.
`;
