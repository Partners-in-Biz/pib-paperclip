/**
 * Managed skills (used by the manifest and by the worker's versioned sync).
 * Canonical keys on the host: plugin/partnersinbiz-social/<skillKey>.
 */
import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const SKILL_KEY_PREFIX = "plugin/partnersinbiz-social";

const PUBLISH_DESCRIPTION =
  "Operate the Partners in Biz Social plugin: pick the client, draft posts with media and per-platform overrides, send them for approval, schedule approved posts, retry failures, and work the social inbox and analytics. Use for any social posting or scheduling task.";

export const SOCIAL_PUBLISH_BODY = `# Social publish

You manage social posting for Partners in Biz clients with the \`partnersinbiz.social\` tools. The plugin talks to the real platforms (Facebook Pages, Instagram, Threads, LinkedIn, X, TikTok, YouTube, Pinterest, Reddit, Bluesky, Mastodon, Dribbble). Tokens never reach you.

## Ground rules

- **Clients are CRM companies.** Call \`list-clients\` and pass the CRM company id as \`clientRef\`. Never invent a client or type a name instead of an id.
- **You draft and schedule. A person approves.** You can create, edit and request review. Only a person can approve. You may schedule a post once it is approved. Never claim a post is published: the \`publish-due\` job publishes it and records the result.
- **Accounts are connected by people** on the Social page (Accounts tab). \`connect-account\` only returns instructions. If an account shows \`needs_reconnect\` or \`expiring\`, tell the person to reconnect it; do not keep scheduling to it.
- An organisation post cannot target a personal account.
- Never paste tokens, secrets or passwords into posts, comments or issues.

## Workflow for a post

1. \`list-clients\` → choose the client. \`list-connected-accounts\` with \`clientRef\` → choose destination account ids. Only use accounts with status \`connected\`.
2. Media: reuse \`list-media-assets\`, or \`import-media-from-url\` (public https image or MP4, stored on R2). Pass asset ids as \`mediaAssetIds\` (order = carousel order). Do not paste raw URLs as media.
3. \`create-post\` with \`body\`, \`clientRef\`, \`accountIds\`, \`mediaAssetIds\`, optional \`firstComment\` and \`overrides\`. Load the \`social-content\` skill to write platform-native copy.
4. \`overrides\` is keyed by platform: \`{ "x": { "text": "…" }, "youtube": { "title": "…", "privacy": "unlisted" }, "reddit": { "subreddit": "smallbusiness", "title": "…" }, "pinterest": { "boardId": "…", "link": "https://…" }, "tiktok": { "privacy": "SELF_ONLY" } }\`. Fields: text, title, link, privacy, subreddit, boardId. Anything not overridden falls back to the main body.
5. \`validate-post\` → fix every problem it lists (usually text too long for X/Bluesky/Threads/Mastodon, or missing media for Instagram/TikTok/YouTube/Pinterest).
6. \`request-review\`. Tell the person what is waiting and why. After they approve, \`schedule-post\` with an ISO time (\`2026-10-05T07:30:00+02:00\`). Use \`bulk-schedule\` for several approved posts at one time.

## After scheduling

- \`get-post\` shows each destination: status (pending, publishing, retrying, published, failed), attempts, next attempt, external link and last error.
- Failed destinations retry automatically after 1, 5, 15 and 60 minutes (5 attempts). The first final failure opens one issue assigned to you (or the post owner).
- On a failure issue: read the error with \`get-post\`. Token or permission errors → ask a person to reconnect the account, then \`retry-post\`. Content errors (too long, wrong media) → create a corrected post for only the failed accounts and send it for review; the published destinations stay as they are. Transient errors (timeouts, rate limits, 5xx) → \`retry-post\`. Published destinations are never published twice.
- Close the issue with a comment saying what you did.

## Inbox

- \`list-inbox\` returns comments and mentions pulled every 15 minutes (Facebook, Instagram, Threads, YouTube comments on recent posts; X, Bluesky and Mastodon mentions).
- \`reply-inbox\` replies through the platform when it supports replies. Unless the company turned on agent replies, your reply is saved as a suggestion that a person sends. Keep replies short, friendly and on brand; never argue, never share private details, escalate complaints to a person.
- \`mark-inbox-read\` when handled.

## Analytics and feeds

- \`post-analytics\` (one post or the whole company) and \`account-analytics\` return views, likes, comments and shares from snapshots taken 1 hour, 24 hours, 7 days and 30 days after publishing. Never invent numbers; if a platform has none yet, say so.
- \`create-rss-feed\` turns new feed items into draft posts (with destinations) for review. \`pause-rss-feed\`/\`resume-rss-feed\` control it.

## Tool list

list-clients, list-connected-accounts, connect-account, refresh-account, create-post, update-post, get-post, list-posts, validate-post, attach-destination, detach-destination, request-review, schedule-post, bulk-schedule, retry-post, create-template, list-templates, list-media-assets, create-media-asset, import-media-from-url, create-rss-feed, list-rss-feeds, pause-rss-feed, resume-rss-feed, list-inbox, mark-inbox-read, reply-inbox, record-inbox-item, post-analytics, account-analytics, record-post-metrics.
`;

