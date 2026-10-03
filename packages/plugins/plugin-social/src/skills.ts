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
- **You draft and schedule. A person approves** (for a client the policy can name the client: see Approvals below). You create and edit drafts, give each a proposed time and request review. You never approve, and never change who approves. Approval schedules the post at its proposed time. You schedule approved posts that have no time. Never claim a post is published: the \`publish-due\` job publishes it and records the result.
- **Accounts are connected by a person** (signing in to the platform is a one-time grant). When an account shows \`needs_reconnect\`, the plugin has already opened a "Reconnect …" issue for a person; do not schedule to it until it is \`connected\` again. If you need an account the scope does not have, call \`connect-account\` with the issue you are working on, then ask once with \`${ASK_OWNER_TOOL}\`: the platform, why, and the link and steps it returns (plus its \`effect\`, when ask-owner takes one). When the account is connected the plugin comments on your issue and wakes you: do not poll.
- \`visibility\` is \`org\` (the default: company and client pages) or \`personal\` (a person's own profile, only for that person). An organisation post cannot target a personal account.
- Never paste tokens, secrets or passwords into posts, comments or issues.
- When you close an issue this module opened, it checks the work; if it reopens, it lists what's missing: finish those.

## Workflow for a post

1. Decide the scope (own work, or the client from the issue / \`list-clients\`). \`list-connected-accounts\` in that scope → choose destination account ids. Only use accounts with status \`connected\`.
2. Media: reuse \`list-media-assets\` (same scope), or \`import-media-from-url\` with the same client (public https image or MP4, stored on R2). A file you made yourself (a carousel slide, a branded image, a short video): attach it to your issue, \`list-issue-attachments\`, then \`import-media-from-attachment\` (an asset id comes back, never a link). How to make them: \`references/media-studio.md\` in the social-content skill. Pass asset ids as \`mediaAssetIds\` (order = carousel order). Do not paste raw URLs as media.
3. \`create-post\` with \`body\`, the scope (\`client\`, or nothing for own work), \`accountIds\`, \`mediaAssetIds\`, a proposed time \`scheduledAt\` (ISO with offset, e.g. \`2026-10-05T07:30:00+02:00\`; pick it from the playbook and the calendar), optional \`firstComment\` and \`overrides\`. Load the \`social-content\` skill to write platform-native copy.
4. \`overrides\` is keyed by platform: \`{ "x": { "text": "…" }, "youtube": { "title": "…", "privacy": "unlisted" }, "reddit": { "subreddit": "smallbusiness", "title": "…" }, "pinterest": { "boardId": "…", "link": "https://…" }, "tiktok": { "privacy": "SELF_ONLY" } }\`. Fields: text, title, link, privacy, subreddit, boardId. Anything not overridden falls back to the main body.
5. \`validate-post\` → fix every problem it lists (usually text too long for X/Bluesky/Threads/Mastodon, or missing media for Instagram/TikTok/YouTube/Pinterest).
6. \`request-review\`. The post waits in the approval queue (the Cockpit shows it to the approver; the Reviewer checks it first when there is one). Nothing else is needed from you.
7. When a person approves, the post is scheduled at its proposed time if that is still ahead and every destination passes \`validate-post\`. Otherwise you get one **"Schedule approved social posts"** issue per scope: pick a time for each approved post (\`list-posts\` status approved) and \`schedule-post\` (or \`bulk-schedule\` for several at one time). Do not change approved content.

## Approvals

- \`request-review\` opens the post's review issue by the scope's policy (\`get-approval-policy\`). Sign-offs: the Reviewer's pass (a check), a team member's approval, the client's approval. The post is approved when every sign-off the policy needs is in **for its current version**: editing it makes earlier sign-offs stale. \`get-approval-status\` shows where one post stands.
- **Client approval.** On an issue "Get client approval for social post…" call \`request-client-approval\`: it returns the client's link, the people at the client and a ready email. Make a Mailbox DRAFT (\`partnersinbiz.mailbox:create-draft\`) and never send it: a person does. Then ask the owner once to send it. The plugin comments on the issue and wakes you when the client answers. Changes requested: the post is back in draft; fix it, \`request-review\` again and make a new link.
- **Reviewer:** check the post, then \`record-review-verdict\` (pass, or changes with notes). Do not reassign the issue: the plugin hands it on.
- \`review-outcomes\` gives first-pass rates per post type. They are inputs for a later autonomy policy; auto-approval is off.
Full flow, statuses and edge cases: \`references/approvals.md\`.

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

list-clients, list-connected-accounts, connect-account, refresh-account, create-post, update-post, get-post, list-posts, validate-post, attach-destination, detach-destination, request-review, get-approval-policy, get-approval-status, request-client-approval, record-review-verdict, review-outcomes, schedule-post, bulk-schedule, retry-post, create-template, list-templates, list-media-assets, create-media-asset, import-media-from-url, list-issue-attachments, import-media-from-attachment, create-rss-feed, list-rss-feeds, pause-rss-feed, resume-rss-feed, list-inbox, mark-inbox-read, reply-inbox, record-inbox-item, post-analytics, account-analytics, record-post-metrics, performance-review, get-playbook, propose-playbook-change, decide-playbook-change, list-experiments, propose-experiment, approve-experiment, reject-experiment, propose-feature-question.
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

## Media studio (pib-media-studio)

Posts need visuals: carousels, branded images, short videos. Make them yourself from the client's brand (their profile, and the colours, fonts and logo from their site): slides as HTML rendered to PNG, videos stitched with ffmpeg, then attach the files to your issue and import them with \`import-media-from-attachment\`. The whole workflow, sizes, safe areas, commands and checks are in \`references/media-studio.md\`: read it before you make a visual. Never use an image you have no rights to, and never invent stats or people.

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

export const APPROVALS_REFERENCE = `# Approvals reference

