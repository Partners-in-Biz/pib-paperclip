/**
 * Company memory tables (migration 002). One statement per call and only
 * primitive parameters (lists travel as JSON strings), like the host requires.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isMemoryArea, isMemoryKind, textArrayParam } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "../namespace.js";
import type { FactOrigin, FactStatus, MemoryFact } from "./engine.js";

const T = {
  facts: `${NAMESPACE}.memory_facts`,
  briefs: `${NAMESPACE}.memory_briefs`,
  feedback: `${NAMESPACE}.memory_feedback`,
};

const FACT_COLUMNS =
  "id, company_id, client_ref, client_name, area, kind, text, pinned, status, supersedes, superseded_by, source_issue_id, source_identifier, source_comment_id, origin, created_by_agent_id, created_by_user_id, expires_at, use_count, last_used_at, helpful_count, noise_count, created_at, updated_at";

type Raw = Record<string, unknown>;

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const t = Date.parse(text);
  return Number.isFinite(t) ? new Date(t).toISOString() : text;
}

function str(value: unknown): string | null {
  return value == null || value === "" ? null : String(value);
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function factFrom(row: Raw): MemoryFact {
  const area = String(row.area ?? "general");
  const kind = String(row.kind ?? "fact");
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    clientRef: str(row.client_ref),
    clientName: str(row.client_name),
    area: isMemoryArea(area) ? area : "general",
    kind: isMemoryKind(kind) ? kind : "fact",
    text: String(row.text ?? ""),
    pinned: row.pinned === true || row.pinned === "true" || row.pinned === "t",
    status: (["active", "superseded", "archived"].includes(String(row.status)) ? String(row.status) : "active") as FactStatus,
    supersedes: str(row.supersedes),
    supersededBy: str(row.superseded_by),
    sourceIssueId: str(row.source_issue_id),
    sourceIdentifier: str(row.source_identifier),
    origin: (["tool", "harvest", "person"].includes(String(row.origin)) ? String(row.origin) : "tool") as FactOrigin,
    sourceCommentId: str(row.source_comment_id),
    createdByAgentId: str(row.created_by_agent_id),
    createdByUserId: str(row.created_by_user_id),
    expiresAt: iso(row.expires_at),
    useCount: num(row.use_count),
    lastUsedAt: iso(row.last_used_at),
    helpfulCount: num(row.helpful_count),
    noiseCount: num(row.noise_count),
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? iso(row.created_at) ?? "",
  };
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface NewFact {
  id: string;
  companyId: string;
  clientRef: string | null;
  clientName: string | null;
  area: string;
  kind: string;
  text: string;
  textHash: string;
  pinned: boolean;
  supersedes: string | null;
  sourceIssueId: string | null;
  sourceIdentifier: string | null;
  sourceRunId: string | null;
  sourceCommentId: string | null;
  origin: FactOrigin;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  expiresAt: string | null;
}

/** Inserts the fact; false when an active fact with the same text already exists in the company. */
export async function insertFact(ctx: PluginContext, fact: NewFact): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${T.facts} (id, company_id, client_ref, client_name, area, kind, text, text_hash, pinned, supersedes, source_issue_id, source_identifier, source_run_id, created_by_agent_id, created_by_user_id, expires_at, source_comment_id, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz, $17, $18)
     ON CONFLICT (company_id, text_hash) WHERE status = 'active' DO NOTHING`,
    [
      fact.id,
      fact.companyId,
      fact.clientRef,
      fact.clientName,
      fact.area,
      fact.kind,
      fact.text,
      fact.textHash,
      fact.pinned,
      fact.supersedes,
      fact.sourceIssueId,
      fact.sourceIdentifier,
      fact.sourceRunId,
      fact.createdByAgentId,
      fact.createdByUserId,
      fact.expiresAt,
      fact.sourceCommentId,
      fact.origin,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getFact(ctx: PluginContext, companyId: string, id: string): Promise<MemoryFact | null> {
  const rows = await ctx.db.query<Raw>(`SELECT ${FACT_COLUMNS} FROM ${T.facts} WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? factFrom(rows[0]) : null;
}

