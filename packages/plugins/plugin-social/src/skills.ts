export const SOCIAL_PUBLISH_SKILL = `# Social publish

Use the \`partnersinbiz.social\` tools to draft and schedule posts.

- One post can target many accounts. Attach each destination with \`attach-destination\`.
- An organisation post cannot target a personal account.
- A personal account can only be used by the member who owns it.
- Move a draft to review with \`request-review\`. A person approves it. You schedule an approved post with \`schedule-post\`.
- Do not put account tokens or secret refs in a Paperclip issue. The publish job reads the credential reference from the account row.
- Do not mark a post published yourself. The publish job does that when the scheduled time arrives.
- \`create-template\` saves reusable post copy. \`list-templates\` returns the saved templates. Use a template to draft a consistent post, then edit the body for the specific post.
- \`record-post-metrics\` records engagement (views, likes, comments, shares) for a published post. \`post-analytics\` returns the aggregated totals for a post or the whole workspace.
`;