## Who approves
Each scope (own work, each client) has an approval policy a PERSON sets on Social → Posts → "Who approves". \`get-approval-policy\` shows it; you cannot change it. It lists which sign-offs a post needs:

- **Reviewer's pass** (optional): the Reviewer agent checked this version. A pass is a check, never an approval.
- **Team member** (default): a person clicks Approve on the Social page.
- **Client** (client scopes only): the client approves on their link, or a person records that they approved elsewhere (with a note saying how).

No policy set = a team member approves, as before. At least one of team member or client always approves.

## A post's sign-offs
\`get-approval-status\` returns each sign-off as approved, changes, stale or none, for the post's CURRENT version (a fingerprint of its text, first comment, overrides, media, accounts and proposed time). Edit the post and every earlier sign-off is stale. The post becomes approved the moment the last required sign-off arrives; approval then schedules it at its proposed time (or opens the "Schedule approved social posts" task).

## The client's link
1. \`request-client-approval\` (post in review; the scope's policy asks for the client; the Reviewer passed this version when the policy asks for that; the post validates). It returns \`url\`, \`expiresAt\`, \`recipients\` (people at the client with an email) and \`email\` (subject, text, html).
2. The email is a Mailbox DRAFT. **Never send it**: a person sends the draft. Normally the call itself opens the drafting task for the Account Manager (they hold the mailbox delegation) and says so: then you draft nothing. Only when the call tells you to draft it yourself (no Account Manager is staffed, or you asked for \`draft: "me"\` and hold a delegation), create it with \`partnersinbiz.mailbox:create-draft\` (to a recipient, that subject and text).
3. Ask the owner once with \`${ASK_OWNER_TOOL}\` (kind decision, link \`/mailbox\`) to send it. End your turn.
4. The client opens the page: the post exactly as it will appear on each account, with Approve (their name is required) and Request changes (a note is required). The answer is stored once. Within 5 minutes the plugin comments on the review issue and wakes you.
5. **Approved**: recorded as the client's sign-off; the post is approved if nothing else is needed, else the issue goes to the next approver. **Changes**: the post goes back to draft with the client's note on the issue; fix it, \`request-review\` again, make a new link.
6. A link made for an older version of the post does not count: the plugin says so on the issue. A link that runs out unanswered is closed and you are told; make a new one and send a short reminder (also a draft).
7. Making a new link replaces the previous one. Links are never shown again after you receive them (only a hash is stored): do not paste one into comments or the wiki.
8. The link is the client's. Never open it to answer, and never submit its form: the page records whoever answers as the client. (Where only the client approves, the link IS the approval.)

## The Reviewer
\`record-review-verdict\` with \`pass\` or \`changes\` (notes: one line per problem). Only the company's Reviewer can. After a pass the plugin hands the issue to the Social agent (client approval) or to the person who approves; after changes it returns the post to draft and hands the issue to the Social agent.

## Autonomy inputs
Every Reviewer, team member and client verdict is stored with the post's type (original, repurpose, rss or reply, by format: text, image, carousel, video) and the scope. \`review-outcomes\` returns first-pass approval rates and approval streaks. Nothing graduates on its own: auto-approval is off, and turning it on is the owner's decision.

## If something is off
- "The client approval page is not reachable": a one-time setup for the owner (Setup → Social → Client approval page). Do not send the client anything; ask once with \`${ASK_OWNER_TOOL}\`.
- Own work has no client: it is approved by a team member.
- You may not approve, record a client approval or change a policy: those are people's.
`;