export async function getFacts(ctx: PluginContext, companyId: string, ids: string[]): Promise<MemoryFact[]> {
  if (ids.length === 0) return [];
  const rows = await ctx.db.query<Raw>(
    `SELECT ${FACT_COLUMNS} FROM ${T.facts} WHERE company_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [companyId, JSON.stringify(ids)],
  );
  return rows.map(factFrom);
}

/** Any fact with this text in the company, whatever its status (imports never resurrect retired facts). */
export async function findAnyByHash(ctx: PluginContext, companyId: string, textHash: string): Promise<MemoryFact | null> {
  const rows = await ctx.db.query<Raw>(`SELECT ${FACT_COLUMNS} FROM ${T.facts} WHERE company_id = $1 AND text_hash = $2 ORDER BY updated_at DESC LIMIT 1`, [companyId, textHash]);
  return rows[0] ? factFrom(rows[0]) : null;
}

export async function findActiveByHash(ctx: PluginContext, companyId: string, textHash: string): Promise<MemoryFact | null> {
  const rows = await ctx.db.query<Raw>(`SELECT ${FACT_COLUMNS} FROM ${T.facts} WHERE company_id = $1 AND text_hash = $2 AND status = 'active' LIMIT 1`, [companyId, textHash]);
  return rows[0] ? factFrom(rows[0]) : null;
}

/**
 * Live facts a brief may use: this company's active, unexpired facts for the
 * given clients plus company-wide ones (or every client's, for an explicit
 * search with no client). Pinned and newest first; `limit` caps the scan.
 */
export async function scanCandidates(
  ctx: PluginContext,
  companyId: string,
  clientRefs: string[] | "all",
  limit: number,
  options: { includeArchived?: boolean } = {},
): Promise<MemoryFact[]> {
  // Briefs use live facts only; an explicit search may also look at archived ones (kept, never deleted).
  const statusSql = options.includeArchived
    ? "(status = 'active' AND (expires_at IS NULL OR expires_at > now()) OR status = 'archived')"
    : "status = 'active' AND (expires_at IS NULL OR expires_at > now())";
  if (clientRefs === "all") {
    const all = await ctx.db.query<Raw>(
      `SELECT ${FACT_COLUMNS} FROM ${T.facts}
        WHERE company_id = $1 AND ${statusSql}
        ORDER BY pinned DESC, updated_at DESC
        LIMIT $2`,
      [companyId, limit],
    );
    return all.map(factFrom);
  }
  const rows = await ctx.db.query<Raw>(
    `SELECT ${FACT_COLUMNS} FROM ${T.facts}
      WHERE company_id = $1 AND ${statusSql}
        AND (client_ref IS NULL OR client_ref IN (SELECT jsonb_array_elements_text($2::jsonb)))
      ORDER BY pinned DESC, updated_at DESC
      LIMIT $3`,
    [companyId, JSON.stringify(clientRefs), limit],
  );
  return rows.map(factFrom);
}

/** Every fact of a company, any status (export / backup). */
export async function exportFacts(ctx: PluginContext, companyId: string): Promise<MemoryFact[]> {
  const rows = await ctx.db.query<Raw>(`SELECT ${FACT_COLUMNS} FROM ${T.facts} WHERE company_id = $1 ORDER BY created_at LIMIT 50000`, [companyId]);
  return rows.map(factFrom);
}

/** Active facts in one client scope (null = company-wide), for duplicate checks. */
export async function scopeFacts(ctx: PluginContext, companyId: string, clientRef: string | null, limit: number): Promise<MemoryFact[]> {
  const rows = await ctx.db.query<Raw>(
    `SELECT ${FACT_COLUMNS} FROM ${T.facts}
      WHERE company_id = $1 AND status = 'active' AND coalesce(client_ref, '') = $2
      ORDER BY updated_at DESC LIMIT $3`,
    [companyId, clientRef ?? "", limit],
  );
  return rows.map(factFrom);
}

export async function countPinned(ctx: PluginContext, companyId: string, clientRef: string | null, area: string): Promise<number> {
  const rows = await ctx.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${T.facts} WHERE company_id = $1 AND status = 'active' AND pinned = true AND coalesce(client_ref, '') = $2 AND area = $3`,
    [companyId, clientRef ?? "", area],
  );
  return num(rows[0]?.n);
}

/** Total live facts, and a version string that changes whenever any fact changes. */
export async function factsVersion(ctx: PluginContext, companyId: string): Promise<{ active: number; version: string }> {
  const rows = await ctx.db.query<{ active: string; total: string; latest: string | null }>(
    `SELECT count(*) FILTER (WHERE status = 'active')::text AS active, count(*)::text AS total, max(updated_at)::text AS latest FROM ${T.facts} WHERE company_id = $1`,
    [companyId],
  );
  const r = rows[0];
  return { active: num(r?.active), version: `${num(r?.total)}:${num(r?.active)}:${r?.latest ?? "-"}` };
}

