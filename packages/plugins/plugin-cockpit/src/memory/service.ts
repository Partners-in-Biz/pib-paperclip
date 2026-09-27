/**
 * Company memory service: recall (the brief), add, update, search, feedback,
 * review and daily upkeep. Tools and page actions call these.
 */
import { randomBytes } from "node:crypto";
import {
  isMemoryArea,
  isMemoryKind,
  MEMORY_LIMITS,
  memoryAreaForOrigin,
  parseClientParam,
  type MemoryArea,
  type MemoryKind,
} from "@partnersinbiz/pib-plugin-kit";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { Env } from "../env.js";
import {
  baselineSelect,
  clientChoice,
  clientsMentioned,
  factHash,
  factLine,
  isLive,
  jevBatches,
  parseLearned,
  jevSelect,
  normalizeFactText,
  overlap,
  pack,
  rankFacts,
  renderBrief,
  scoresFrom,
  SELECTION,
  sensitiveReason,
  type FactOrigin,
  type MemoryFact,
  type RankedFact,
  type Selection,
  type TaskContext,
} from "./engine.js";
import { jevOnce, memoryJevConfig, runJevBatches } from "./jev.js";
import * as store from "./store.js";

export class MemoryError extends Error {}

export interface Actor {
  agentId: string | null;
  runId: string | null;
  userId: string | null;
}

