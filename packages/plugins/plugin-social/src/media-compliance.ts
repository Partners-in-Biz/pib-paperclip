/**
 * Media compliance (read-only): of the posts published in a window, how many carried media and alt text, and which
 * posts reached approved, scheduled or published with no Reviewer verdict on record (the unverified publish gate).
 *
 * Media-first means every published post except the experiment `control` arm and posts tagged `text-native`.
 * A verdict is a `review_outcomes` row at stage `reviewer`; owner and client sign-offs do not count as one.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientWhere, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { postMedia, table, type PostRow } from "./db.js";

type ComplianceRow = Pick<PostRow, "id" | "status" | "media" | "overrides" | "experiment_arm" | "published_at">;

export interface MediaCompliance {
  days: number;
  scope: string | null;
  published: number;
  excluded: { controlArm: number; textNative: number };
  mediaFirst: { total: number; withMedia: number; withoutMedia: number; withAltText: number; missingAltText: number };
  postsWithoutMedia: string[];
  postsMissingAltText: string[];
  unverified: { postId: string; status: string }[];
}

function isTextNative(row: Pick<PostRow, "overrides">): boolean {
  const tags = (row.overrides as Record<string, unknown> | null | undefined)?.tags;
  return Array.isArray(tags) && tags.includes("text-native");
}

/** Pure: counts the published rows and lists the ones that miss media or alt text. */
export function summariseCompliance(published: ComplianceRow[], unverified: Pick<PostRow, "id" | "status">[]) {
  const excluded = { controlArm: 0, textNative: 0 };
  const mediaFirst = { total: 0, withMedia: 0, withoutMedia: 0, withAltText: 0, missingAltText: 0 };
  const postsWithoutMedia: string[] = [];
  const postsMissingAltText: string[] = [];
  for (const row of published) {
    if (row.experiment_arm === "control") { excluded.controlArm += 1; continue; }
    if (isTextNative(row)) { excluded.textNative += 1; continue; }
    mediaFirst.total += 1;
    const media = postMedia(row);
    if (media.length === 0) { mediaFirst.withoutMedia += 1; postsWithoutMedia.push(row.id); continue; }
    mediaFirst.withMedia += 1;
    if (media.every((m) => typeof m.altText === "string" && m.altText.trim())) mediaFirst.withAltText += 1;
    else { mediaFirst.missingAltText += 1; postsMissingAltText.push(row.id); }
  }
  return { excluded, mediaFirst, postsWithoutMedia, postsMissingAltText, unverified: unverified.map((r) => ({ postId: r.id, status: r.status })) };
}

/** `media-compliance` for one scope over the last `days` days (posts, most recent 2000 each). */
export async function mediaCompliance(ctx: PluginContext, companyId: string, scope: ClientScope, days: number): Promise<MediaCompliance> {
  const posts = table(ctx, "posts");
  const params: unknown[] = [companyId, days];
  const w = clientWhere(scope, params.length + 1);
  params.push(...w.params);
  const published = await ctx.db.query<ComplianceRow>(
    `SELECT id, status, media, overrides, experiment_arm, published_at FROM ${posts}
      WHERE company_id = $1 AND status = 'published' AND published_at >= now() - make_interval(days => $2) AND ${w.sql}
      ORDER BY published_at DESC LIMIT 2000`,
    params,
  );
  const unverified = await ctx.db.query<Pick<PostRow, "id" | "status">>(
    `SELECT id, status FROM ${posts}
      WHERE company_id = $1 AND status IN ('approved', 'scheduled', 'published') AND updated_at >= now() - make_interval(days => $2) AND ${w.sql}
        AND NOT EXISTS (SELECT 1 FROM ${table(ctx, "review_outcomes")} o WHERE o.post_id = ${posts}.id AND o.company_id = $1 AND o.stage = 'reviewer')
      ORDER BY updated_at DESC LIMIT 2000`,
    params,
  );
  return { days, scope: scope ? `${scope.kind}:${scope.id}` : null, published: published.length, ...summariseCompliance(published, unverified) };
}
