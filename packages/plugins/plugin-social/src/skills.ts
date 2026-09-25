export const SOCIAL_PUBLISH_SKILL = `# Social publish

Use the \`partnersinbiz.social\` tools to publish to real connected social accounts (Facebook, Instagram, Threads, LinkedIn, X, TikTok, Mastodon, Pinterest, Reddit, Bluesky, Dribbble, YouTube) via their OAuth APIs.

## Accounts & publishing model

- A post is published to real platforms: the \`publish-due\` job takes each scheduled post and calls the platform API for every attached destination account. Success stores the platform's \`externalId\`; failure stores the API error and marks the destination failed.
- Accounts are OAuth-connected, not fake rows. A human connects each platform from the Social page (Connect accounts section), which runs the real platform OAuth flow. You never see or handle access tokens.
- \`list-connected-accounts\` returns the connected accounts (platform, handle, status, token expiry). \`refresh-account\` manually refreshes a token (LinkedIn, TikTok, Google/YouTube, Pinterest, Reddit issue refresh tokens). \`disconnect-account\` removes an account and its stored tokens.
- \`connect-account\` starts an OAuth connection when you have the instance \`baseUrl\`: pass the platform and \`baseUrl\`, and return the \`connectUrl\` to the human to open and approve. Mastodon needs \`instance\` (e.g. https://mastodon.social). Bluesky connects with a handle + app password via the Social page (credential-based, no OAuth app).
- Platform app credentials (client IDs/secrets) are configured once in the plugin settings. Until a platform is configured there, connecting it fails with a clear message — tell the user to add the credentials.

## Publishing workflow

- One post can target many accounts. Attach each destination with \`attach-destination\`.
- An organisation post cannot target a personal account. A personal account can only be used by the member who owns it.
- Move a draft to review with \`request-review\`. A person approves it. You schedule an approved post with \`schedule-post\`.
- Do not mark a post published yourself. The publish job does that at the scheduled time and records the real result.
- Instagram and Pinterest require media (images/video). X supports up to 4 images. TikTok and YouTube require a video URL. \`create-media-asset\` / \`list-media-assets\` keep a vault of image and video assets (URLs) for reuse; use those URLs as media on posts.
- \`record-post-metrics\` records engagement (views, likes, comments, shares) for a published post. \`post-analytics\` returns aggregated totals for a post or workspace; \`account-analytics\` per account.
- \`create-rss-feed\` / \`list-rss-feeds\` track an RSS feed to repurpose its items. \`pause-rss-feed\` and \`resume-rss-feed\` control tracking.
- \`record-inbox-item\` records a mention, comment, or message. \`list-inbox\` returns the social inbox. \`mark-inbox-read\` marks an item read. \`reply-inbox\` marks an item as replied and creates a draft post with the reply body.
- \`bulk-schedule\` schedules several approved posts at once with a single time.
- \`create-template\` / \`list-templates\` save reusable post copy so drafts stay on-brand.
`;