/** Client refs and names the company's memory knows (newest name wins). */
export async function knownClients(ctx: PluginContext, companyId: string): Promise<Array<{ clientRef: string; clientName: string }>> {
  const rows = await ctx.db.query<{ client_ref: string; client_name: string }>(
    `SELECT DISTINCT ON (client_ref) client_ref, client_name FROM ${T.facts}
      WHERE company_id = $1 AND client_ref IS NOT NULL AND client_name IS NOT NULL
      ORDER BY client_ref, updated_at DESC LIMIT 500`,
    [companyId],
  );
  return rows.map((r) => ({ clientRef: String(r.client_ref), clientName: String(r.client_name) }));
}

export interface FactPatch {
  text?: string;
  textHash?: string;
  pinned?: boolean;
  status?: FactStatus;
  supersededBy?: string | null;
  expiresAt?: string | null;
  area?: string;
  kind?: string;
  clientRef?: string | null;
  clientName?: string | null;
}

const PATCH_COLUMNS: Record<keyof FactPatch, string> = {
  text: "text",
  textHash: "text_hash",
  pinned: "pinned",
  status: "status",
  supersededBy: "superseded_by",
  expiresAt: "expires_at",
  area: "area",
  kind: "kind",
  clientRef: "client_ref",
  clientName: "client_name",
};

export async function updateFact(ctx: PluginContext, companyId: string, id: string, patch: FactPatch): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [companyId, id];
  for (const [key, column] of Object.entries(PATCH_COLUMNS) as Array<[keyof FactPatch, string]>) {
    if (!(key in patch)) continue;
    params.push(patch[key] ?? null);
    sets.push(`${column} = $${params.length}${key === "expiresAt" ? "::timestamptz" : ""}`);
  }
  if (sets.length === 0) return false;
  const res = await ctx.db.execute(`UPDATE ${T.facts} SET ${sets.join(", ")}, updated_at = now() WHERE company_id = $1 AND id = $2`, params);
  return (res.rowCount ?? 0) > 0;
}