const CONTENT_DESCRIPTION =
  "Write platform-native social copy for Partners in Biz clients: per-platform length limits, tone, hashtags, media specs and override rules for Facebook, Instagram, Threads, LinkedIn, X, TikTok, YouTube, Pinterest, Reddit, Bluesky, Mastodon and Dribbble.";

export const SOCIAL_CONTENT_BODY = `# Social content

Use this with \`social-publish\` whenever you write or rewrite post copy.

## Before you write

1. Know the client: brand voice, offer, audience, what they posted recently (\`list-posts\` with \`clientRef\`). If the brand voice is unknown, ask or keep it plain and professional.
2. One idea per post. Lead with the hook in the first line; most platforms truncate after 1-3 lines.
3. Write the main \`body\` for the richest platform in the set (usually LinkedIn or Facebook), then add \`overrides\` for platforms with tighter limits or different norms. Never let a platform fall back to text that breaks its limit: \`validate-post\` will flag it.
4. Put links in the platform's link field (\`overrides.<platform>.link\`) where it has one. Instagram and TikTok captions do not make links clickable; say "link in bio" there.
5. Use the first comment (\`firstComment\`) for extra hashtags or a link on Instagram, Facebook and LinkedIn when it keeps the caption clean.

## Quick limits

| Platform | Text | Media | Notes |
|---|---|---|---|
| Facebook | 63,206 (aim 40-80 words) | up to 10 images or 1 video | link previews work |
| Instagram | 2,200 caption | 1-10 images/videos (required) | 3-10 hashtags, link in bio |
| Threads | 500 | up to 20 | conversational, 0-1 hashtag |
| LinkedIn | 3,000 (hook in 200) | up to 20 images or 1 video | 3-5 hashtags at the end |
| X | 280 weighted (URL = 23) | 4 images or 1 video | 1-2 hashtags |
| TikTok | 2,200 caption | exactly 1 video (required) | privacy override |
| YouTube | title 100, description 5,000 | exactly 1 video (required) | title override, privacy default private |
| Pinterest | title 100, description 500 | 1-5 images (required) | board + link |
| Reddit | title 300, body 40,000 | link or 1 image | subreddit required, no hashtags |
| Bluesky | 300 graphemes | up to 4 images (under 1 MB each) | no algorithm; plain voice |
| Mastodon | 500 | up to 4 | CamelCase hashtags for accessibility |
| Dribbble | title + description | exactly 1 image | design work only |

Full per-platform guidance: \`references/platforms.md\`.

## Always

- Write in the client's language and spelling (South African English by default: organise, colour, programme).
- No fake urgency, no fabricated stats or testimonials, no claims the client has not approved.
- Alt text on every image (\`altText\` on the media asset) describing what is in it.
- Emojis: at most 2-3, never as a replacement for words.
- CTA matches the platform: comment/save on Instagram, click on Facebook/LinkedIn, reply on X/Threads/Bluesky.
`;

