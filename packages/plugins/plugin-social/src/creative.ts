/**
 * `request-creative`: the Social agent asks for an image or video for a post.
 * One hand-off issue per post (origin `creative:<postId>`), opened for the
 * Creative Producer, else the Social agent, the Account Manager, the Operator
 * or the owner. The claim row in `handoffs` makes it safe to call twice.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { routeWork, teamAgentId, wakeIssue, type TeamRoleKey } from "@partnersinbiz/pib-plugin-kit";
import { clientPrefix } from "./clients.js";
import { destinationsForPost, getAccountsByIds, postMedia, table, type PostRow } from "./db.js";
import { clip, SocialError } from "./domain.js";
import { createIssueSafely, fallbackPerson, ORIGIN_KIND, projectIdForRow, scopeLine, SOCIAL_ORIGINS, socialAgent } from "./issues.js";
import { issueOpen } from "./review.js";
import { isSocialPlatform, PLATFORM_LABELS } from "./platforms.js";

export const CREATIVE_HANDOFF_KIND = "creative";
/** Longest video a request may ask for. */
export const CREATIVE_MAX_SECONDS = 30;
/** The scope's Drive subfolder the finished asset is saved to. */
export const CREATIVE_FOLDER = "02 Assets";

const CLAIM_TAKEOVER = "10 minutes";

/** Not a kit role until the Creative Producer role lands; an unknown key just finds no agent. */
const CREATIVE_ROLE = "creative-producer" as TeamRoleKey;

/** What each platform shows best: one line, for the brief. Platforms not listed take the general line. */
const PLATFORM_SPECS: Record<string, string> = {
  instagram: "Feed 4:5 (1080×1350) or 1:1; Reels and Stories 9:16 (1080×1920). Video up to 30 s here.",
  facebook: "Feed 1:1 or 4:5; Reels and Stories 9:16 (1080×1920).",
  linkedin: "Feed 1:1 (1080×1080) or 1.91:1 (1200×627); video 16:9 or 1:1.",
  x: "16:9 (1600×900) or 1:1; keep the text short, the image carries the post.",
  threads: "1:1 or 4:5; video 9:16.",
  tiktok: "Video 9:16 (1080×1920), no logo overlay in the top or bottom 15%.",
  youtube: "Shorts 9:16 (1080×1920); thumbnail 16:9 (1280×720).",
  pinterest: "2:3 (1000×1500) pins; video 9:16 or 1:1.",
  bluesky: "1:1 or 16:9 image.",
  mastodon: "16:9 or 1:1 image.",
  reddit: "16:9 or 1:1 image; no watermark.",
  dribbble: "4:3 (1600×1200) shot.",
};
const GENERAL_SPEC = "1:1 (1080×1080) works everywhere; use 9:16 for video.";

export function creativeClaimKey(companyId: string, postId: string): string {
  return `${SOCIAL_ORIGINS.creative}${companyId}:${postId}`;
}

export interface CreativeAssignee {
  assigneeAgentId?: string;
  assigneeUserId?: string;
  via: string;
}

/**
 * The Creative Producer when one runs, else the Social agent, then the Account Manager, the Operator and the owner (kit
 * `routeWork`), then the company's default person. Nothing is left unassigned when anyone exists.
 */
export async function creativeAssignee(ctx: PluginContext, companyId: string): Promise<CreativeAssignee> {
  const producer = await teamAgentId(ctx, companyId, CREATIVE_ROLE).catch(() => null);
  if (producer) return { assigneeAgentId: producer, via: "creative-producer" };
  const social = await socialAgent(ctx, companyId);
  if (social.active && social.agentId) return { assigneeAgentId: social.agentId, via: "social" };
  const route = await routeWork(ctx, companyId, ["social", "account-manager"]).catch(() => null);
  if (route?.assigneeAgentId) return { assigneeAgentId: route.assigneeAgentId, via: route.via };
  const userId = route?.assigneeUserId ?? (await fallbackPerson(ctx, companyId));
  return userId ? { assigneeUserId: userId, via: "person" } : { via: "none" };
}

export interface CreativeBriefInput {
  post: Pick<PostRow, "id" | "body" | "first_comment" | "client_kind" | "client_ref" | "client_name" | "media">;
  platforms: string[];
  brief: string | null;
  format: "image" | "video";
  durationS: number | null;
}

