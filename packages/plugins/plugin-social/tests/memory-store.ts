/**
 * In-memory GrowthStore with the same semantics as sql.ts (scope filters,
 * guarded updates, upserts), for service-level tests.
 */
import { sameClient, scopeOfRow, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import type { FeatureValue, ScoredPostRow } from "../src/growth/engine.js";
import type {
  Experiment,
  ExperimentItem,
  GrowthStore,
  MetricRow,
  PlaybookChange,
  PlaybookVersion,
  Program,
  ScoreWrite,
  StoredFeature,
} from "../src/growth/store.js";

export interface MemPost {
  id: string;
  companyId: string;
  body: string;
  media: Array<{ kind: string }>;
  status: string;
  clientKind: string | null;
  clientRef: string | null;
  clientName: string | null;
  publishedAt: string | null;
  experimentId: string | null;
  experimentArm: string | null;
  createdAt: string;
}

export interface MemMetric extends MetricRow {
  companyId: string;
  window: string;
}

const DAY = 24 * 3600_000;
let clock = 0;
const stamp = () => new Date(Date.now() + clock++).toISOString();

function scopeMatch(row: { clientKind?: string | null; clientRef?: string | null }, scope: ClientScope): boolean {
  return sameClient(scopeOfRow({ client_kind: row.clientKind ?? null, client_ref: row.clientRef ?? null }), scope);
}

/** Reads return copies, like rows from the database. */
const copy = <T>(value: T): T => structuredClone(value);

function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function memoryStore() {
  const db = {
    programs: [] as Program[],
    versions: [] as Array<PlaybookVersion & { programId: string }>,
    experiments: [] as Experiment[],
    items: [] as ExperimentItem[],
    changes: [] as PlaybookChange[],
    posts: [] as MemPost[],
    metrics: [] as MemMetric[],
    scores: [] as ScoreWrite[],
    features: [] as Array<StoredFeature & { companyId: string; programId: string | null; model: string | null }>,
  };
  const within = (iso: string | null, days: number) => Boolean(iso && Date.parse(iso) >= Date.now() - days * DAY);
  const store: GrowthStore = {
    async findProgram(companyId, channel, scope) {
      return copy(db.programs.find((p) => p.companyId === companyId && p.channel === channel && scopeMatch(p, scope)) ?? null);
    },
    async getProgram(companyId, id) {
      return copy(db.programs.find((p) => p.id === id && p.companyId === companyId) ?? null);
    },
    async insertProgram(p) {
      if (db.programs.some((x) => x.companyId === p.companyId && x.channel === p.channel && scopeMatch(x, scopeOfRow({ client_kind: p.clientKind, client_ref: p.clientRef })))) return;
      db.programs.push({ ...p, status: "active", approvalIssueId: null, approvalWeek: null, createdAt: stamp(), updatedAt: stamp() });
    },
    async updateProgram(companyId, id, patch) {
      const p = db.programs.find((x) => x.id === id && x.companyId === companyId);
      if (p) Object.assign(p, defined(patch), { updatedAt: stamp() });
    },
    async savePlaybook(companyId, id, expectedVersion, playbook) {
      const p = db.programs.find((x) => x.id === id && x.companyId === companyId && x.playbookVersion === expectedVersion);
      if (!p) return false;
      p.playbook = playbook;
      p.playbookVersion += 1;
      return true;
    },
    async insertPlaybookVersion(v) {
      if (db.versions.some((x) => x.programId === v.programId && x.version === v.version)) return;
      db.versions.push({ ...v, createdAt: stamp() });
    },
    async listPlaybookVersions(programId, limit) {
      return copy(db.versions.filter((v) => v.programId === programId).sort((a, b) => b.version - a.version).slice(0, limit));
    },

    async insertExperiment(e) {
      db.experiments.push({
        ...e,
        approvalIssueId: null, approvedAt: null, approvedBy: null, startedAt: null, measureAfter: null, measuredAt: null, verdict: null, outcome: null,
        playbookDiff: null, playbookDecision: null, decisionNote: null, createdAt: stamp(), updatedAt: stamp(),
      });
    },
    async getExperiment(companyId, id) {
      return copy(db.experiments.find((e) => e.id === id && e.companyId === companyId) ?? null);
    },
    async listExperiments(companyId, programId, statuses) {
      return copy(db.experiments.filter((e) => e.companyId === companyId && e.programId === programId && (!statuses?.length || statuses.includes(e.status))).reverse());
    },
    async updateExperiment(companyId, id, from, patch) {
      const e = db.experiments.find((x) => x.id === id && x.companyId === companyId && (!from || from.includes(x.status)));
      if (!e) return false;
      Object.assign(e, defined(patch), { updatedAt: stamp() });
      return true;
    },
    async companiesWithRunningExperiments() {
      return Array.from(new Set(db.experiments.filter((e) => e.status === "running").map((e) => e.companyId)));
    },
    async runningExperiments(companyId) {
      return copy(db.experiments.filter((e) => e.companyId === companyId && e.status === "running"));
    },

    async upsertItem(experimentId, arm, postId, value) {
      const existing = db.items.find((i) => i.experimentId === experimentId && i.postId === postId);
      if (existing) Object.assign(existing, { arm, value, measuredAt: value === null ? null : stamp() });
      else db.items.push({ experimentId, arm, postId, value, measuredAt: value === null ? null : stamp() });
    },
    async deleteItem(experimentId, postId) {
      db.items = db.items.filter((i) => !(i.experimentId === experimentId && i.postId === postId));
    },
    async listItems(experimentId) {
      return copy(db.items.filter((i) => i.experimentId === experimentId));
    },
    async experimentPosts(companyId, experimentId, window) {
      return db.posts
        .filter((p) => p.companyId === companyId && p.experimentId === experimentId)
        .map((p) => ({
          postId: p.id,
          arm: p.experimentArm,
          status: p.status,
          publishedAt: p.publishedAt,
          lifts: db.scores.filter((s) => s.postId === p.id && s.window === window && s.lift !== null).map((s) => s.lift!),
        }));
    },
    async setPostExperiment(companyId, postId, experimentId, arm) {
      const p = db.posts.find((x) => x.id === postId && x.companyId === companyId);
      if (!p) return false;
      p.experimentId = experimentId;
      p.experimentArm = arm;
      return true;
    },

    async insertChange(c) {
      db.changes.push({ ...c, status: "pending", resultVersion: null, decidedBy: null, decidedAt: null, decisionNote: null, approvalIssueId: null, createdAt: stamp() });
    },
    async getChange(companyId, id) {
      return copy(db.changes.find((c) => c.id === id && c.companyId === companyId) ?? null);
    },
    async listChanges(companyId, programId, status) {
      return copy(db.changes.filter((c) => c.companyId === companyId && c.programId === programId && (!status || c.status === status)).reverse());
    },
    async updateChange(companyId, id, patch, onlyPending) {
      const c = db.changes.find((x) => x.id === id && x.companyId === companyId && (!onlyPending || x.status === "pending"));
      if (!c) return false;
      Object.assign(c, defined(patch));
      if (patch.status) c.decidedAt = stamp();
      return true;
    },

    async companiesWithMetrics(window) {
      return Array.from(new Set(db.metrics.filter((m) => m.window === window).map((m) => m.companyId)));
    },
    async metricRows(companyId, window, sinceDays) {
      return copy(db.metrics.filter((m) => m.companyId === companyId && m.window === window && within(m.publishedAt, sinceDays)));
    },
    async existingScores(companyId, window, sinceDays) {
      const out = new Map();
      for (const s of db.scores.filter((x) => x.companyId === companyId && x.window === window && within(x.publishedAt, sinceDays))) {
        out.set(s.destinationId, { engagementRate: s.engagementRate, baselineMedian: s.baselineMedian, baselineN: s.baselineN, lift: s.lift, programId: s.programId });
      }
      return out;
    },
    async upsertScore(s) {
      const i = db.scores.findIndex((x) => x.destinationId === s.destinationId && x.window === s.window);
      if (i >= 0) db.scores[i] = { ...s };
      else db.scores.push({ ...s });
    },

    async postsToTag(companyId, sinceDays, limit) {
      return db.posts
        .filter((p) => p.companyId === companyId && (p.status === "published" || p.status === "partially_published") && within(p.publishedAt, sinceDays))
        .slice(0, limit)
        .map((p) => ({
          id: p.id,
          body: p.body,
          media: p.media,
          publishedAt: p.publishedAt,
          clientKind: p.clientKind,
          clientRef: p.clientRef,
          clientName: p.clientName,
          featureKeys: db.features.filter((f) => f.postId === p.id).map((f) => f.key),
        }));
    },
    async upsertFeatures(companyId, programId, postId, values: FeatureValue[], model) {
      for (const v of values) {
        db.features = db.features.filter((f) => !(f.postId === postId && f.key === v.key));
        db.features.push({ postId, key: v.key, value: v.value, confidence: v.confidence, source: v.source, companyId, programId, model });
      }
    },
    async postFeatures(companyId, postIds) {
      return copy(db.features.filter((f) => f.companyId === companyId && postIds.includes(f.postId)));
    },
    async scoredPosts(companyId, scope, window, sinceDays): Promise<ScoredPostRow[]> {
      return db.scores
        .filter((s) => s.companyId === companyId && s.window === window && within(s.publishedAt, sinceDays) && scopeMatch(s, scope))
        .map((s) => {
          const post = db.posts.find((p) => p.id === s.postId)!;
          return {
            postId: s.postId,
            body: post.body,
            platform: s.platform,
            accountId: s.accountId,
            publishedAt: s.publishedAt,
            engagementRate: s.engagementRate,
            lift: s.lift,
            experimentId: post.experimentId,
            experimentArm: post.experimentArm,
          };
        });
    },
  };
  return { store, db };
}

export function daysAgo(days: number, hourUtc = 6): string {
  const d = new Date(Date.now() - days * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}