export const PLATFORMS_REFERENCE = `# Platform reference

Per-platform rules for Partners in Biz social copy. Limits are hard limits enforced by the platforms; guidance is what performs.

## Facebook (Pages)
- Text up to 63,206 characters; best results at 40-80 words. The first 2 lines show before "See more".
- Link posts: put the URL in \`overrides.facebook.link\` so Facebook builds a preview. With images, the link is appended to the caption.
- Media: up to 10 images (multi-photo post) or 1 video. JPEG/PNG; videos MP4.
- Hashtags: 0-3, optional.
- First comment works well for extra links.

## Instagram (business/creator)
- Media is required: 1 image/video, or a 2-10 item carousel. Videos publish as Reels.
- Caption up to 2,200 characters; the first 125 characters show in feed. Hook first.
- Hashtags: 3-10 relevant ones, in the caption end or the first comment. Max 30.
- Links are not clickable: use "link in bio".
- Images: JPEG, aspect ratio between 4:5 and 1.91:1 (1080x1350 portrait works best). Reels: 9:16 MP4, 3-90 seconds for best reach.

## Threads
- 500 characters. Conversational, first-person, questions do well.
- One link is allowed (\`overrides.threads.link\` makes it a link attachment on text posts).
- Up to 20 images/videos as a carousel.
- 0-1 hashtag (Threads uses a single topic tag).

## LinkedIn
- 3,000 characters; hook within the first 200 (before "…see more").
- Professional, specific, lessons and outcomes. Short paragraphs, white space.
- 3-5 hashtags at the end. Tagging people/companies with @ is not supported from here; write their names.
- Media: up to 20 images or 1 video (MP4, up to 10 minutes works best). Link posts show an article card; put the URL in \`overrides.linkedin.link\`.
- Company page posts need the page account (organization) connected; personal posts use the member account.

## X
- 280 characters weighted: every URL counts 23; emoji and CJK count 2. Premium accounts may post longer.
- Punchy, one idea. 1-2 hashtags max.
- Up to 4 images or 1 video (MP4, up to 140 seconds).
- Use \`overrides.x.text\` whenever the main body is longer.
- The first comment is posted as a reply (thread-style follow-up).

## TikTok
- Exactly one vertical video (9:16 MP4, 3-10 minutes allowed; 15-60 seconds performs best). Hosted on the R2 media domain.
- Caption up to 2,200 characters with 3-5 hashtags.
- Privacy override (\`overrides.tiktok.privacy\`): SELF_ONLY, MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR, PUBLIC_TO_EVERYONE. Until the TikTok app passes audit, only SELF_ONLY works.

## YouTube
- Exactly one video. Title up to 100 characters (\`overrides.youtube.title\`), description up to 5,000.
- Privacy: private (default), unlisted or public (\`overrides.youtube.privacy\`). Unverified Google apps can only upload private videos.
- Shorts: vertical, under 60 seconds; add #Shorts to the title or description.
- Put links and chapters in the description.

## Pinterest
- 1 image, or 2-5 images as a carousel. 2:3 vertical (1000x1500) works best.
- Title up to 100 characters (\`overrides.pinterest.title\`), description up to 500: keyword-rich, describe what the pin helps with.
- Always set a destination link (\`overrides.pinterest.link\`).
- Board: the account's board, or \`overrides.pinterest.boardId\`.

## Reddit
- A subreddit is required (\`overrides.reddit.subreddit\` or the account default). Read the subreddit rules first; many ban self-promotion.
- Title up to 300 characters (\`overrides.reddit.title\`), no clickbait, no hashtags, no emojis.
- A link (or the first image) makes a link post; otherwise a text post with the body.
- Write like a community member: value first, disclose affiliation.

## Bluesky
- 300 characters (graphemes). Links, @handle.domain mentions and #tags are linked automatically.
- Up to 4 images, each under 1 MB. No video from here.
- Tech-savvy, early-adopter audience; plain, human voice.

## Mastodon
- 500 characters on most instances. Use CamelCase hashtags (#SmallBusiness) so screen readers read them.
- Up to 4 attachments; always add alt text.
- Visibility override: public, unlisted, private.

## Dribbble
- Exactly one image (shot). Design work only: UI, branding, illustration.
- Title (\`overrides.dribbble.title\`) plus a short description of the brief and the solution. Hashtags become tags.

## Media specs summary
- Images: JPEG or PNG, sRGB, at least 1080 px on the short side. Keep text on images under 20% of the area.
- Video: MP4 (H.264/AAC), 30 fps, under 512 MB for upload here.
- Always fill alt text on the media asset.
`;

export const SOCIAL_AGENT_INSTRUCTIONS = `# Social Media Manager

You run social media for Partners in Biz and its clients inside Paperclip.

- Your skills: \`social-publish\` (how to use the Social tools) and \`social-content\` (how to write for each platform). Read both before your first task.
- Clients are CRM companies. Always work for a specific client and pass its CRM id as \`clientRef\`.
- You draft, validate, request review and schedule approved posts. A person approves. You never approve.
- When an issue says a post failed: read the destination errors with \`get-post\`, fix what you can, \`retry-post\` for transient errors, and ask a person to reconnect accounts for token errors. Comment what you did, then close the issue.
- When asked to plan a week: propose 3-5 posts per client per active platform, draft them, and put them in review with a short summary comment for the approver.
- Never invent metrics, quotes, prices or client claims. Never paste secrets or tokens anywhere.
- Keep issue comments short: what you did, what is waiting for a person, links to the posts.
`;

export const PLAN_ROUTINE_DESCRIPTION = `Plan next week's social posts for every active client.

Run procedure:
1. list-clients, then list-connected-accounts per client. Skip clients without connected accounts.
2. For each client, read last week's posts (list-posts with clientRef) and post-analytics to see what worked.
3. Draft 3-5 posts per client per active platform for next week with create-post (media from list-media-assets or import-media-from-url, per-platform overrides, first comments where useful). Follow social-content.
4. validate-post each draft and fix every problem.
5. request-review each post. Do not schedule; a person approves first.
6. Comment on this routine issue with one line per client: posts drafted, platforms, and anything the approver must decide. Then close it.`;

export interface SocialSkill extends PluginManagedSkillDeclaration {
  markdown: string;
}

export const SKILLS: SocialSkill[] = [
  {
    skillKey: "social-publish",
    displayName: "Social publish",
    slug: "pib-social-publish",
    description: PUBLISH_DESCRIPTION,
    markdown: withFrontmatter({ name: "pib-social-publish", description: PUBLISH_DESCRIPTION }, SOCIAL_PUBLISH_BODY),
  },
  {
    skillKey: "social-content",
    displayName: "Social content",
    slug: "pib-social-content",
    description: CONTENT_DESCRIPTION,
    markdown: withFrontmatter({ name: "pib-social-content", description: CONTENT_DESCRIPTION }, SOCIAL_CONTENT_BODY),
    files: [{ path: "references/platforms.md", content: PLATFORMS_REFERENCE }],
  },
];

export const DESIRED_SKILLS = SKILLS.map((skill) => `${SKILL_KEY_PREFIX}/${skill.skillKey}`);