/** Issue text for the hand-off. Pure. */
export function creativeDescription(input: CreativeBriefInput): string {
  const { post } = input;
  const labels = input.platforms.map((p) => (isSocialPlatform(p) ? PLATFORM_LABELS[p] : p));
  const specs = input.platforms.length ? [...new Set(input.platforms)].map((p) => `- ${isSocialPlatform(p) ? PLATFORM_LABELS[p] : p}: ${PLATFORM_SPECS[p] ?? GENERAL_SPEC}`) : [`- ${GENERAL_SPEC}`];
  const existing = postMedia(post as PostRow);
  return [
    `Make the ${input.format} for this social post so it can go to review with media. Post id: \`${post.id}\`.`,
    "",
    scopeLine(post),
    `**Destinations:** ${labels.length ? labels.join(", ") : "none yet"}`,
    input.brief ? `\n**Brief:** ${input.brief}` : "",
    "",
    "> " + clip(post.body, 1500).replace(/\n/g, "\n> "),
    "",
    "**Platform spec**",
    ...specs,
    input.format === "video" ? `Video: **${input.durationS ?? CREATIVE_MAX_SECONDS} seconds at most** (never over ${CREATIVE_MAX_SECONDS}), captions burned in, the hook in the first 2 seconds.` : "Image: one clear subject, text on it short enough to read on a phone.",
    "",
    "**Done when**",
    `1. The asset is saved to this scope's Drive folder \`${CREATIVE_FOLDER}\` and registered with \`create-media-asset\` for the same scope (pass the same client).`,
    "2. **Alt text is required**: say what the image or video shows in one or two sentences. An asset without alt text does not pass review.",
    `3. Attach it to the post (\`update-post\` with \`mediaAssetIds\`), then comment here with the asset id and close this issue. ${existing.length ? `The post already has ${existing.length} media item${existing.length === 1 ? "" : "s"}: replace or add as the brief says.` : "The post has no media yet."}`,
    "4. Only this scope's brand, accounts and media. Do not publish, schedule or send the post: it goes back to review after the asset is attached.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export interface CreativeOutcome {
  issueId: string;
  created: boolean;
  assignedTo: string;
  message: string;
}

/**
 * Open (or find) the post's creative request. Safe to call repeatedly: one
 * issue per post; a closed one is reopened with the new brief. Throws
 * `SocialError` for a post that cannot take media now.
 */
export async function requestCreative(
  ctx: PluginContext,
  companyId: string,
  post: PostRow,
  input: { brief?: string | null; format?: string | null; durationS?: number | null },
): Promise<CreativeOutcome> {
  if (post.status !== "draft" && post.status !== "review") throw new SocialError(`The post is ${post.status.replace("_", " ")}: only a draft or a post in review can ask for media.`);
  const format = input.format === "video" ? "video" : "image";
  if (input.format && input.format !== "image" && input.format !== "video") throw new SocialError('format must be "image" or "video"');
  const durationS = input.durationS ?? null;
  if (durationS != null && (!Number.isInteger(durationS) || durationS < 1 || durationS > CREATIVE_MAX_SECONDS)) {
    throw new SocialError(`durationS must be a whole number from 1 to ${CREATIVE_MAX_SECONDS}`);
  }
  const brief = input.brief?.trim() ? clip(input.brief.trim(), 1500) : null;
  const handoffs = table(ctx, "handoffs");
  const key = creativeClaimKey(companyId, post.id);
  const assignee = await creativeAssignee(ctx, companyId);

  const existing = await ctx.db.query<{ issue_id: string | null }>(`SELECT issue_id FROM ${handoffs} WHERE key = $1 AND company_id = $2 LIMIT 1`, [key, companyId]);
  const known = existing[0]?.issue_id ?? null;
  if (known) {
    if (await issueOpen(ctx, companyId, known)) {
      if (brief) await ctx.issues.createComment(known, `The Social agent added to the brief:\n\n${brief}`, companyId);
      return { issueId: known, created: false, assignedTo: "existing", message: "This post already has an open creative request. It is not opened twice." };
    }
    // A finished request and a new ask (the media was rejected): the same issue goes back to work.
    const patch = assignee.assigneeAgentId ? { status: "todo" as const, assigneeAgentId: assignee.assigneeAgentId, assigneeUserId: null } : { status: "todo" as const, assigneeAgentId: null, assigneeUserId: assignee.assigneeUserId ?? null };
    await ctx.issues.update(known, patch, companyId);
    await ctx.issues.createComment(known, `The post needs new media.${brief ? `\n\n**Brief:** ${brief}` : " Check the post's latest text."}`, companyId);
    if (assignee.assigneeAgentId) await wakeIssue(ctx, known, companyId, "New media requested for a social post");
    return { issueId: known, created: false, assignedTo: assignee.via, message: "The earlier creative request was reopened." };
  }

  const claim = await ctx.db.execute(
    `INSERT INTO ${handoffs} AS h (key, company_id, kind, payload) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (key) DO UPDATE SET claimed_at = now()
      WHERE h.issue_id IS NULL AND h.claimed_at < now() - interval '${CLAIM_TAKEOVER}'`,
    [key, companyId, CREATIVE_HANDOFF_KIND, JSON.stringify({ postId: post.id })],
  );
  if ((claim.rowCount ?? 0) === 0) {
    const row = await ctx.db.query<{ issue_id: string | null }>(`SELECT issue_id FROM ${handoffs} WHERE key = $1 AND company_id = $2 LIMIT 1`, [key, companyId]);
    if (row[0]?.issue_id) return { issueId: row[0].issue_id, created: false, assignedTo: "existing", message: "This post already has a creative request." };
    throw new SocialError("Another run is opening this creative request. Call request-creative again in a minute.");
  }

  const destinations = await destinationsForPost(ctx, post.id);
  const accounts = await getAccountsByIds(ctx, companyId, destinations.map((d) => d.account_id));
  const issue = await createIssueSafely(ctx, {
    companyId,
    projectId: await projectIdForRow(ctx, companyId, post),
    title: `${clientPrefix(post)}Make the ${format} for social post: ${clip(post.body.replace(/\s+/g, " ").trim(), 60)}`,
    description: creativeDescription({ post, platforms: accounts.map((a) => a.platform), brief, format, durationS }),
    priority: "medium",
    originKind: ORIGIN_KIND,
    originId: `${SOCIAL_ORIGINS.creative}${post.id}`,
    assigneeAgentId: assignee.assigneeAgentId,
    assigneeUserId: assignee.assigneeUserId,
    wakeReason: "A social post needs media",
  });
  await ctx.db.execute(`UPDATE ${handoffs} SET issue_id = $3 WHERE key = $1 AND company_id = $2`, [key, companyId, issue.id]);
  return { issueId: issue.id, created: true, assignedTo: assignee.via, message: `Creative request opened for ${assignee.via}.` };
}
