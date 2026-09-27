/**
 * Company memory on the Cockpit page: data shapes and view helpers (pure, no
 * React, no node imports). The worker's memory modules are imported as types
 * only, so the page bundle never pulls in worker code.
 */
import { parseClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";
import type { ToneInput } from "@partnersinbiz/pib-plugin-ui";
import type { AgentLite } from "../merge.js";
import type { FactOrigin, FactStatus, MemoryFact } from "../memory/engine.js";
import type { AddResult, BriefFact, BriefResult, review } from "../memory/service.js";
import type { BriefRow, MemoryStats, recallCoverage } from "../memory/store.js";

export type { AddResult, BriefFact, BriefResult, BriefRow, FactOrigin, FactStatus, MemoryFact, MemoryStats };

/** `memory.review`. */
export type MemoryReview = Awaited<ReturnType<typeof review>>;

/** Finished agent runs in the last 7 days and how many started with a memory brief. */
export type CoverageRow = Awaited<ReturnType<typeof recallCoverage>>[number];

/** One row of `memory.overview` → `briefs`. */
export interface BriefSummary {
  id: string;
  issueId: string | null;
  issueIdentifier: string | null;
  agentId: string | null;
  query: string | null;
  method: BriefRow["method"];
  /** Facts in the brief. */
  facts: number;
  /** Facts the keyword baseline would have picked. */
  baseline: number;
  totalFacts: number;
  tokens: number;
  latencyMs: number;
  createdAt: string;
}

export interface MemoryClient {
  clientRef: string;
  clientName: string;
}

export interface MemoryLimits {
  factMaxChars: number;
  factMinChars: number;
  briefMaxFacts: number;
  briefMaxTokens: number;
  pinnedMaxPerScope: number;
  searchMaxResults: number;
  scopeActiveCap: number;
}

/** `memory.overview`. */
export interface MemoryOverview {
  stats: MemoryStats;
  /** Optional: workers older than the coverage change do not send it. */
  coverage?: CoverageRow[];
  briefs: BriefSummary[];
  jevConfigured: boolean;
  clients: MemoryClient[];
  areas: string[];
  kinds: string[];
  limits: MemoryLimits;
}

export interface FactList {
  facts: MemoryFact[];
  total: number;
}

export type AgentRef = Pick<AgentLite, "id" | "name" | "urlKey">;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The message of a failed page action. The host rejects with a plain
 * `{ code, message }` object (not an `Error`), which `errorText()` would turn
 * into "Request failed"; the worker's message explains what to fix.
 */
export function actionErrorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === "object") {
    const { message, error: inner } = error as { message?: unknown; error?: unknown };
    if (typeof message === "string" && message.trim()) return message;
    if (typeof inner === "string" && inner.trim()) return inner;
  }
  if (typeof error === "string" && error.trim()) return error;
  return "Request failed";
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const AREA_LABELS: Record<string, string> = {
  seo: "SEO",
  social: "Social",
  crm: "CRM",
  mailbox: "Mailbox",
  campaigns: "Campaigns",
  billing: "Billing",
  accounting: "Accounting",
  payroll: "Payroll",
  partners: "Partners",
  operations: "Operations",
  general: "General",
};

