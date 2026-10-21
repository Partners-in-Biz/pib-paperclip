/**
 * The Social-only half of the growth store: post features, scores, metrics
 * and experiment tags on posts. Same host SQL guard rules as sql.ts.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { textArrayParam, type ScoredPostRow } from "@partnersinbiz/pib-plugin-kit";
import { iso, postMedia, setPostExperiment, table } from "../db.js";
import { json, num, scopeFilter, str, type Row } from "./sql-util.js";
import type { ArmPostCountPort, ExistingScore, MetricRow, SocialFeaturesPort } from "./store.js";

export function sqlFeatures(ctx: PluginContext): SocialFeaturesPort & ArmPostCountPort {
  const T = (name: string) => table(ctx, name);
  return {
    async experimentPosts(companyId, experimentId, window) {
      const rows = await ctx.db.query<Row>(
        `SELECT p.id, p.experiment_arm, p.status, p.published_at,
                COALESCE((SELECT jsonb_agg(s.lift) FROM ${T("post_scores")} s
                           WHERE s.post_id = p.id AND s.metric_window = $3 AND s.lift IS NOT NULL), '[]'::jsonb) AS lifts
           FROM ${T("posts")} p
          WHERE p.company_id = $1 AND p.experiment_id = $2
          ORDER BY p.created_at`,
        [companyId, experimentId, window],
      );
      return rows.map((r) => ({
        postId: String(r.id),
        arm: str(r.experiment_arm),
        status: String(r.status),
        publishedAt: iso(r.published_at),
        lifts: json<unknown[]>(r.lifts, []).map(num).filter((x): x is number => x !== null),
      }));
    },
    setPostExperiment(companyId, postId, experimentId, arm) {
      return setPostExperiment(ctx, companyId, postId, experimentId, arm);
    },

    async companiesWithMetrics(window, sinceDays) {
      const rows = await ctx.db.query<{ company_id: string }>(
        `SELECT DISTINCT company_id FROM ${T("post_metrics")} WHERE metric_window = $1 AND recorded_at >= now() - make_interval(days => $2)`,
        [window, sinceDays],
      );
      return rows.map((r) => r.company_id);
    },
    async metricRows(companyId, window, sinceDays) {
      const rows = await ctx.db.query<Row>(
        `SELECT m.destination_id, m.post_id, COALESCE(m.account_id, d.account_id) AS account_id, m.platform, d.published_at,
                m.likes, m.comments, m.shares, m.saves, m.clicks, m.reach, m.impressions, m.views,
                p.client_kind, p.client_ref, p.client_name
           FROM ${T("post_metrics")} m
           JOIN ${T("destinations")} d ON d.id = m.destination_id
           JOIN ${T("posts")} p ON p.id = m.post_id
          WHERE m.company_id = $1 AND m.metric_window = $2 AND d.published_at IS NOT NULL
            AND d.published_at >= now() - make_interval(days => $3)
          ORDER BY d.published_at
          LIMIT 5000`,
        [companyId, window, sinceDays],
      );
      return rows.map((r): MetricRow => ({
        destinationId: String(r.destination_id),
        postId: String(r.post_id),
        accountId: str(r.account_id),
        platform: str(r.platform),
        publishedAt: iso(r.published_at),
        likes: num(r.likes),
        comments: num(r.comments),
        shares: num(r.shares),
        saves: num(r.saves),
        clicks: num(r.clicks),
        reach: num(r.reach),
        impressions: num(r.impressions),
        views: num(r.views),
        clientKind: str(r.client_kind),
        clientRef: str(r.client_ref),
        clientName: str(r.client_name),
      }));
    },
    async existingScores(companyId, window, sinceDays) {
      const rows = await ctx.db.query<Row>(
        `SELECT destination_id, engagement_rate, baseline_median, baseline_n, lift, program_id FROM ${T("post_scores")}
          WHERE company_id = $1 AND metric_window = $2 AND published_at >= now() - make_interval(days => $3)`,
        [companyId, window, sinceDays],
      );
      const out = new Map<string, ExistingScore>();
      for (const r of rows) {
        out.set(String(r.destination_id), { engagementRate: num(r.engagement_rate) ?? 0, baselineMedian: num(r.baseline_median), baselineN: num(r.baseline_n) ?? 0, lift: num(r.lift), programId: str(r.program_id) });
      }
      return out;
    },
    async upsertScore(s) {
      await ctx.db.execute(
        `INSERT INTO ${T("post_scores")}
          (destination_id, metric_window, company_id, post_id, account_id, platform, program_id, client_kind, client_ref, engagement_rate, basis,
           baseline_median, baseline_n, lift, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz)
         ON CONFLICT (destination_id, metric_window) DO UPDATE
           SET engagement_rate = EXCLUDED.engagement_rate, basis = EXCLUDED.basis, baseline_median = EXCLUDED.baseline_median,
               baseline_n = EXCLUDED.baseline_n, lift = EXCLUDED.lift, program_id = EXCLUDED.program_id, scored_at = now()`,
        [
          s.destinationId, s.window, s.companyId, s.postId, s.accountId, s.platform, s.programId, s.clientKind, s.clientRef, s.engagementRate, s.basis,
          s.baselineMedian, s.baselineN, s.lift, s.publishedAt,
        ],
      );
    },

    async postsToTag(companyId, sinceDays, limit) {
      const rows = await ctx.db.query<Row>(
        `SELECT p.id, p.body, p.media, p.client_kind, p.client_ref, p.client_name,
                COALESCE((SELECT min(d.published_at) FROM ${T("destinations")} d WHERE d.post_id = p.id AND d.published_at IS NOT NULL), p.published_at) AS first_published_at,
                COALESCE((SELECT jsonb_agg(f.feature_key) FROM ${T("post_features")} f WHERE f.post_id = p.id), '[]'::jsonb) AS feature_keys
           FROM ${T("posts")} p
          WHERE p.company_id = $1 AND p.status IN ('published', 'partially_published')
            AND COALESCE(p.published_at, p.updated_at) >= now() - make_interval(days => $2)
          ORDER BY p.created_at DESC
          LIMIT $3`,
        [companyId, sinceDays, Math.min(Math.max(limit, 1), 1000)],
      );
      return rows.map((r) => ({
        id: String(r.id),
        body: String(r.body ?? ""),
        media: postMedia({ media: r.media }),
        publishedAt: iso(r.first_published_at),
        clientKind: str(r.client_kind),
        clientRef: str(r.client_ref),
        clientName: str(r.client_name),
        featureKeys: json<unknown[]>(r.feature_keys, []).filter((k): k is string => typeof k === "string"),
      }));
    },
    async upsertFeatures(companyId, programId, postId, values, model) {
      if (values.length === 0) return;
      await ctx.db.execute(
        `INSERT INTO ${T("post_features")} (post_id, feature_key, company_id, program_id, value, confidence, source, decision_id, model)
         SELECT $1, x.key, $2, $3, x.value, x.confidence, x.source, x.decision_id, $5
           FROM jsonb_to_recordset($4::jsonb) AS x(key text, value text, confidence numeric, source text, decision_id text)
         ON CONFLICT (post_id, feature_key) DO UPDATE
           SET value = EXCLUDED.value, confidence = EXCLUDED.confidence, source = EXCLUDED.source, decision_id = EXCLUDED.decision_id,
               model = EXCLUDED.model, program_id = EXCLUDED.program_id, updated_at = now()`,
        [
          postId, companyId, programId,
          JSON.stringify(values.map((v) => ({ key: v.key, value: v.value, confidence: v.confidence, source: v.source, decision_id: v.decisionId ?? null }))),
          model,
        ],
      );
    },
    async postFeatures(companyId, postIds) {
      if (postIds.length === 0) return [];
      const rows = await ctx.db.query<Row>(
        `SELECT post_id, feature_key, value, confidence, source FROM ${T("post_features")}
          WHERE company_id = $1 AND post_id = ANY(${textArrayParam(2)})`,
        [companyId, JSON.stringify(postIds)],
      );
      return rows.map((r) => ({ postId: String(r.post_id), key: String(r.feature_key), value: str(r.value), confidence: num(r.confidence) ?? 0, source: String(r.source) }));
    },
    async scoredPosts(companyId, scope, window, sinceDays) {
      const params: unknown[] = [companyId, window, sinceDays];
      const where = scopeFilter(scope, params, "s");
      const rows = await ctx.db.query<Row>(
        `SELECT s.post_id, p.body, s.platform, s.account_id, s.published_at, s.engagement_rate, s.lift, p.experiment_id, p.experiment_arm
           FROM ${T("post_scores")} s
           JOIN ${T("posts")} p ON p.id = s.post_id
          WHERE s.company_id = $1 AND s.metric_window = $2 AND s.published_at >= now() - make_interval(days => $3) AND ${where}
          ORDER BY s.published_at DESC
          LIMIT 3000`,
        params,
      );
      return rows.map((r): ScoredPostRow => ({
        subjectId: String(r.post_id),
        body: String(r.body ?? ""),
        platform: str(r.platform),
        accountId: str(r.account_id),
        publishedAt: iso(r.published_at),
        engagementRate: num(r.engagement_rate) ?? 0,
        lift: num(r.lift),
        experimentId: str(r.experiment_id),
        experimentArm: str(r.experiment_arm),
      }));
    },
    async countArmPosts(companyId, experimentId, arm) {
      const rows = await ctx.db.query<{ count: string }>(
        `SELECT COUNT(DISTINCT p.id)::text AS count
           FROM ${T("posts")} p
          WHERE p.company_id = $1 AND p.experiment_id = $2 AND p.experiment_arm = $3`,
        [companyId, experimentId, arm],
      );
      return Number(rows[0]?.count ?? 0);
    },
  };
}