export const MEDIA_STUDIO_REFERENCE = `# Media studio (pib-media-studio)

How to make carousels, branded images and short videos for a client (or for PiB's own accounts) without depending on any provider: slides are HTML/CSS rendered to PNG by Chromium, videos are stitched from slides with ffmpeg. This is the approach that already produced the PARA-4 content batch (carousels at 1080x1350, 9:16 MP4s, a safe-area template); its \`para4-asset-generator.zip\` (attached to issue PARA-4, Partners in Apps) is a working example: copy it when you start, change the copy and brand file, render again.

## 0. Before you make anything
- **One scope.** Everything you make belongs to one client or to own work. Never reuse another client's brand, copy or files.
- **Read the brand.** Call \`get-client-profile\` (CRM) and \`get-playbook\` for the scope. The profile holds the voice (brand voice, tone notes, banned words, audience, website) and, when the client's brand kit is filled in, \`primaryColor\`, \`secondaryColor\`, \`accentColor\`, \`fonts\`, \`logoKey\` and \`toneExamples\` (\`missingBrand\` names what is empty). Use those first. \`logoKey\` is the logo's object key in the company's R2 media folder: find the media asset whose \`r2Key\` equals it with \`list-media-assets\` (same scope; its \`url\` is the public address) and download it into your workspace. For anything the profile does not have, take it from the client's own site (its CSS: background, text and accent colours, the font families, the logo file). Save what you settled on in a \`brand.json\` next to your work: \`{ "name", "colors": { "bg", "fg", "accent" }, "fonts": { "display", "body" }, "logo": "logo.png" }\`. Cannot get them: ask once (\`${ASK_OWNER_TOOL}\`) for the logo file and brand colours (and say they belong in the client's profile), and carry on with a neutral design meanwhile.
- **Rights.** Use only images you may use: client-supplied, the client's brand kit or media library (\`list-media-assets\`), your own render, or an image you generated. Never hotlink, scrape or copy from elsewhere. No fabricated stats, testimonials, prices or people; claims need an approved source, as in the copy.
- **Copy first.** Write the post (\`social-content\`), then make the visual that carries it.

## 1. Pick the format
| Use | Size | Notes |
|---|---|---|
| Instagram / Facebook / LinkedIn carousel or single image | 1080x1350 (4:5) PNG | 2-10 slides; slide 1 is the hook; one idea per slide; last slide a call to action |
| Reel, TikTok, YouTube Short | 1080x1920 (9:16) MP4 | H.264 + AAC, 30 fps, 15-60 s (90 s at most), keep text inside the middle 900x1400: the platform's buttons cover the rest |
| Pinterest | 1000x1500 (2:3) PNG | title and link go in the overrides |
| Link or X card | 1600x900 (16:9) PNG | |
Minimum text size 40 px at 1080 wide; contrast at least 4.5:1; no more than about 25 words a slide.

## 2. Slides: HTML to PNG
Write one HTML file per slide (or one template filled from a JSON list) using the brand file, **escape every piece of text** you put in it, then render. Check \`node -e "require.resolve('playwright')"\` first; if Playwright is not available in your workspace use the Chromium that is installed on the server:

\`\`\`
CHROME=$(ls -d $HOME/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | head -1)
P=$(mktemp -d)
"$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --incognito --user-data-dir="$P" \\
  --window-size=1080,1350 --screenshot=out/slide-01.png file:///abs/path/slide-01.html
rm -rf "$P"
\`\`\`
(\`--incognito\` with a throwaway profile is needed or this Chromium never finishes.) With Playwright: launch Chromium, \`page.setViewportSize({ width: 1080, height: 1350 })\`, \`page.setContent(html)\`, \`page.screenshot({ path })\` per slide. Load the brand fonts as local files or from the client's own CDN, and wait for them (\`document.fonts.ready\`) before the screenshot.

## 3. Videos: slides to MP4
Render 1080x1920 slides, then, three seconds a slide:

\`\`\`
ffmpeg -y -framerate 1/3 -i out/slide-%02d.png -vf "scale=1080:1920,format=yuv420p" -r 30 \\
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart out/reel.mp4
\`\`\`
Add a voice-over or music track you have the rights to with \`-i track.m4a -shortest -c:a aac\`. Screen recordings and B-roll the client supplied can be concatenated the same way. Check the result: \`ffprobe -v error -show_entries stream=width,height,duration -of csv=p=0 out/reel.mp4\` must say 1080,1920 and the length you planned.

## 4. Look at it
Open the first and last slide as images and read the text at phone size. Fix overflow, low contrast, anything outside the safe area, a wrong name or number. A person approves the post, but the Reviewer will send back a visual that is wrong.

## 5. Attach, import, post
1. Attach each file to the issue you are working on (the paperclip skill: \`POST /api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/attachments\`, multipart field \`file\`). A file in your workspace reaches the plugin only this way.
2. \`list-issue-attachments\` with the issue id: the attachment ids and which look importable (an MP4 stored as application/octet-stream is fine: the type is read from the file).
3. \`import-media-from-attachment\` for each (pass the same \`client\` as the post): you get an asset id, plus notes when the size or shape is wrong for a platform (not 9:16, under 1080 px). Add \`altText\` describing the image. Importing the same attachment again returns the same asset. Files up to 64 MB; larger ones need a public URL (\`import-media-from-url\`) or a person's upload on the Social page.
4. \`create-post\` with \`mediaAssetIds\` in slide order, then \`validate-post\` and \`request-review\`.

## 6. AI-generated images and video (optional, never required)
If your run has an image or video generation tool or connection (for example Higgsfield or Seedance), use it for backgrounds or B-roll only and bring the result through steps 2-5. If it does not, write exact, paste-ready prompts in the issue for a person and carry on with the HTML pipeline. Do not pretend a generated person is a real client, employee or customer.

## 7. Keep the generator
Save your templates and scripts as one zip attached to the issue (\`<client>-asset-generator.zip\`) and name it in your close-out comment, so the next run changes the copy instead of rebuilding the design.
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
    files: [{ path: "references/approvals.md", content: APPROVALS_REFERENCE }],
  },
  {
    skillKey: "social-content",
    displayName: "Social content",
    slug: "pib-social-content",
    description: CONTENT_DESCRIPTION,
    markdown: withFrontmatter({ name: "pib-social-content", description: CONTENT_DESCRIPTION }, SOCIAL_CONTENT_BODY),
    files: [
      { path: "references/platforms.md", content: PLATFORMS_REFERENCE },
      { path: "references/media-studio.md", content: MEDIA_STUDIO_REFERENCE },
    ],
  },
];

export const DESIRED_SKILLS = SKILLS.map((skill) => `${SKILL_KEY_PREFIX}/${skill.skillKey}`);