/** Marks an active fact as replaced by `newId`. */
export async function supersedeFact(ctx: PluginContext, companyId: string, oldId: string, newId: string): Promise<boolean> {
  const res = await ctx.db.execute(
    `UPDATE ${T.facts} SET status = 'superseded', superseded_by = $3, updated_at = now() WHERE company_id = $1 AND id = $2 AND status = 'active'`,
    [companyId, oldId, newId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Counts a brief's facts as used (does not touch `updated_at`, which is for content changes). */
export async function markUsed(ctx: PluginContext, companyId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await ctx.db.execute(
    `UPDATE ${T.facts} SET use_count = use_count + 1, last_used_at = now() WHERE company_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [companyId, JSON.stringify(ids)],
  );
}

export async function bumpFeedback(ctx: PluginContext, companyId: string, ids: string[], kind: "helpful" | "noise"): Promise<void> {
  if (ids.length === 0) return;
  const column = kind === "helpful" ? "helpful_count" : "noise_count";
  await ctx.db.execute(
    `UPDATE ${T.facts} SET ${column} = ${column} + 1 WHERE company_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [companyId, JSON.stringify(ids)],
  );
}

export async function archiveFacts(ctx: PluginContext, companyId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const res = await ctx.db.execute(
    `UPDATE ${T.facts} SET status = 'archived', updated_at = now() WHERE company_id = $1 AND status = 'active' AND pinned = false AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [companyId, JSON.stringify(ids)],
  );
  return res.rowCount ?? 0;
}

/** Active facts whose `expires_at` has passed become archived. */
export async function expireFacts(ctx: PluginContext, companyId: string): Promise<number> {
  const res = await ctx.db.execute(
    `UPDATE ${T.facts} SET status = 'archived', updated_at = now() WHERE company_id = $1 AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= now()`,
    [companyId],
  );
  return res.rowCount ?? 0;
}

export async function companiesWithFacts(ctx: PluginContext): Promise<string[]> {
  const rows = await ctx.db.query<{ company_id: string }>(`SELECT DISTINCT company_id FROM ${T.facts} LIMIT 1000`, []);
  return rows.map((r) => String(r.company_id));
}

/** All active facts of a company (maintenance and review; capped). */
export async function activeFacts(ctx: PluginContext, companyId: string, limit = 20_000): Promise<MemoryFact[]> {
  const rows = await ctx.db.query<Raw>(`SELECT ${FACT_COLUMNS} FROM ${T.facts} WHERE company_id = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT $2`, [companyId, limit]);
  return rows.map(factFrom);
}

export interface FactFilter {
  status?: FactStatus | "all";
  clientRef?: string | null;
  /** Several refs for one client (the same name known under two refs); wins over `clientRef`. */
  clientRefs?: string[] | null;
  own?: boolean;
  area?: string | null;
  q?: string | null;
  pinned?: boolean;
  limit: number;
  offset: number;
}

/** Facts for the Cockpit page (newest first) and the total that matches. */
export async function listFacts(ctx: PluginContext, companyId: string, filter: FactFilter): Promise<{ facts: MemoryFact[]; total: number }> {
  const where = ["company_id = $1"];
  const params: unknown[] = [companyId];
  if (filter.status && filter.status !== "all") {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  if (filter.own) where.push("client_ref IS NULL");
  else if (filter.clientRefs?.length) {
    params.push(JSON.stringify(filter.clientRefs));
    where.push(`client_ref = ANY(${textArrayParam(params.length)})`);
  } else if (filter.clientRef) {
    params.push(filter.clientRef);
    where.push(`client_ref = $${params.length}`);
  }
  if (filter.area) {
    params.push(filter.area);
    where.push(`area = $${params.length}`);
  }
  if (filter.pinned) where.push("pinned = true");
  if (filter.q) {
    params.push(`%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(text ILIKE $${params.length} OR coalesce(client_name, '') ILIKE $${params.length + 1})`);
    params.push(params[params.length - 1]);
  }
  const whereSql = where.join(" AND ");
  const [rows, count] = await Promise.all([
    ctx.db.query<Raw>(`SELECT ${FACT_COLUMNS} FROM ${T.facts} WHERE ${whereSql} ORDER BY pinned DESC, updated_at DESC LIMIT ${Math.max(1, Math.min(200, filter.limit))} OFFSET ${Math.max(0, filter.offset)}`, params),
    ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${T.facts} WHERE ${whereSql}`, params),
  ]);
  return { facts: rows.map(factFrom), total: num(count[0]?.n) };
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

export interface BriefRow {
  id: string;
  companyId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  agentId: string | null;
  runId: string | null;
  query: string | null;
  clientRefs: string[];
  area: string | null;
  method: "jev" | "baseline" | "empty" | "search";
  model: string | null;
  version: string;
  totalFacts: number;
  candidateCount: number;
  factIds: string[];
  baselineIds: string[];
  scores: Record<string, number>;
  tokens: number;
  jevInputTokens: number;
  latencyMs: number;
  factsVersion: string | null;
  body: string;
  createdAt: string;
}

const BRIEF_COLUMNS =
  "id, company_id, issue_id, issue_identifier, agent_id, run_id, query, client_refs, area, method, model, version, total_facts, candidate_count, fact_ids, baseline_ids, scores, tokens, jev_input_tokens, latency_ms, facts_version, body, created_at";

function briefFrom(row: Raw): BriefRow {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    issueId: str(row.issue_id),
    issueIdentifier: str(row.issue_identifier),
    agentId: str(row.agent_id),
    runId: str(row.run_id),
    query: str(row.query),
    clientRefs: json<string[]>(row.client_refs, []),
    area: str(row.area),
    method: String(row.method) as BriefRow["method"],
    model: str(row.model),
    version: String(row.version ?? ""),
    totalFacts: num(row.total_facts),
    candidateCount: num(row.candidate_count),
    factIds: json<string[]>(row.fact_ids, []),
    baselineIds: json<string[]>(row.baseline_ids, []),
    scores: json<Record<string, number>>(row.scores, {}),
    tokens: num(row.tokens),
    jevInputTokens: num(row.jev_input_tokens),
    latencyMs: num(row.latency_ms),
    factsVersion: str(row.facts_version),
    body: String(row.body ?? ""),
    createdAt: iso(row.created_at) ?? "",
  };
}

export async function insertBrief(ctx: PluginContext, row: Omit<BriefRow, "createdAt">): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.briefs} (id, company_id, issue_id, issue_identifier, agent_id, run_id, query, client_refs, area, method, model, version, total_facts, candidate_count, fact_ids, baseline_ids, scores, tokens, jev_input_tokens, latency_ms, facts_version, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17::jsonb, $18, $19, $20, $21, $22)`,
    [
      row.id,
      row.companyId,
      row.issueId,
      row.issueIdentifier,
      row.agentId,
      row.runId,
      row.query,
      JSON.stringify(row.clientRefs),
      row.area,
      row.method,
      row.model,
      row.version,
      row.totalFacts,
      row.candidateCount,
      JSON.stringify(row.factIds),
      JSON.stringify(row.baselineIds),
      JSON.stringify(row.scores),
      row.tokens,
      row.jevInputTokens,
      row.latencyMs,
      row.factsVersion,
      row.body,
    ],
  );
}

/** The newest brief for this issue and agent made in the last `minutes` minutes. */
export async function recentBriefFor(ctx: PluginContext, companyId: string, issueId: string, agentId: string, minutes: number): Promise<BriefRow | null> {
  const rows = await ctx.db.query<Raw>(
    `SELECT ${BRIEF_COLUMNS} FROM ${T.briefs}
      WHERE company_id = $1 AND issue_id = $2 AND agent_id = $3 AND method <> 'search' AND created_at > now() - ($4 || ' minutes')::interval
      ORDER BY created_at DESC LIMIT 1`,
    [companyId, issueId, agentId, String(minutes)],
  );
  return rows[0] ? briefFrom(rows[0]) : null;
}

export async function getBrief(ctx: PluginContext, companyId: string, id: string): Promise<BriefRow | null> {
  const rows = await ctx.db.query<Raw>(`SELECT ${BRIEF_COLUMNS} FROM ${T.briefs} WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? briefFrom(rows[0]) : null;
}