function capitalise(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export function areaLabel(area: string | null | undefined): string {
  if (!area) return "Any area";
  return AREA_LABELS[area] ?? capitalise(area);
}

export function kindLabel(kind: string): string {
  return capitalise(kind);
}

/** Warnings stand out; rules are must-follow; the rest are plain knowledge. */
export function kindTone(kind: string): ToneInput {
  if (kind === "warning") return "warn";
  if (kind === "rule") return "info";
  return "neutral";
}

/** Only rules and warnings can be pinned (always in their client's and area's briefs). */
export function isPinnable(kind: string): boolean {
  return kind === "rule" || kind === "warning";
}

export const STATUS_LABEL: Record<FactStatus, string> = { active: "Active", superseded: "Replaced", archived: "Archived" };

/** How a brief's facts were picked, in plain words ("Jev" is smart matching: an optional AI service). */
export const METHOD_LABEL: Record<BriefRow["method"], string> = { jev: "Smart matching", baseline: "Keywords", empty: "Nothing matched", search: "Search" };

export const METHOD_HELP: Record<BriefRow["method"], string> = {
  jev: "Smart matching picked the facts this task needs.",
  baseline: "Picked by keywords and how recent the facts are (smart matching is off, or did not answer in time).",
  empty: "No stored fact applied to this task.",
  search: "An agent searched memory for something specific.",
};

/** The optional AI service that picks each task's facts, by its plain name. */
export const SMART_MATCHING = "Smart matching (optional)";

export function methodTone(method: string): ToneInput {
  return method === "jev" ? "info" : "neutral";
}

/** "Company-wide", the client's name, or its ref when no name is known. */
export function clientLabel(clientRef: string | null | undefined, clientName: string | null | undefined, clients: MemoryClient[] = []): string {
  if (!clientRef) return "Company-wide";
  return clientName || clients.find((c) => c.clientRef === clientRef)?.clientName || clientRef;
}

/** A review scope key (`<clientRef or *>|<area>`) as a client, an area and a label. */
export function scopeInfo(scope: string, clients: MemoryClient[] = []): { clientRef: string | null; area: string; label: string } {
  const at = scope.lastIndexOf("|");
  const ref = at >= 0 ? scope.slice(0, at) : scope;
  const area = at >= 0 ? scope.slice(at + 1) : "general";
  const clientRef = ref === "*" || ref === "" ? null : ref;
  return { clientRef, area, label: `${clientLabel(clientRef, null, clients)} · ${areaLabel(area)}` };
}

export function agentRef(agentId: string | null | undefined, agents: AgentRef[]): { name: string; href: string } | null {
  if (!agentId) return null;
  const agent = agents.find((a) => a.id === agentId);
  return { name: agent?.name ?? `Agent ${agentId.slice(0, 8)}`, href: `/agents/${agent?.urlKey || agentId}` };
}

/** Link path for an issue (identifier when known), like the rest of the Cockpit builds them. */
export function issuePath(identifier: string | null | undefined, id: string | null | undefined): string | null {
  const ref = identifier || id;
  return ref ? `/issues/${ref}` : null;
}

export const ORIGIN_LABEL: Record<FactOrigin, string> = { tool: "Agent", harvest: "Saved from comment", person: "Person" };

export const ORIGIN_HELP: Record<FactOrigin, string> = {
  tool: "An agent saved it with memory-add.",
  harvest: "Saved automatically from a Learned: line in an issue comment.",
  person: "Added by a person.",
};

/** How the fact was saved (older workers do not send `origin`). */
export function originOf(fact: Pick<MemoryFact, "createdByAgentId" | "createdByUserId"> & { origin?: FactOrigin | null }): FactOrigin {
  if (fact.origin === "tool" || fact.origin === "harvest" || fact.origin === "person") return fact.origin;
  return fact.createdByUserId && !fact.createdByAgentId ? "person" : "tool";
}

/** Where the fact came from: its issue, and the comment itself when it was saved from a Learned: line. */
export function sourcePath(fact: Pick<MemoryFact, "sourceIdentifier" | "sourceIssueId"> & { sourceCommentId?: string | null }): string | null {
  const issue = issuePath(fact.sourceIdentifier, fact.sourceIssueId);
  return issue && fact.sourceCommentId ? `${issue}#comment-${fact.sourceCommentId}` : issue;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function formatCount(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return "–";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** Share of this week's briefs picked by smart matching (0–100), or null when there were none. */
export function jevShare(stats: MemoryStats): number | null {
  const total = stats.briefs7d.total;
  return total > 0 ? Math.round((stats.briefs7d.jev / total) * 100) : null;
}

/** How agents (and people) save lessons without a tool call; shown under the sentence below. */
export const LEARNED_HINT = { before: "Agents save lessons by ending a closing comment with ", marker: "Learned:", after: " bullets; you can do the same on any issue." } as const;

/** The one sentence at the top of the tab. */
export function memorySentence(limits: Pick<MemoryLimits, "briefMaxFacts">): string {
  return `Memory is what your agents learn as they work (client preferences, facts about their systems, lessons and warnings), and each new task starts with a short brief of only the facts it needs: at most ${limits.briefMaxFacts}.`;
}

/**
 * A memory action's message for people: the worker writes it for agents too,
 * so it names facts by id ("Saved [m1x…]") and tools ("use memory-update").
 * Ids and tool hints are dropped; null when nothing is left worth saying.
 */
export function plainMemoryMessage(message: unknown): string | undefined {
  if (typeof message !== "string" || !message.trim()) return undefined;
  const sentences = message
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/memory-(?:update|add|search|recall|feedback)|\{\s*id:|^Similar:/i.test(sentence))
    .map((sentence) => sentence
      .replace(/\bknown as\s*\[[a-z0-9]{6,}\]/gi, "known")
      .replace(/\breplaces\s*\[[a-z0-9]{6,}\]/gi, "replaces an older fact")
      .replace(/\s*\[[a-z0-9]{6,}\]/gi, "")
      .replace(/\s+([.,;:)])/g, "$1")
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim())
    .filter((sentence) => sentence && !/^Updated(?: \([a-z]+\))?\.?$/i.test(sentence));
  const text = sentences.join(" ").trim();
  return text || undefined;
}

/** One entry per client name for the pickers: the first ref (the CRM's) and every ref with that name. */
export interface ClientOption {
  value: string;
  label: string;
  refs: string[];
}

/**
 * Clients by name, once each. Memory may know one client under two refs
 * (the CRM company and an older ref from a fact); the picker shows it once
 * and a filter on it covers both.
 */
export function clientOptions(clients: MemoryClient[]): ClientOption[] {
  const byName = new Map<string, ClientOption>();
  for (const client of clients) {
    const key = client.clientName.trim().toLowerCase();
    const found = byName.get(key);
    if (found) {
      if (!found.refs.includes(client.clientRef)) found.refs.push(client.clientRef);
    } else byName.set(key, { value: client.clientRef, label: client.clientName.trim(), refs: [client.clientRef] });
  }
  return [...byName.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Every ref behind a picked client value (itself, plus the refs sharing its name). */
export function refsFor(value: string, clients: MemoryClient[]): string[] {
  return clientOptions(clients).find((option) => option.refs.includes(value))?.refs ?? [value];
}

/** `YYYY-MM-DD` for a date input (UTC, like the stored expiry), or "". */
export function dateInput(iso: string | null | undefined): string {
  return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "";
}

/** The earliest expiry a date input may offer: tomorrow (UTC), since it must be in the future. */
export function minExpiry(now: Date): string {
  return new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "31 Dec 2026" (UTC, so it matches the stored date). */
export function shortDate(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return iso ?? "";
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
}

export const PLUGINS_SETTINGS_PATH = "/company/settings/instance/plugins";

/** The Cockpit's own settings page (where the Jev key goes), or the plugin list. */
export function settingsPath(installationId: string | null | undefined): string {
  return installationId ? `${PLUGINS_SETTINGS_PATH}/${installationId}` : PLUGINS_SETTINGS_PATH;
}

/** `/_plugins/<installation id>/ui/` → the installation id. */
export function installationIdFromUiBase(base: string | null | undefined): string | null {
  return base ? /\/_plugins\/([^/]+)\/ui\//.exec(base)?.[1] ?? null : null;
}

/** True when the expiry has passed (the daily upkeep archives such facts). */
export function isExpired(iso: string | null | undefined, now: Date): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= now.getTime();
}

// ---------------------------------------------------------------------------
// Facts: filters and paging
// ---------------------------------------------------------------------------

export type StatusFilter = FactStatus | "all";

export interface FactFilters {
  status: StatusFilter;
  /** "" = every client, "own" = company-wide facts only, else a client ref. */
  client: string;
  /** "" = every area. */
  area: string;
  pinned: boolean;
  q: string;
}

export const DEFAULT_FILTERS: FactFilters = { status: "active", client: "", area: "", pinned: false, q: "" };
export const PAGE_SIZE = 25;

/** Params for `memory.list`. Empty filters are left out; a client known under several refs sends them all. */
export function listParams(filters: FactFilters, page: number, pageSize = PAGE_SIZE, clients: MemoryClient[] = []): Record<string, unknown> {
  const params: Record<string, unknown> = { status: filters.status, limit: pageSize, offset: Math.max(0, page) * pageSize };
  if (filters.client) {
    const refs = filters.client === "own" ? [] : refsFor(filters.client, clients);
    if (refs.length > 1) params.clients = refs;
    else params.client = filters.client;
  }
  if (filters.area) params.area = filters.area;
  if (filters.pinned) params.pinned = true;
  const q = filters.q.trim();
  if (q) params.q = q;
  return params;
}

export function filtersActive(filters: FactFilters): boolean {
  return filters.status !== DEFAULT_FILTERS.status || Boolean(filters.client) || Boolean(filters.area) || filters.pinned || Boolean(filters.q.trim());
}

export function pageCount(total: number, pageSize = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

/** "26–50 of 230". */
export function pageLabel(total: number, page: number, pageSize = PAGE_SIZE): string {
  if (total <= 0) return "0 facts";
  const from = Math.min(total, page * pageSize + 1);
  const to = Math.min(total, (page + 1) * pageSize);
  return `${formatCount(from)}–${formatCount(to)} of ${formatCount(total)}`;
}

/** Row buttons a fact gets, in order. */
export function factActions(fact: Pick<MemoryFact, "status" | "pinned" | "kind">): Array<"edit" | "pin" | "unpin" | "archive" | "restore" | "supersede"> {
  const out: Array<"edit" | "pin" | "unpin" | "archive" | "restore" | "supersede"> = ["edit"];
  if (fact.status === "active") {
    if (fact.pinned) out.push("unpin");
    else if (isPinnable(fact.kind)) out.push("pin");
    out.push("archive", "supersede");
  } else {
    out.push("restore");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Add and edit
// ---------------------------------------------------------------------------

/**
 * The text as the Cockpit stores it: one line, no list marker (mirrors
 * `normalizeFactText` in `memory/engine.ts`, which the page cannot import).
 */
export function cleanFactText(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .trim();
}

/** Character count against the limits, for the counter under the text box. */
export function textCheck(text: string, limits: Pick<MemoryLimits, "factMinChars" | "factMaxChars">): { length: number; ok: boolean; tone: ToneInput; note: string } {
  const length = cleanFactText(text).length;
  if (length > limits.factMaxChars) return { length, ok: false, tone: "bad", note: `${length - limits.factMaxChars} over the limit: keep what changes how the work is done, or split it.` };
  if (length < limits.factMinChars) return { length, ok: false, tone: "neutral", note: `At least ${limits.factMinChars} characters.` };
  return { length, ok: true, tone: length > limits.factMaxChars * 0.9 ? "warn" : "neutral", note: "" };
}

/** `company:<id>` / `contact:<id>` when valid, else null. */
export function newClientRef(value: string): string | null {
  const parsed = parseClientParam(value.trim());
  return parsed ? `${parsed.kind}:${parsed.id}` : null;
}

/** Client select value for "a client the memory does not know yet". */
export const NEW_CLIENT = "__new__";

export interface AddDraft {
  text: string;
  /** "own", a known client ref, or `NEW_CLIENT`. */
  client: string;
  newRef: string;
  newName: string;
  area: string;
  kind: string;
  pinned: boolean;
  /** `YYYY-MM-DD` or "". */
  expires: string;
}

export const EMPTY_DRAFT: AddDraft = { text: "", client: "own", newRef: "", newName: "", area: "general", kind: "fact", pinned: false, expires: "" };

/** Params for `memory.add`, or what to fix first. */
export function addParams(draft: AddDraft): { params: Record<string, unknown> } | { error: string } {
  const params: Record<string, unknown> = { text: draft.text, area: draft.area || "general", kind: draft.kind || "fact" };
  if (draft.client === NEW_CLIENT) {
    const ref = newClientRef(draft.newRef);
    if (!ref) return { error: 'Type the client as "company:<CRM id>" or "contact:<CRM id>".' };
    const name = draft.newName.trim();
    if (!name) return { error: "Add the client's name: briefs use it to recognise the client in task titles." };
    params.client = ref;
    params.clientName = name;
  } else {
    params.client = draft.client || "own";
  }
  if (draft.pinned && isPinnable(params.kind as string)) params.pinned = true;
  if (draft.expires) params.expiresAt = draft.expires;
  return { params };
}

export interface EditDraft {
  text: string;
  kind: string;
  area: string;
  /** `YYYY-MM-DD` or "" for no expiry. */
  expires: string;
}

export function editDraft(fact: MemoryFact): EditDraft {
  return { text: fact.text, kind: fact.kind, area: fact.area, expires: dateInput(fact.expiresAt) };
}

/**
 * Params for `memory.update` with only what changed, or null when nothing
 * did. A pinned fact that stops being a rule or warning is unpinned, since
 * only those can be pinned.
 */
export function editParams(fact: MemoryFact, draft: EditDraft): Record<string, unknown> | null {
  const params: Record<string, unknown> = { id: fact.id };
  if (cleanFactText(draft.text) !== fact.text) params.text = draft.text;
  if (draft.kind !== fact.kind) {
    params.kind = draft.kind;
    if (fact.pinned && !isPinnable(draft.kind)) params.pinned = false;
  }
  if (draft.area !== fact.area) params.area = draft.area;
  if (draft.expires !== dateInput(fact.expiresAt)) params.expiresAt = draft.expires || null;
  return Object.keys(params).length > 1 ? params : null;
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

/** "Brief for PIB-23", "Search: “Northwind hosting”", or "Brief". */
export function briefTitle(brief: Pick<BriefSummary, "id" | "issueIdentifier" | "query" | "method">): string {
  if (brief.method === "search" && brief.query) return `Search: “${truncate(brief.query, 48)}”`;
  if (brief.issueIdentifier) return `Brief for ${brief.issueIdentifier}`;
  if (brief.query) return `Brief for “${truncate(brief.query, 48)}”`;
  return "Brief";
}

export interface BriefLine {
  id: string;
  fact: MemoryFact | null;
  /** Jev's probability (0–1), when Jev scored it. */
  score: number | null;
  inBrief: boolean;
  inBaseline: boolean;
}

/**
 * What a logged brief included, and what the keyword baseline would have
 * picked instead (only differs when Jev chose).
 */
export function compareBrief(brief: Pick<BriefRow, "factIds" | "baselineIds" | "scores">, facts: MemoryFact[]): { included: BriefLine[]; baselineOnly: BriefLine[]; agreed: number; same: boolean } {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const inBrief = new Set(brief.factIds);
  const inBase = new Set(brief.baselineIds);
  const line = (id: string): BriefLine => ({
    id,
    fact: byId.get(id) ?? null,
    score: typeof brief.scores?.[id] === "number" ? brief.scores[id]! : null,
    inBrief: inBrief.has(id),
    inBaseline: inBase.has(id),
  });
  const included = brief.factIds.map(line);
  const baselineOnly = brief.baselineIds.filter((id) => !inBrief.has(id)).map(line);
  const agreed = brief.factIds.filter((id) => inBase.has(id)).length;
  return { included, baselineOnly, agreed, same: baselineOnly.length === 0 && agreed === brief.factIds.length };
}

/** How the preview found the client, in words. */
export function clientResolution(client: BriefResult["client"]): string {
  const names = client.names.length ? client.names.join(", ") : client.refs.join(", ");
  switch (client.how) {
    case "own":
      return "Company-wide facts only (own work)";
    case "given":
      return names ? `${names} (as chosen)` : "As chosen";
    case "named":
      return `${names} (named in the task)`;
    case "jev":
      return `${names} (picked by smart matching)`;
    default:
      return "No client found: company-wide facts only";
  }
}

// ---------------------------------------------------------------------------
// Agent coverage and attention
// ---------------------------------------------------------------------------

/** Same rule as the review: 3+ finished runs and under half started with a brief. */
export function lowCoverage(row: Pick<CoverageRow, "runs" | "withBrief">): boolean {
  return row.runs >= 3 && row.withBrief / row.runs < 0.5;
}

export interface CoverageLine {
  agentId: string;
  name: string;
  href: string;
  runs: number;
  withBrief: number;
  low: boolean;
}

/** Agents with finished runs, the ones skipping memory first, then by runs. */
export function coverageLines(rows: CoverageRow[] | null | undefined, agents: AgentRef[]): CoverageLine[] {
  return (rows ?? [])
    .filter((r) => r.runs > 0)
    .map((r) => {
      const agent = agentRef(r.agentId, agents)!;
      return { agentId: r.agentId, name: agent.name, href: agent.href, runs: r.runs, withBrief: Math.min(r.withBrief, r.runs), low: lowCoverage(r) };
    })
    .sort((a, b) => Number(b.low) - Number(a.low) || b.runs - a.runs || a.name.localeCompare(b.name));
}

/** Items the Needs attention card lists (stale facts are information only). */
export function attentionCount(review: MemoryReview | null): number {
  if (!review) return 0;
  return review.duplicates.length + review.noisy.length + review.overCap.length + (review.agentsSkippingMemory?.length ?? 0) + (review.misfiled?.length ?? 0);
}