function shortId(prefix: string): string {
  // 10 base-32 characters (50 bits): short in briefs, unique enough per company.
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = randomBytes(10);
  let out = prefix;
  for (const b of bytes) out += alphabet[b % 32];
  return out;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

// ---------------------------------------------------------------------------
// Task and client resolution
// ---------------------------------------------------------------------------

interface LoadedIssue {
  id: string;
  identifier: string | null;
  title: string;
  description: string;
  originKind: string | null;
  context: string[];
}

async function loadIssue(env: Env, companyId: string, issueRef: string): Promise<LoadedIssue | null> {
  const issue = await env.ctx.issues.get(issueRef, companyId).catch(() => null);
  if (!issue || (issue as { companyId?: string }).companyId && (issue as { companyId?: string }).companyId !== companyId) return null;
  const context: string[] = [];
  let parentId = (issue as { parentId?: string | null }).parentId ?? null;
  for (let depth = 0; parentId && depth < 2; depth += 1) {
    const parent = await env.ctx.issues.get(parentId, companyId).catch(() => null);
    if (!parent) break;
    context.push(String(parent.title ?? ""));
    parentId = (parent as { parentId?: string | null }).parentId ?? null;
  }
  return {
    id: String(issue.id),
    identifier: (issue as { identifier?: string | null }).identifier ?? null,
    title: String(issue.title ?? ""),
    description: String((issue as { description?: string | null }).description ?? ""),
    originKind: (issue as { originKind?: string | null }).originKind ?? null,
    context,
  };
}

export interface ClientResolution {
  refs: string[];
  names: string[];
  how: "given" | "own" | "named" | "jev" | "none";
}

/**
 * Which client(s) the work is for: given explicitly (`company:<id>`,
 * `contact:<id>`, a known client name, or `own`), else names found in the
 * task text, else (with Jev, when memory knows clients) Jev's pick.
 */
export async function resolveClients(
  env: Env,
  companyId: string,
  input: { client?: unknown; clientName?: unknown },
  task: Pick<TaskContext, "title" | "description" | "context">,
  options: { allowJev: boolean },
): Promise<ClientResolution> {
  const known = await store.knownClients(env.ctx, companyId);
  const nameOf = (ref: string) => known.find((k) => k.clientRef === ref)?.clientName ?? null;
  const given = text(input.client, 200);
  if (given) {
    if (given.toLowerCase() === "own") return { refs: [], names: [], how: "own" };
    const parsed = parseClientParam(given);
    if (parsed) {
      const ref = `${parsed.kind}:${parsed.id}`;
      const name = text(input.clientName, 200) ?? nameOf(ref);
      return { refs: [ref], names: name ? [name] : [], how: "given" };
    }
    const byName = known.find((k) => k.clientName.toLowerCase() === given.toLowerCase());
    if (byName) return { refs: [byName.clientRef], names: [byName.clientName], how: "given" };
    throw new MemoryError(`Unknown client "${given}". Pass "company:<id>" or "contact:<id>" from the CRM (and clientName), or "own".`);
  }
  if (known.length === 0) return { refs: [], names: [], how: "none" };
  const hay = [task.title, task.description, ...task.context].join("\n");
  const named = clientsMentioned(hay, known);
  if (named.length) return { refs: named, names: named.map((r) => nameOf(r)!).filter(Boolean), how: "named" };
  if (options.allowJev) {
    const config = await memoryJevConfig(env.ctx, companyId);
    const choice = config ? clientChoice({ issueId: null, identifier: null, title: task.title, description: task.description, context: task.context, clientRefs: [], clientNames: [], area: null }, known) : null;
    if (config && choice) {
      const res = await jevOnce(config, choice.state, choice.questions, env.fetchImpl);
      const answer = res?.answers?.client;
      if (answer && answer.type === "choice" && answer.choice !== "none" && answer.confidence >= SELECTION.clientChoiceMin) {
        const ref = choice.options[answer.choice];
        if (ref) return { refs: [ref], names: [nameOf(ref)!].filter(Boolean), how: "jev" };
      }
    }
  }
  return { refs: [], names: [], how: "none" };
}

// ---------------------------------------------------------------------------
// Recall: the brief
// ---------------------------------------------------------------------------

export interface RecallInput {
  issueId?: unknown;
  query?: unknown;
  client?: unknown;
  clientName?: unknown;
  area?: unknown;
  fresh?: unknown;
}

export interface BriefFact {
  id: string;
  text: string;
  clientName: string | null;
  clientRef: string | null;
  area: MemoryArea;
  kind: MemoryKind;
  pinned: boolean;
  score: number | null;
  inBaseline: boolean;
}

export interface BriefResult {
  briefId: string;
  body: string;
  method: Selection["method"];
  cached: boolean;
  issue: { id: string; identifier: string | null; title: string } | null;
  client: ClientResolution;
  area: MemoryArea | null;
  totalFacts: number;
  candidateCount: number;
  tokens: number;
  facts: BriefFact[];
}

function briefFacts(selected: RankedFact[], baselineIds: string[], scores: Record<string, number>): BriefFact[] {
  return selected.map((r) => ({
    id: r.fact.id,
    text: r.fact.text,
    clientName: r.fact.clientName,
    clientRef: r.fact.clientRef,
    area: r.fact.area,
    kind: r.fact.kind,
    pinned: r.fact.pinned,
    score: typeof scores[r.fact.id] === "number" ? Math.round(scores[r.fact.id]! * 100) / 100 : null,
    inBaseline: baselineIds.includes(r.fact.id),
  }));
}

/** Pick facts for a task: scan → rank → Jev (or baseline) → pack. */
export async function selectFacts(
  env: Env,
  companyId: string,
  task: TaskContext,
  options: { mode: "brief" | "search"; maxFacts: number; allClients?: boolean },
): Promise<{ selection: Selection; model: string | null; jevInputTokens: number }> {
  const now = env.now();
  // A brief never mixes clients. An explicit search without a client looks at every client (each result names its client).
  const scope = options.mode === "search" && task.clientRefs.length === 0 && options.allClients ? "all" : task.clientRefs;
  const scanned = (await store.scanCandidates(env.ctx, companyId, scope, SELECTION.scanLimit)).filter((f) => isLive(f, now));
  if (scanned.length === 0) {
    return { selection: { method: "empty", selected: [], baselineIds: [], scores: {}, tokens: 0, candidateCount: 0 }, model: null, jevInputTokens: 0 };
  }
  const ranked = rankFacts(scanned, task, now);
  const pool = ranked.slice(0, SELECTION.candidatePool);
  const limits = { maxFacts: options.maxFacts, maxTokens: MEMORY_LIMITS.briefMaxTokens };
  const baselinePool = options.mode === "search" ? pool.filter((r) => r.lexical > 0) : baselineSelect(pool);
  const baseline = pack(baselinePool, limits);
  const baselineIds = baseline.facts.map((r) => r.fact.id);
  const config = await memoryJevConfig(env.ctx, companyId);
  if (config) {
    const batches = jevBatches(task, pool);
    const run = await runJevBatches(config, batches, env.fetchImpl);
    const scores = scoresFrom(batches, run.answers);
    if (Object.keys(scores).length > 0) {
      const picked = pack(jevSelect(pool, scores), limits);
      return {
        selection: { method: "jev", selected: picked.facts, baselineIds, scores, tokens: picked.tokens, candidateCount: pool.length },
        model: run.model ?? config.model ?? null,
        jevInputTokens: run.inputTokens,
      };
    }
    env.ctx.logger.info("Memory: Jev gave no answers; using the keyword baseline", { companyId, failures: run.failures });
  }
  return { selection: { method: "baseline", selected: baseline.facts, baselineIds, scores: {}, tokens: baseline.tokens, candidateCount: pool.length }, model: null, jevInputTokens: 0 };
}

export async function recall(env: Env, companyId: string, input: RecallInput, actor: Actor, options: { preview?: boolean } = {}): Promise<BriefResult> {
  const started = Date.now();
  const issueRef = text(input.issueId, 100);
  const query = text(input.query, 1000);
  if (!issueRef && !query) throw new MemoryError("Pass issueId (the task you are working on), or a query.");
  const issue = issueRef ? await loadIssue(env, companyId, issueRef) : null;
  if (issueRef && !issue) throw new MemoryError(`Issue ${issueRef} was not found in this company.`);

  const versionNow = await store.factsVersion(env.ctx, companyId);
  if (issue && actor.agentId && input.fresh !== true && !options.preview) {
    const cached = await store.recentBriefFor(env.ctx, companyId, issue.id, actor.agentId, SELECTION.cacheMinutes);
    if (cached && cached.factsVersion === versionNow.version) {
      const facts = await store.getFacts(env.ctx, companyId, cached.factIds);
      const byId = new Map(facts.map((f) => [f.id, f]));
      return {
        briefId: cached.id,
        body: cached.body,
        method: cached.method === "search" ? "baseline" : cached.method,
        cached: true,
        issue: { id: issue.id, identifier: issue.identifier, title: issue.title },
        client: { refs: cached.clientRefs, names: [...new Set(facts.map((f) => f.clientName).filter((n): n is string => Boolean(n)))], how: "given" },
        area: isMemoryArea(cached.area) ? cached.area : null,
        totalFacts: cached.totalFacts,
        candidateCount: cached.candidateCount,
        tokens: cached.tokens,
        facts: cached.factIds
          .map((id) => byId.get(id))
          .filter((f): f is MemoryFact => Boolean(f))
          .map((f) => ({ id: f.id, text: f.text, clientName: f.clientName, clientRef: f.clientRef, area: f.area, kind: f.kind, pinned: f.pinned, score: cached.scores[f.id] ?? null, inBaseline: cached.baselineIds.includes(f.id) })),
      };
    }
  }

  const title = issue?.title ?? query ?? "";
  const description = issue ? [issue.description, query ? `Focus: ${query}` : ""].filter(Boolean).join("\n\n") : "";
  const context = issue?.context ?? [];
  const area = isMemoryArea(input.area) ? input.area : memoryAreaForOrigin(issue?.originKind);
  const client = await resolveClients(env, companyId, input, { title, description, context }, { allowJev: true });
  const task: TaskContext = {
    issueId: issue?.id ?? null,
    identifier: issue?.identifier ?? null,
    title,
    description,
    context,
    clientRefs: client.refs,
    clientNames: client.names,
    area,
  };
  const { selection, model, jevInputTokens } = await selectFacts(env, companyId, task, { mode: "brief", maxFacts: MEMORY_LIMITS.briefMaxFacts });
  const briefId = shortId("b");
  const body = renderBrief({ task, selection, totalFacts: versionNow.active, briefId });
  const factIds = selection.selected.map((r) => r.fact.id);
  if (!options.preview) {
    await store.insertBrief(env.ctx, {
      id: briefId,
      companyId,
      issueId: issue?.id ?? null,
      issueIdentifier: issue?.identifier ?? null,
      agentId: actor.agentId,
      runId: actor.runId,
      query,
      clientRefs: client.refs,
      area,
      method: selection.method,
      model,
      version: SELECTION.version,
      totalFacts: versionNow.active,
      candidateCount: selection.candidateCount,
      factIds,
      baselineIds: selection.baselineIds,
      scores: Object.fromEntries(Object.entries(selection.scores).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
      tokens: selection.tokens,
      jevInputTokens,
      latencyMs: Date.now() - started,
      factsVersion: versionNow.version,
      body,
    });
    await store.markUsed(env.ctx, companyId, factIds);
  }
  return {
    briefId,
    body,
    method: selection.method,
    cached: false,
    issue: issue ? { id: issue.id, identifier: issue.identifier, title: issue.title } : null,
    client,
    area,
    totalFacts: versionNow.active,
    candidateCount: selection.candidateCount,
    tokens: selection.tokens,
    facts: briefFacts(selection.selected, selection.baselineIds, selection.scores),
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function search(env: Env, companyId: string, input: { query?: unknown; client?: unknown; clientName?: unknown; area?: unknown; limit?: unknown }, actor: Actor) {
  const query = text(input.query, 500);
  if (!query) throw new MemoryError("query is required: say what you need to know, e.g. \"Northwind blog tone\".");
  const area = isMemoryArea(input.area) ? input.area : null;
  const client = await resolveClients(env, companyId, input, { title: query, description: "", context: [] }, { allowJev: false });
  const limit = Math.max(1, Math.min(MEMORY_LIMITS.searchMaxResults, typeof input.limit === "number" ? Math.floor(input.limit) : MEMORY_LIMITS.searchMaxResults));
  const task: TaskContext = { issueId: null, identifier: null, title: query, description: "", context: [], clientRefs: client.refs, clientNames: client.names, area };
  const own = typeof input.client === "string" && input.client.trim().toLowerCase() === "own";
  const { selection, model, jevInputTokens } = await selectFacts(env, companyId, task, { mode: "search", maxFacts: limit, allClients: !own });
  const id = shortId("s");
  const versionNow = await store.factsVersion(env.ctx, companyId);
  const body = selection.selected.length ? selection.selected.map((r) => factLine(r.fact)).join("\n") : `No stored facts match "${query}".`;
  await store.insertBrief(env.ctx, {
    id,
    companyId,
    issueId: null,
    issueIdentifier: null,
    agentId: actor.agentId,
    runId: actor.runId,
    query,
    clientRefs: client.refs,
    area,
    method: "search",
    model,
    version: SELECTION.version,
    totalFacts: versionNow.active,
    candidateCount: selection.candidateCount,
    factIds: selection.selected.map((r) => r.fact.id),
    baselineIds: selection.baselineIds,
    scores: selection.scores,
    tokens: selection.tokens,
    jevInputTokens,
    latencyMs: 0,
    factsVersion: versionNow.version,
    body,
  });
  return { searchId: id, body, method: selection.method === "empty" ? "empty" : selection.method, facts: briefFacts(selection.selected, selection.baselineIds, selection.scores) };
}

// ---------------------------------------------------------------------------
// Add and update
// ---------------------------------------------------------------------------

export interface AddInput {
  text?: unknown;
  client?: unknown;
  clientName?: unknown;
  area?: unknown;
  kind?: unknown;
  issueId?: unknown;
  supersedes?: unknown;
  pinned?: unknown;
  expiresAt?: unknown;
}

function checkText(raw: unknown): string {
  const value = typeof raw === "string" ? normalizeFactText(raw) : "";
  if (value.length < MEMORY_LIMITS.factMinChars) throw new MemoryError(`text is required: one fact of ${MEMORY_LIMITS.factMinChars}–${MEMORY_LIMITS.factMaxChars} characters.`);
  if (value.length > MEMORY_LIMITS.factMaxChars) {
    throw new MemoryError(`That is ${value.length} characters; a fact is at most ${MEMORY_LIMITS.factMaxChars}. Keep only what changes how the work is done, or split it into separate facts.`);
  }
  const secret = sensitiveReason(value);
  if (secret) throw new MemoryError(`Not saved: the text looks like it contains ${secret}. Facts are shared with every agent, so never store secrets, card or ID numbers. Describe where to find it instead (e.g. "the key is in the SEO plugin settings").`);
  return value;
}

function checkExpiry(raw: unknown, now: Date): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) throw new MemoryError("expiresAt must be an ISO date, e.g. 2026-12-31.");
  const at = new Date(Date.parse(raw));
  if (at.getTime() <= now.getTime()) throw new MemoryError("expiresAt must be in the future.");
  return at.toISOString();
}

export interface AddResult {
  status: "added" | "duplicate";
  fact: MemoryFact;
  message: string;
  similar: Array<{ id: string; text: string; relation: "same" | "conflict" | "similar" }>;
  superseded: string | null;
}

export interface AddOptions {
  /** Default "tool" (an agent's memory-add). */
  origin?: FactOrigin;
  sourceCommentId?: string | null;
}

export async function addFact(env: Env, companyId: string, input: AddInput, actor: Actor, options: AddOptions = {}): Promise<AddResult> {
  const origin: FactOrigin = options.origin ?? "tool";
  // Saying it again is a sign it matters, unless it is the same comment being read twice.
  const bumpOnDuplicate = origin !== "harvest";
  const now = env.now();
  const factText = checkText(input.text);
  const kind: MemoryKind = isMemoryKind(input.kind) ? input.kind : "fact";
  const issueRef = text(input.issueId, 100);
  const issue = issueRef ? await loadIssue(env, companyId, issueRef) : null;
  if (issueRef && !issue) throw new MemoryError(`Issue ${issueRef} was not found in this company.`);
  let area: MemoryArea;
  if (input.area != null && input.area !== "") {
    if (!isMemoryArea(input.area)) throw new MemoryError(`area must be one of: seo, social, crm, mailbox, campaigns, billing, accounting, payroll, partners, operations, general.`);
    area = input.area;
  } else area = memoryAreaForOrigin(issue?.originKind) ?? "general";

  // Client: given, or taken from the issue so client facts never become company-wide by accident.
  let client = await resolveClients(env, companyId, input, { title: issue?.title ?? "", description: issue?.description ?? "", context: issue?.context ?? [] }, { allowJev: Boolean(issue) });
  if (client.refs.length > 1) client = { ...client, refs: client.refs.slice(0, 1), names: client.names.slice(0, 1) };
  const clientRef = client.refs[0] ?? null;
  const clientName = clientRef ? client.names[0] ?? text(input.clientName, 200) : null;
  if (clientRef && !clientName) throw new MemoryError("clientName is required the first time a client is used (e.g. \"Northwind Traders\"). It is how briefs recognise the client in task titles.");

  const expiresAt = checkExpiry(input.expiresAt, now);
  let pinned = input.pinned === true;
  const notes: string[] = [];
  if (pinned && kind !== "rule" && kind !== "warning") {
    pinned = false;
    notes.push("Only rules and warnings can be pinned; saved unpinned.");
  }
  if (pinned && (await store.countPinned(env.ctx, companyId, clientRef, area)) >= MEMORY_LIMITS.pinnedMaxPerScope) {
    pinned = false;
    notes.push(`This client and area already has ${MEMORY_LIMITS.pinnedMaxPerScope} pinned rules; saved unpinned. Unpin one first if this matters more.`);
  }

  const supersedesId = text(input.supersedes, 40);
  const old = supersedesId ? await store.getFact(env.ctx, companyId, supersedesId) : null;
  if (supersedesId && (!old || old.status !== "active")) throw new MemoryError(`supersedes: no active fact ${supersedesId} in this company.`);

  const textHash = factHash(clientRef, factText);
  const existing = await store.findActiveByHash(env.ctx, companyId, textHash);
  if (existing) {
    if (bumpOnDuplicate) await store.bumpFeedback(env.ctx, companyId, [existing.id], "helpful");
    return { status: "duplicate", fact: existing, message: `Already known as [${existing.id}].`, similar: [], superseded: null };
  }

  // Near-duplicates and conflicts in the same scope.
  const scope = (await store.scopeFacts(env.ctx, companyId, clientRef, 300)).filter((f) => f.id !== supersedesId);
  const close = scope
    .map((f) => ({ f, o: overlap(f.text, factText) }))
    .filter((x) => x.o >= 0.5)
    .sort((a, b) => b.o - a.o)
    .slice(0, 5);
  const similar: AddResult["similar"] = [];
  const config = close.length ? await memoryJevConfig(env.ctx, companyId) : null;
  if (config && close.length) {
    const facts: Record<string, string> = {};
    const questions: Record<string, { type: "noul"; instructions: string; criteria: { true: string; false: string } }> = {};
    close.forEach((x, i) => {
      facts[`e${i + 1}`] = x.f.text;
      questions[`same_e${i + 1}`] = {
        type: "noul",
        instructions: `Does \`new_fact\` state the same thing as \`existing.e${i + 1}\`, so keeping both would be a duplicate?`,
        criteria: { true: "Same meaning, maybe different words.", false: "Adds or changes information, or is about something else." },
      };
      questions[`conflict_e${i + 1}`] = {
        type: "noul",
        instructions: `Do \`new_fact\` and \`existing.e${i + 1}\` contradict each other, so both cannot be true now?`,
        criteria: { true: "They cannot both be true (e.g. a changed preference, a new rule replacing an old one).", false: "Both can be true at the same time." },
      };
    });
    const res = await jevOnce(config, { new_fact: factText, existing: facts }, questions, env.fetchImpl);
    if (res) {
      for (const [i, x] of close.entries()) {
        const same = res.answers[`same_e${i + 1}`];
        const conflict = res.answers[`conflict_e${i + 1}`];
        if (same?.type === "noul" && same.noul >= 0.85) {
          if (bumpOnDuplicate) await store.bumpFeedback(env.ctx, companyId, [x.f.id], "helpful");
          return { status: "duplicate", fact: x.f, message: `Already known as [${x.f.id}] (same meaning): "${x.f.text}". If the new wording is better, use memory-update on [${x.f.id}].`, similar: [], superseded: null };
        }
        if (conflict?.type === "noul" && conflict.noul >= 0.7) similar.push({ id: x.f.id, text: x.f.text, relation: "conflict" });
        else if (x.o >= 0.7) similar.push({ id: x.f.id, text: x.f.text, relation: "similar" });
      }
    }
  } else {
    for (const x of close) if (x.o >= 0.7) similar.push({ id: x.f.id, text: x.f.text, relation: "similar" });
  }

  const id = shortId("m");
  const inserted = await store.insertFact(env.ctx, {
    id,
    companyId,
    clientRef,
    clientName,
    area,
    kind,
    text: factText,
    textHash,
    pinned,
    supersedes: old?.id ?? null,
    sourceIssueId: issue?.id ?? null,
    sourceIdentifier: issue?.identifier ?? null,
    sourceRunId: actor.runId,
    createdByAgentId: actor.agentId,
    createdByUserId: actor.userId,
    expiresAt,
    sourceCommentId: options.sourceCommentId ?? null,
    origin,
  });
  if (!inserted) {
    const again = await store.findActiveByHash(env.ctx, companyId, textHash);
    if (again) return { status: "duplicate", fact: again, message: `Already known as [${again.id}].`, similar: [], superseded: null };
    throw new MemoryError("The fact could not be saved. Try again.");
  }
  let superseded: string | null = null;
  if (old && (await store.supersedeFact(env.ctx, companyId, old.id, id))) superseded = old.id;
  const fact = (await store.getFact(env.ctx, companyId, id))!;
  const scopeLabel = clientName ? `${clientName} (${client.how === "named" || client.how === "jev" ? "taken from the issue" : "client"})` : "the whole company";
  const parts = [`Saved [${id}] for ${scopeLabel}, area ${area}${pinned ? ", pinned" : ""}.`];
  if (superseded) parts.push(`It replaces [${superseded}].`);
  if (!clientRef && issue && client.how === "none") parts.push("No client was found on the issue, so it applies company-wide. If it is about one client, update it with that client.");
  const conflicts = similar.filter((s) => s.relation === "conflict");
  if (conflicts.length) parts.push(`It may contradict ${conflicts.map((c) => `[${c.id}] "${c.text}"`).join("; ")}. If the new fact replaces it, call memory-update with {id: "${conflicts[0]!.id}", status: "superseded", supersededBy: "${id}"}.`);
  else if (similar.length) parts.push(`Similar: ${similar.map((c) => `[${c.id}]`).join(", ")}.`);
  parts.push(...notes);
  return { status: "added", fact, message: parts.join(" "), similar, superseded };
}

export interface UpdateInput {
  id?: unknown;
  text?: unknown;
  pinned?: unknown;
  status?: unknown;
  supersededBy?: unknown;
  expiresAt?: unknown;
  area?: unknown;
  kind?: unknown;
}

export async function updateFact(env: Env, companyId: string, input: UpdateInput): Promise<{ fact: MemoryFact; message: string }> {
  const id = text(input.id, 40);
  if (!id) throw new MemoryError("id is required.");
  const fact = await store.getFact(env.ctx, companyId, id);
  if (!fact) throw new MemoryError(`No fact ${id} in this company.`);
  const patch: store.FactPatch = {};
  if (input.text !== undefined) {
    patch.text = checkText(input.text);
    patch.textHash = factHash(fact.clientRef, patch.text);
    const clash = await store.findActiveByHash(env.ctx, companyId, patch.textHash);
    if (clash && clash.id !== id) throw new MemoryError(`That text is already fact [${clash.id}]. Archive this one instead.`);
  }
  const kind = input.kind !== undefined ? (isMemoryKind(input.kind) ? input.kind : null) : fact.kind;
  if (kind === null) throw new MemoryError("kind must be fact, preference, rule, lesson or warning.");
  if (input.kind !== undefined) patch.kind = kind;
  if (input.area !== undefined) {
    if (!isMemoryArea(input.area)) throw new MemoryError("area is not valid.");
    patch.area = input.area;
  }
  if (input.pinned === undefined && input.kind !== undefined && fact.pinned && kind !== "rule" && kind !== "warning") {
    // Only rules and warnings stay pinned.
    patch.pinned = false;
  }
  if (input.pinned !== undefined) {
    const pinned = input.pinned === true;
    if (pinned && kind !== "rule" && kind !== "warning") throw new MemoryError("Only rules and warnings can be pinned. Set kind to rule or warning first.");
    if (pinned && !fact.pinned && (await store.countPinned(env.ctx, companyId, fact.clientRef, patch.area ?? fact.area)) >= MEMORY_LIMITS.pinnedMaxPerScope) {
      throw new MemoryError(`This client and area already has ${MEMORY_LIMITS.pinnedMaxPerScope} pinned rules. Unpin one first.`);
    }
    patch.pinned = pinned;
  }
  if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt === null || input.expiresAt === "" ? null : checkExpiry(input.expiresAt, env.now());
  if (input.status !== undefined) {
    const status = input.status;
    if (status === "superseded") {
      const by = text(input.supersededBy, 40);
      const newer = by ? await store.getFact(env.ctx, companyId, by) : null;
      if (!newer || newer.status !== "active" || newer.id === id) throw new MemoryError("supersededBy must be the id of the active fact that replaces this one.");
      patch.status = "superseded";
      patch.supersededBy = newer.id;
    } else if (status === "archived") {
      patch.status = "archived";
      patch.pinned = false;
    } else if (status === "active") {
      const hash = patch.textHash ?? factHash(fact.clientRef, fact.text);
      const clash = await store.findActiveByHash(env.ctx, companyId, hash);
      if (clash && clash.id !== id) throw new MemoryError(`An active fact with the same text exists: [${clash.id}].`);
      patch.status = "active";
      patch.supersededBy = null;
    } else throw new MemoryError("status must be active, archived or superseded.");
  }
  if (Object.keys(patch).length === 0) throw new MemoryError("Nothing to change: pass text, kind, area, pinned, expiresAt or status.");
  await store.updateFact(env.ctx, companyId, id, patch);
  const updated = (await store.getFact(env.ctx, companyId, id))!;
  return { fact: updated, message: `Updated [${id}]${patch.status ? ` (${patch.status})` : ""}.` };
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

function idList(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string" && /^[a-z0-9]{2,40}$/i.test(v.trim())).map((v) => v.trim()))].slice(0, max);
}

export async function feedback(
  env: Env,
  companyId: string,
  input: { briefId?: unknown; issueId?: unknown; missing?: unknown; noise?: unknown; missingText?: unknown; wrong?: unknown },
  actor: Actor,
): Promise<{ recorded: number; message: string }> {
  const briefId = text(input.briefId, 40);
  const issueRef = text(input.issueId, 100);
  let brief = briefId ? await store.getBrief(env.ctx, companyId, briefId) : null;
  if (!brief && issueRef) {
    const issue = await loadIssue(env, companyId, issueRef);
    if (issue) brief = await store.latestBriefForIssue(env.ctx, companyId, issue.id, actor.agentId);
  }
  if (!brief) throw new MemoryError("Pass the briefId from your brief (or the issueId you recalled for).");
  const missing = idList(input.missing);
  const noise = idList(input.noise).filter((id) => brief!.factIds.includes(id));
  const wrong = idList(input.wrong);
  const missingText = text(input.missingText, MEMORY_LIMITS.factMaxChars * 2);
  if (!missing.length && !noise.length && !wrong.length && !missingText) throw new MemoryError("Say what was missing (missing fact ids or missingText), useless (noise ids), or wrong (wrong ids).");
  const known = await store.getFacts(env.ctx, companyId, [...missing, ...wrong]);
  const knownIds = new Set(known.map((f) => f.id));
  let recorded = 0;
  const row = (kind: "missing" | "noise" | "wrong", factId: string | null, t: string | null, inBaseline: boolean | null) =>
    store.insertFeedback(env.ctx, { id: shortId("f"), companyId, briefId: brief!.id, issueId: brief!.issueId, agentId: actor.agentId, userId: actor.userId, kind, factId, text: t, inBaseline });
  for (const id of missing.filter((m) => knownIds.has(m))) {
    await row("missing", id, null, brief.baselineIds.includes(id));
    recorded += 1;
  }
  if (missingText) {
    await row("missing", null, missingText, null);
    recorded += 1;
  }
  for (const id of noise) {
    await row("noise", id, null, brief.baselineIds.includes(id));
    recorded += 1;
  }
  for (const id of wrong.filter((w) => knownIds.has(w))) {
    await row("wrong", id, null, null);
    recorded += 1;
  }
  await store.bumpFeedback(env.ctx, companyId, missing.filter((m) => knownIds.has(m)), "helpful");
  await store.bumpFeedback(env.ctx, companyId, noise, "noise");
  const parts = [`Thanks: ${recorded} note${recorded === 1 ? "" : "s"} on brief ${brief.id}.`];
  if (missingText) parts.push("If that missing knowledge is true and lasting, save it with memory-add.");
  if (wrong.length) parts.push("Fix wrong facts with memory-update (new text, or status archived).");
  return { recorded, message: parts.join(" ") };
}

// ---------------------------------------------------------------------------
// **Learned:** lines in comments, saved automatically
// ---------------------------------------------------------------------------

export interface HarvestResult {
  saved: Array<{ id: string; text: string }>;
  duplicates: number;
  skipped: Array<{ text: string; reason: string }>;
}

const EMPTY_HARVEST: HarvestResult = { saved: [], duplicates: 0, skipped: [] };

/**
 * Reads one new comment and saves each fact under its **Learned:** label
 * (client and area from the issue; same checks as memory-add: length,
 * secrets, exact and meaning duplicates). Comments without the label cost
 * one comment read and nothing else. No reply is posted, so nothing wakes.
 */
export async function harvestComment(
  env: Env,
  companyId: string,
  input: { issueId: string; commentId: string; authorAgentId: string | null; authorUserId: string | null; runId?: string | null },
): Promise<HarvestResult> {
  const comments = await env.ctx.issues.listComments(input.issueId, companyId);
  const comment = comments.find((c) => c.id === input.commentId);
  if (!comment || comment.deletedAt || typeof comment.body !== "string") return EMPTY_HARVEST;
  const items = parseLearned(comment.body);
  if (items.length === 0) return EMPTY_HARVEST;
  const actor: Actor = {
    agentId: input.authorAgentId ?? comment.authorAgentId ?? null,
    runId: input.runId ?? comment.createdByRunId ?? null,
    userId: input.authorAgentId ? null : input.authorUserId ?? comment.authorUserId ?? null,
  };
  // One client lookup per comment (not per line): named in the issue, else Jev's pick, else company-wide.
  const issue = await loadIssue(env, companyId, input.issueId);
  if (!issue) return EMPTY_HARVEST;
  const client = await resolveClients(env, companyId, {}, { title: issue.title, description: issue.description, context: issue.context }, { allowJev: true });
  const scope = client.refs[0] ? { client: client.refs[0], clientName: client.names[0] } : { client: "own" };
  const result: HarvestResult = { saved: [], duplicates: 0, skipped: [] };
  for (const item of items) {
    try {
      const added = await addFact(env, companyId, { text: item.text, kind: item.kind ?? "lesson", issueId: input.issueId, ...scope }, actor, { origin: "harvest", sourceCommentId: input.commentId });
      if (added.status === "added") result.saved.push({ id: added.fact.id, text: added.fact.text });
      else result.duplicates += 1;
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      result.skipped.push({ text: item.text.slice(0, 80), reason: error.message });
    }
  }
  if (result.saved.length || result.skipped.length) {
    env.ctx.logger.info("Memory: saved Learned lines from a comment", {
      companyId,
      issueId: input.issueId,
      commentId: input.commentId,
      saved: result.saved.length,
      duplicates: result.duplicates,
      skipped: result.skipped,
    });
  }
  return result;
}

/** Host event `issue.comment.created` (activity `issue.comment_added`) → harvest. Agents' and people's comments only. */
export async function onCommentCreated(env: Env, event: Pick<PluginEvent, "companyId" | "entityId" | "entityType" | "actorType" | "actorId" | "payload">): Promise<HarvestResult> {
  const companyId = event.companyId;
  const issueId = event.entityType === "issue" ? event.entityId ?? null : null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const commentId = typeof payload.commentId === "string" ? payload.commentId : null;
  if (!companyId || !issueId || !commentId) return EMPTY_HARVEST;
  if (event.actorType !== "agent" && event.actorType !== "user") return EMPTY_HARVEST;
  const agentId = event.actorType === "agent" ? (typeof payload.agentId === "string" && payload.agentId ? payload.agentId : event.actorId ?? null) : null;
  return harvestComment(env, companyId, {
    issueId,
    commentId,
    authorAgentId: agentId,
    authorUserId: event.actorType === "user" ? event.actorId ?? null : null,
    runId: typeof payload.runId === "string" ? payload.runId : null,
  });
}

// ---------------------------------------------------------------------------
// Review (Operator, weekly) and upkeep (daily job)
// ---------------------------------------------------------------------------

export async function review(env: Env, companyId: string) {
  const [stats, facts, coverage] = await Promise.all([
    store.memoryStats(env.ctx, companyId),
    store.activeFacts(env.ctx, companyId, 5000),
    store.recallCoverage(env.ctx, companyId).catch(() => [] as Array<{ agentId: string; runs: number; withBrief: number }>),
  ]);
  const now = env.now().getTime();
  const groups = new Map<string, MemoryFact[]>();
  for (const f of facts) {
    const key = `${f.clientRef ?? "*"}|${f.area}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const duplicates: Array<{ a: string; b: string; aText: string; bText: string; overlap: number }> = [];
  for (const list of groups.values()) {
    const slice = list.slice(0, 150);
    for (let i = 0; i < slice.length && duplicates.length < 50; i += 1) {
      for (let j = i + 1; j < slice.length; j += 1) {
        const o = overlap(slice[i]!.text, slice[j]!.text);
        if (o >= 0.7) duplicates.push({ a: slice[i]!.id, b: slice[j]!.id, aText: slice[i]!.text, bText: slice[j]!.text, overlap: Math.round(o * 100) / 100 });
      }
    }
  }
  duplicates.sort((x, y) => y.overlap - x.overlap);
  const noisy = facts
    .filter((f) => f.noiseCount >= 2 && f.noiseCount > f.helpfulCount)
    .sort((a, b) => b.noiseCount - a.noiseCount)
    .slice(0, 15)
    .map((f) => ({ id: f.id, text: f.text, noise: f.noiseCount, helpful: f.helpfulCount }));
  const staleDays = 120;
  const stale = facts.filter((f) => !f.pinned && (f.lastUsedAt ? now - Date.parse(f.lastUsedAt) : now - Date.parse(f.createdAt)) > staleDays * 86_400_000);
  const overCap = [...groups.entries()].filter(([, list]) => list.length > SELECTION.scopeActiveCap).map(([key, list]) => ({ scope: key, active: list.length }));
  const m = stats.feedback30d;
  const verdict =
    m.missing === 0
      ? "No missing-fact reports in 30 days."
      : `${m.missing} missing-fact reports in 30 days: the keyword baseline would have caught ${m.missingInBaseline}, missed ${m.missingNotInBaseline}.`;
  const skipping = coverage.filter((c) => c.runs >= 3 && c.withBrief / c.runs < 0.5);
  return {
    stats,
    coverage,
    agentsSkippingMemory: skipping.map((c) => ({ agentId: c.agentId, runs: c.runs, withBrief: c.withBrief })),
    duplicates: duplicates.slice(0, 10),
    noisy,
    staleCount: stale.length,
    staleExamples: stale.slice(0, 5).map((f) => ({ id: f.id, text: f.text, lastUsedAt: f.lastUsedAt })),
    overCap,
    verdict,
  };
}

/** Value used to decide what to archive when a scope is over its cap (higher = keep). */
export function factValue(f: MemoryFact, now: number): number {
  const ageDays = (now - Date.parse(f.lastUsedAt ?? f.updatedAt ?? f.createdAt)) / 86_400_000;
  return 2 * f.helpfulCount + 0.2 * f.useCount - f.noiseCount + Math.max(0, 1 - ageDays / 365) + (f.kind === "rule" || f.kind === "warning" ? 0.5 : 0);
}

export async function upkeep(env: Env): Promise<{ companies: number; expired: number; archived: number }> {
  let expired = 0;
  let archived = 0;
  const companies = await store.companiesWithFacts(env.ctx);
  for (const companyId of companies) {
    try {
      expired += await store.expireFacts(env.ctx, companyId);
      const facts = await store.activeFacts(env.ctx, companyId);
      const now = env.now().getTime();
      const groups = new Map<string, MemoryFact[]>();
      for (const f of facts) groups.set(`${f.clientRef ?? "*"}|${f.area}`, [...(groups.get(`${f.clientRef ?? "*"}|${f.area}`) ?? []), f]);
      const drop: string[] = [];
      for (const list of groups.values()) {
        if (list.length <= SELECTION.scopeActiveCap) continue;
        const keepable = list.filter((f) => !f.pinned).sort((a, b) => factValue(a, now) - factValue(b, now));
        drop.push(...keepable.slice(0, list.length - SELECTION.scopeActiveCap).map((f) => f.id));
      }
      archived += await store.archiveFacts(env.ctx, companyId, drop);
    } catch (error) {
      env.ctx.logger.info("Memory upkeep failed for a company", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { companies: companies.length, expired, archived };
}