/** The newest brief for an issue (optionally for one agent). */
export async function latestBriefForIssue(ctx: PluginContext, companyId: string, issueId: string, agentId: string | null): Promise<BriefRow | null> {
  const rows = agentId
    ? await ctx.db.query<Raw>(
      `SELECT ${BRIEF_COLUMNS} FROM ${T.briefs} WHERE company_id = $1 AND issue_id = $2 AND agent_id = $3 AND method <> 'search' ORDER BY created_at DESC LIMIT 1`,
      [companyId, issueId, agentId],
    )
    : await ctx.db.query<Raw>(`SELECT ${BRIEF_COLUMNS} FROM ${T.briefs} WHERE company_id = $1 AND issue_id = $2 AND method <> 'search' ORDER BY created_at DESC LIMIT 1`, [companyId, issueId]);
  return rows[0] ? briefFrom(rows[0]) : null;
}

export async function recentBriefs(ctx: PluginContext, companyId: string, limit: number): Promise<BriefRow[]> {
  const rows = await ctx.db.query<Raw>(`SELECT ${BRIEF_COLUMNS} FROM ${T.briefs} WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`, [companyId, Math.max(1, Math.min(100, limit))]);
  return rows.map(briefFrom);
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export interface FeedbackRow {
  id: string;
  companyId: string;
  briefId: string | null;
  issueId: string | null;
  agentId: string | null;
  userId: string | null;
  kind: "missing" | "noise" | "wrong";
  factId: string | null;
  text: string | null;
  inBaseline: boolean | null;
}

export async function insertFeedback(ctx: PluginContext, row: FeedbackRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.feedback} (id, company_id, brief_id, issue_id, agent_id, user_id, kind, fact_id, text, in_baseline) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [row.id, row.companyId, row.briefId, row.issueId, row.agentId, row.userId, row.kind, row.factId, row.text, row.inBaseline],
  );
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface MemoryStats {
  facts: { active: number; pinned: number; superseded: number; archived: number; clients: number };
  byArea: Record<string, number>;
  briefs7d: { total: number; jev: number; baseline: number; empty: number; avgFacts: number; avgTokens: number; avgLatencyMs: number; issues: number };
  feedback30d: { missing: number; noise: number; wrong: number; missingInBaseline: number; missingNotInBaseline: number; briefsWithFeedback: number };
  added7d: number;
  /** Of those, saved from **Learned:** lines in comments. */
  harvested7d: number;
}

