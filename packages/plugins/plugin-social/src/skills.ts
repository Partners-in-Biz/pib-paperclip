/**
 * Managed skills (used by the manifest and by the worker's versioned sync).
 * Canonical keys on the host: plugin/partnersinbiz-social/<skillKey>.
 */
import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { ASK_OWNER_TOOL, withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const SKILL_KEY_PREFIX = "plugin/partnersinbiz-social";

const PUBLISH_DESCRIPTION =
  "Operate the Partners in Biz Social plugin: work in one scope (PiB's own work or one client), draft posts with media and per-platform overrides, send them for approval, schedule approved posts, retry failures, work the Jev-triaged social inbox, and run the Growth Lab (performance review, experiments, playbook). Use for any social posting, scheduling, inbox or performance task.";

export const SOCIAL_PUBLISH_BODY = `# Social publish

You manage social posting for Partners in Biz (its own accounts) and its clients with the \`partnersinbiz.social\` tools. The plugin talks to the real platforms (Facebook Pages, Instagram, Threads, LinkedIn, X, TikTok, YouTube, Pinterest, Reddit, Bluesky, Mastodon, Dribbble). Tokens never reach you.

## Scope

Every account, post, media asset, feed and inbox item belongs to exactly one scope:

- **Own work** (PiB's own socials): call the tools **without** a client.
- **Client work**: a CRM company, or a CRM contact (a sole trader). Pass \`client: "company:<id>"\` or \`"contact:<id>"\` (or \`clientKind\` + \`clientRef\`) on every call. Take it from the issue you are working on (every Social issue states its scope), or from \`list-clients\`.
- **Never mix scopes.** A post only uses accounts and media of its own scope; the tools refuse anything else. List tools return one scope at a time, so a client's accounts never show up in own work and the other way round.

## Ground rules

- **Clients come from the CRM.** Call \`list-clients\` for companies and contacts. Never invent a client or type a name instead of an id.
- **You draft and schedule. A person approves.** You create and edit drafts, give each a proposed time and request review. Only a person approves, and approval schedules the post at its proposed time. You schedule approved posts that have no time. Never claim a post is published: the \`publish-due\` job publishes it and records the result.
- **Accounts are connected by a person** (signing in to the platform is a one-time grant). When an account shows \`needs_reconnect\`, the plugin has already opened a "Reconnect …" issue for a person; do not schedule to it until it is \`connected\` again. If you need an account the scope does not have, ask once with \`${ASK_OWNER_TOOL}\`: the platform, why, and the steps from \`connect-account\` (it returns the deep link).
- \`visibility\` is \`org\` (the default: company and client pages) or \`personal\` (a person's own profile, only for that person). An organisation post cannot target a personal account.
- Never paste tokens, secrets or passwords into posts, comments or issues.
- When you close an issue this module opened, it checks the work; if it reopens, it lists what's missing: finish those.

## Workflow for a post

1. Decide the scope (own work, or the client from the issue / \`list-clients\`). \`list-connected-accounts\` in that scope → choose destination account ids. Only use accounts with status \`connected\`.
2. Media: reuse \`list-media-assets\` (same scope), or \`import-media-from-url\` with the same client (public https image or MP4, stored on R2). Pass asset ids as \`mediaAssetIds\` (order = carousel order). Do not paste raw URLs as media.
3. \`create-post\` with \`body\`, the scope (\`client\`, or nothing for own work), \`accountIds\`, \`mediaAssetIds\`, a proposed time \`scheduledAt\` (ISO with offset, e.g. \`2026-10-05T07:30:00+02:00\`; pick it from the playbook and the calendar), optional \`firstComment\` and \`overrides\`. Load the \`social-content\` skill to write platform-native copy.
4. \`overrides\` is keyed by platform: \`{ "x": { "text": "…" }, "youtube": { "title": "…", "privacy": "unlisted" }, "reddit": { "subreddit": "smallbusiness", "title": "…" }, "pinterest": { "boardId": "…", "link": "https://…" }, "tiktok": { "privacy": "SELF_ONLY" } }\`. Fields: text, title, link, privacy, subreddit, boardId. Anything not overridden falls back to the main body.
5. \`validate-post\` → fix every problem it lists (usually text too long for X/Bluesky/Threads/Mastodon, or missing media for Instagram/TikTok/YouTube/Pinterest).
6. \`request-review\`. The post waits in the approval queue (the Cockpit shows it to the approver; the Reviewer checks it first when there is one). Nothing else is needed from you.
7. When a person approves, the post is scheduled at its proposed time if that is still ahead and every destination passes \`validate-post\`. Otherwise you get one **"Schedule approved social posts"** issue per scope: pick a time for each approved post (\`list-posts\` status approved) and \`schedule-post\` (or \`bulk-schedule\` for several at one time). Do not change approved content.

## After scheduling

- \`get-post\` shows each destination: status (pending, publishing, retrying, published, failed), attempts, next attempt, external link and last error.
- Failed destinations retry automatically after 1, 5, 15 and 60 minutes (5 attempts). The first final failure opens one issue assigned to you (or the post owner).
- On a failure issue: read the error with \`get-post\`. Token or permission errors → the account needs a person to sign in again: the plugin opens a reconnect issue for them (if none exists, ask once with \`${ASK_OWNER_TOOL}\` and the Social → Accounts link), then \`retry-post\` once it is \`connected\`. Content errors (too long, wrong media) → create a corrected post for only the failed accounts and send it for review, then \`detach-destination\` those accounts from the failed post; the published destinations stay as they are. Transient errors (timeouts, rate limits, 5xx) → \`retry-post\`. Published destinations are never published twice.
- Close the issue with a comment saying what you did.

## Inbox

- \`list-inbox\` returns comments and mentions pulled every 15 minutes (Facebook, Instagram, Threads, YouTube comments on recent posts; X, Bluesky and Mastodon mentions).
- Every new item is triaged and carries \`triage\`: \`needsReply\`, \`intent\` (question, complaint, praise, lead, spam, other), \`sentiment\`, \`escalate\` and \`source\` (\`jev\` when a Jev key is set, else \`rules\`, the built-in keyword rules, with \`reasons\`). Spam is marked read for you. Items that need a reply arrive as **one issue per account per day** ("Reply to social comments: …") listing the \`itemId\`s; more comments that day are added as comments on it. Items with legal, safety or PR risk go to a person, never to you: do not reply to them.
- \`reply-inbox\` replies through the platform when it supports replies. Unless the company turned on agent replies, your reply is saved as a suggestion that a person sends. Keep replies short, friendly and on brand; never argue, never share private details. Complaints: acknowledge and offer a private channel (DM or email).
- \`mark-inbox-read\` when handled. Close the day's issue with one line on what you did.
- **Leads** (intent lead) go to the CRM on their own. For own accounts the CRM opens a follow-up for the Account Manager; a lead on a client's account stays the client's own and gets no follow-up, so your reply is its only answer. Answer every lead and point them to the booking or contact link in the scope's playbook (Constraints). No link there: ask once with \`${ASK_OWNER_TOOL}\`, then add it as a constraint (\`propose-playbook-change\`).

## Hand-offs

- You own repurposing. When an SEO page is live (it answers 200) you get one **"Repurpose for social: …"** issue in that page's scope: draft a LinkedIn post, an X post with a first-comment reply (X takes one post plus one reply, not a thread) and an Instagram post from the page, with the link, following the playbook. Pass the issue's \`handoffKey\` to \`create-post\` so each draft is linked to the page (and stays in its scope). Drafts with proposed times, then \`request-review\`. Close the issue with the post ids: the SEO agent links them to the page.
- With a Reviewer set in the Cockpit, posts in review get a check from the Reviewer before a person approves. Fix what it lists, then send the post for review again.

## Analytics and feeds

- \`post-analytics\` (one post, or totals for one scope) and \`account-analytics\` (one scope) return views, likes, comments and shares from snapshots taken 1 hour, 24 hours, 7 days and 30 days after publishing. Never invent numbers; if a platform has none yet, say so.
- \`create-rss-feed\` turns new feed items into draft posts (with destinations) for review. \`pause-rss-feed\`/\`resume-rss-feed\` control it.

## Growth Lab (what works, per scope)

Each scope (own work, each client) has a Growth program: a goal ("engagement rate lift at 7d"), an autopilot mode and a **playbook** (markdown rules you follow when planning). The loop works like autoresearch:

- **Score.** The daily \`score-posts\` job scores every published destination on its 7-day numbers: weighted engagement ÷ reach (else impressions, else views), against the same account's median over the 30 days before it (its own post excluded). Lift +0.2 = 20% better than usual. Posts without reach numbers are not scored.
- **Features.** Each published post is tagged once: format, length and posting daypart in code; hook, CTA, topic (when the program lists topics) and tone by Jev from the caption only; plus the program's own questions.
- **Review.** \`performance-review\` (one scope): top and bottom 5 posts with features and lift, median lift per feature value, running experiments, pending playbook changes, and hypothesis types ranked by UCB (untried types first, then what has won).
- **Experiment.** \`propose-experiment\` changes **one** variable: \`hypothesisType\` like \`hook:question\`, arms \`control\` (what we do now) and \`variant\` (the change), at least 3 posts per arm. Max 3 running per scope. Then tag each post with \`experimentId\` + \`arm\` on \`create-post\` / \`update-post\`. The daily \`measure-experiments\` job decides win / loss / no change / inconclusive when each arm has its 7-day scores (or after 21 days) and drafts a playbook change for a win or a loss.
- **Playbook.** \`get-playbook\` before planning. \`propose-playbook-change\` (add a rule, remove a line, or replace) with a reason. \`decide-playbook-change\` keeps (new version) or discards.
- **Feature discovery.** When the top and bottom posts differ in a way no feature captures, \`propose-feature-question\` adds a question Jev asks about every caption (yes/no, choice or score; at most 12). It backfills the last 90 days. Retire questions that never separate anything.
- **Autopilot.** off: you only read. safe (default): you propose; a person approves experiments and keeps or discards changes from one approval issue per program per week. Never approve or decide yourself. full: your proposals start at once, you may decide changes, and wins are kept automatically.
- \`list-experiments\` shows arms, tagged/published/scored counts per arm and verdicts. Never invent results; say "not measured yet" when it is not.

## Tool list

list-clients, list-connected-accounts, connect-account, refresh-account, create-post, update-post, get-post, list-posts, validate-post, attach-destination, detach-destination, request-review, schedule-post, bulk-schedule, retry-post, create-template, list-templates, list-media-assets, create-media-asset, import-media-from-url, create-rss-feed, list-rss-feeds, pause-rss-feed, resume-rss-feed, list-inbox, mark-inbox-read, reply-inbox, record-inbox-item, post-analytics, account-analytics, record-post-metrics, performance-review, get-playbook, propose-playbook-change, decide-playbook-change, list-experiments, propose-experiment, approve-experiment, reject-experiment, propose-feature-question.
`;

const CONTENT_DESCRIPTION =
  "Write platform-native social copy for Partners in Biz clients: per-platform length limits, tone, hashtags, media specs and override rules for Facebook, Instagram, Threads, LinkedIn, X, TikTok, YouTube, Pinterest, Reddit, Bluesky, Mastodon and Dribbble.";

export const SOCIAL_CONTENT_BODY = `# Social content

Use this with \`social-publish\` whenever you write or rewrite post copy.

## Before you write

1. Know who you write for: PiB itself (own work, no client) or one client (\`client\` from the issue or \`list-clients\`). Read their brand voice (the Growth program's constraints and the playbook: \`get-playbook\`), offer, audience and what they posted recently (\`list-posts\` in that scope). If the brand voice is unknown, keep it plain and professional and ask once with \`${ASK_OWNER_TOOL}\` for the voice, then add it to the playbook (\`propose-playbook-change\`, section constraints).
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

## Follow the playbook

- Call \`get-playbook\` for the scope before you write. Follow "Rules we follow", avoid "Things that did not work", and respect "Constraints". When a rule and this skill disagree, the playbook wins for that client.
- A post in an experiment changes only the tested variable. Control posts follow the playbook as it is; variant posts make the one change and nothing else. Tag each with \`experimentId\` + \`arm\`.

## Weekly social review & plan

For each scope with connected accounts (own work first, then each client):
1. \`performance-review\` (default 28 days).
2. Write the insights as a comment on the routine issue: what the top posts share, what the bottom posts share, which feature values lift or drag (with post counts), and the state of running experiments. Numbers only from the review.
3. Propose at most 2 experiments (\`propose-experiment\`), picking hypothesis types high in \`rankedHypothesisTypes\` that are not running. If the top and bottom posts differ in something no feature measures, use \`propose-feature-question\` instead of guessing.
4. Pending playbook changes: on full autopilot decide them (\`decide-playbook-change\`); otherwise they wait on the scope's weekly Growth approval issue, where a person decides. List them in your summary; do not ask again.
5. Draft next week's posts following the playbook (\`get-playbook\`), each with a proposed time (\`scheduledAt\`), tagging the arms of running (or just proposed) experiments so each arm gets at least its minimum number of posts. \`validate-post\`, then \`request-review\`; approval schedules them.

## Scope

- Own work = no client. Client work = pass \`client\` (\`company:<id>\` or \`contact:<id>\`) from the issue.
- Never reuse one client's copy, media or accounts for another client or for PiB's own posts. Each scope has its own playbook and experiments.

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

export const PLAN_ROUTINE_TITLE = "Weekly social review & plan";

export const PLAN_ROUTINE_DESCRIPTION = `Weekly social review & plan for PiB's own accounts and every active client (Growth Lab).

Run procedure (details in the pib-social-content skill, "Weekly social review & plan"):
1. list-connected-accounts without a client (own work), then list-clients and list-connected-accounts per client (clientKind + clientRef). Skip scopes without connected accounts.
2. For each scope: performance-review, then comment the insights on this issue (top/bottom posts, feature lifts, running experiments; numbers from the review only).
3. Propose at most 2 experiments per scope (propose-experiment, from the ranked hypothesis types), or a feature question when no feature explains the difference.
4. Pending playbook changes: decide them only on full autopilot (decide-playbook-change); otherwise leave them on the approval issue.
5. Draft next week's posts per scope and active platform with create-post, following get-playbook, each with a proposed time (scheduledAt) and tagging experiment arms (experimentId + arm). validate-post, fix every problem, request-review. Approval schedules each post at its proposed time.
6. Finish with one line per scope (own work, then each client): posts drafted, experiments proposed or running, and anything the approver must decide. Then close this issue.`;

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