export async function memoryStats(ctx: PluginContext, companyId: string): Promise<MemoryStats> {
  const [facts, areas, briefs, feedback, added] = await Promise.all([
    ctx.db.query<Raw>(
      `SELECT count(*) FILTER (WHERE status = 'active')::text AS active,
              count(*) FILTER (WHERE status = 'active' AND pinned = true)::text AS pinned,
              count(*) FILTER (WHERE status = 'superseded')::text AS superseded,
              count(*) FILTER (WHERE status = 'archived')::text AS archived,
              count(DISTINCT client_ref) FILTER (WHERE status = 'active')::text AS clients
         FROM ${T.facts} WHERE company_id = $1`,
      [companyId],
    ),
    ctx.db.query<{ area: string; n: string }>(`SELECT area, count(*)::text AS n FROM ${T.facts} WHERE company_id = $1 AND status = 'active' GROUP BY area`, [companyId]),
    ctx.db.query<Raw>(
      `SELECT count(*) FILTER (WHERE method <> 'search')::text AS total,
              count(*) FILTER (WHERE method = 'jev')::text AS jev,
              count(*) FILTER (WHERE method = 'baseline')::text AS baseline,
              count(*) FILTER (WHERE method = 'empty')::text AS empty,
              coalesce(round(avg(jsonb_array_length(fact_ids)) FILTER (WHERE method <> 'search'), 1), 0)::text AS avg_facts,
              coalesce(round(avg(tokens) FILTER (WHERE method <> 'search')), 0)::text AS avg_tokens,
              coalesce(round(avg(latency_ms) FILTER (WHERE method <> 'search')), 0)::text AS avg_latency,
              count(DISTINCT issue_id) FILTER (WHERE method <> 'search')::text AS issues
         FROM ${T.briefs} WHERE company_id = $1 AND created_at > now() - interval '7 days'`,
      [companyId],
    ),
    ctx.db.query<Raw>(
      `SELECT count(*) FILTER (WHERE kind = 'missing')::text AS missing,
              count(*) FILTER (WHERE kind = 'noise')::text AS noise,
              count(*) FILTER (WHERE kind = 'wrong')::text AS wrong,
              count(*) FILTER (WHERE kind = 'missing' AND in_baseline = true)::text AS missing_in_baseline,
              count(*) FILTER (WHERE kind = 'missing' AND in_baseline = false)::text AS missing_not_in_baseline,
              count(DISTINCT brief_id)::text AS briefs
         FROM ${T.feedback} WHERE company_id = $1 AND created_at > now() - interval '30 days'`,
      [companyId],
    ),
    ctx.db.query<{ n: string; harvested: string }>(
      `SELECT count(*)::text AS n, count(*) FILTER (WHERE origin = 'harvest')::text AS harvested FROM ${T.facts} WHERE company_id = $1 AND created_at > now() - interval '7 days'`,
      [companyId],
    ),
  ]);
  const f = facts[0] ?? {};
  const b = briefs[0] ?? {};
  const fb = feedback[0] ?? {};
  return {
    facts: { active: num(f.active), pinned: num(f.pinned), superseded: num(f.superseded), archived: num(f.archived), clients: num(f.clients) },
    byArea: Object.fromEntries(areas.map((r) => [String(r.area), num(r.n)])),
    briefs7d: {
      total: num(b.total),
      jev: num(b.jev),
      baseline: num(b.baseline),
      empty: num(b.empty),
      avgFacts: num(b.avg_facts),
      avgTokens: num(b.avg_tokens),
      avgLatencyMs: num(b.avg_latency),
      issues: num(b.issues),
    },
    feedback30d: {
      missing: num(fb.missing),
      noise: num(fb.noise),
      wrong: num(fb.wrong),
      missingInBaseline: num(fb.missing_in_baseline),
      missingNotInBaseline: num(fb.missing_not_in_baseline),
      briefsWithFeedback: num(fb.briefs),
    },
    added7d: num(added[0]?.n),
    harvested7d: num(added[0]?.harvested),
  };
}

/**
 * How often agents asked memory: per agent, finished runs in the last `days`
 * days and how many of them made at least one brief. Low coverage means an
 * agent works without the company's memory.
 */
export async function recallCoverage(ctx: PluginContext, companyId: string, days = 7): Promise<Array<{ agentId: string; runs: number; withBrief: number }>> {
  const rows = await ctx.db.query<{ agent_id: string; runs: string; with_brief: string }>(
    `SELECT r.agent_id::text AS agent_id, count(*)::text AS runs,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ${T.briefs} b WHERE b.company_id = $1 AND b.run_id = r.id::text))::text AS with_brief
       FROM public.heartbeat_runs r
      WHERE r.company_id::text = $2 AND r.status = 'succeeded' AND r.started_at > now() - ($3 || ' days')::interval
      GROUP BY r.agent_id ORDER BY count(*) DESC LIMIT 50`,
    [companyId, companyId, String(days)],
  );
  return rows.map((r) => ({ agentId: String(r.agent_id), runs: num(r.runs), withBrief: num(r.with_brief) }));
}

