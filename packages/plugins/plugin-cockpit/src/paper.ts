/**
 * The Daily Paper (worker side): where editions and the owner's section list
 * are kept, the agent tools that read the assignment and publish an edition,
 * the page actions of Cockpit → Paper, and the 15-minute tick that asks the
 * Operator for the evening edition and compiles an edition itself when none
 * arrived.
 *
 * Storage is plugin state per company (namespace `cockpit`): the settings, one
 * document per edition, one list per month for the archive, and a small meta
 * record (the edition counter, the months that have editions, what was last
 * asked for and published).
 */
import type { PluginContext, PluginPerformActionContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue, toolFail, toolOk } from "@partnersinbiz/pib-plugin-kit";
import { companyBrief, postDailyBrief } from "./brief.js";
import { assignableUser, ORIGIN, PLUGIN_KEY } from "./constants.js";
import { getRoles, listRoles } from "./db.js";
import { CockpitError, message, type Env } from "./env.js";
import { linkFor } from "./health.js";
import {
  briefToEdition,
  checkPublish,
  compileEdition,
  countWords,
  defaultSettings,
  EDITION_LABEL,
  editionMarkdown,
  fallbackDue,
  indexEntry,
  isDate,
  isEdition,
  longDate,
  monthOf,
  normalizeSections,
  normalizeSettings,
  PAPER_EDITIONS,
  PAPER_LIMITS,
  paperName,
  parseEdition,
  parseIndex,
  sastDate,
  sastMinutes,
  SECTION_PRESETS,
  shortDate,
  taskDue,
  upsertIndex,
  WRITING_RULES,
  type PaperEditionDoc,
  type PaperEditionKey,
  type PaperIndexEntry,
  type PaperSectionSpec,
  type PaperSettings,
  type PublishInput,
} from "./paper-model.js";
import { PAPER_TOOL_NAMES } from "./paper-tool-declarations.js";
import { notifyOwner } from "./push/notify.js";
import { operatorAgentId } from "./roles.js";
import { TOOL_NAMES } from "./tools.js";

const key = (companyId: string, stateKey: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "cockpit", stateKey });
const SETTINGS = (companyId: string) => key(companyId, "paper:settings");
const META = (companyId: string) => key(companyId, "paper:meta");
const MONTH = (companyId: string, month: string) => key(companyId, `paper:index:${month}`);
const EDITION = (companyId: string, date: string, edition: PaperEditionKey) => key(companyId, `paper:edition:${date}:${edition}`);

/** Origin id of an edition's writing task: one per company, day and edition. */
export const paperTaskOriginId = (companyId: string, date: string, edition: PaperEditionKey) => `cockpit:paper:${companyId}:${date}:${edition}`;

export const paperPath = (date?: string, edition?: PaperEditionKey) => `/cockpit?tab=paper${date ? `&date=${date}` : ""}${edition ? `&edition=${edition}` : ""}`;

type PerEdition<T> = Record<PaperEditionKey, T>;

interface PaperMeta {
  /** Editions published so far (the next one's number is count + 1). */
  count: number;
  /** Months with at least one edition, newest first (`YYYY-MM`). */
  months: string[];
  /** The day each edition was last published for. */
  published: PerEdition<string | null>;
  /** The day a writing task was last opened for, and that task. */
  taskDate: PerEdition<string | null>;
  taskIssueId: PerEdition<string | null>;
  /** When the tick first saw this company: an edition whose time had passed by then is not compiled after the fact. */
  firstSeenAt: string | null;
}

function parseMeta(value: unknown): PaperMeta {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const per = (raw: unknown): PerEdition<string | null> => {
    const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return { morning: typeof r.morning === "string" ? r.morning : null, evening: typeof r.evening === "string" ? r.evening : null };
  };
  return {
    count: typeof row.count === "number" && row.count >= 0 ? Math.floor(row.count) : 0,
    months: Array.isArray(row.months) ? row.months.filter((m): m is string => typeof m === "string" && /^\d{4}-\d{2}$/.test(m)).sort().reverse() : [],
    published: per(row.published),
    taskDate: per(row.taskDate),
    taskIssueId: per(row.taskIssueId),
    firstSeenAt: typeof row.firstSeenAt === "string" ? row.firstSeenAt : null,
  };
}

async function readMeta(env: Env, companyId: string): Promise<PaperMeta> {
  return parseMeta(await env.ctx.state.get(META(companyId)));
}

export async function readPaperSettings(env: Env, companyId: string): Promise<PaperSettings> {
  return normalizeSettings(await env.ctx.state.get(SETTINGS(companyId)));
}

export async function savePaperSettings(env: Env, companyId: string, value: unknown, actor: string): Promise<PaperSettings> {
  const next = { ...normalizeSettings(value), updatedAt: env.now().toISOString(), updatedBy: actor };
  for (const edition of PAPER_EDITIONS) {
    if (next.editions[edition].sections.length === 0) throw new CockpitError(`The ${edition} edition needs at least one section. Turn the edition off instead of emptying it.`);
  }
  await env.ctx.state.set(SETTINGS(companyId), next);
  return next;
}

export async function getEdition(env: Env, companyId: string, date: string, edition: PaperEditionKey): Promise<PaperEditionDoc | null> {
  return parseEdition(await env.ctx.state.get(EDITION(companyId, date, edition)));
}

export async function listMonth(env: Env, companyId: string, month: string): Promise<PaperIndexEntry[]> {
  return parseIndex(await env.ctx.state.get(MONTH(companyId, month)));
}

/** The newest editions across months, newest first. */
export async function latestEntries(env: Env, companyId: string, limit: number): Promise<{ entries: PaperIndexEntry[]; months: string[] }> {
  const meta = await readMeta(env, companyId);
  const entries: PaperIndexEntry[] = [];
  for (const month of meta.months) {
    if (entries.length >= limit) break;
    entries.push(...(await listMonth(env, companyId, month)));
  }
  return { entries: entries.slice(0, limit), months: meta.months };
}

async function companyInfo(ctx: PluginContext, companyId: string): Promise<{ name: string | null; prefix: string | null }> {
  const company = await ctx.companies.get(companyId).catch(() => null);
  return { name: company?.name ?? null, prefix: company?.issuePrefix ?? null };
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export interface PublishResult {
  doc: PaperEditionDoc;
  /** The Cockpit → Paper address of this edition (with the company prefix). */
  href: string;
  /** The Daily brief issue the copy went on; null when that failed. */
  briefIssueId: string | null;
  replaced: boolean;
  closedTaskId: string | null;
  push: string | null;
}

/** `copy: false` leaves the Daily brief issue alone (the edition was read from a brief that is already posted there). */
export async function publishEdition(env: Env, companyId: string, input: PublishInput, by: { source: "agent" | "auto"; agentId: string | null; copy?: boolean }): Promise<PublishResult> {
  const { ctx } = env;
  const now = env.now();
  const [settings, meta, company, previous] = await Promise.all([readPaperSettings(env, companyId), readMeta(env, companyId), companyInfo(ctx, companyId), getEdition(env, companyId, input.date, input.edition)]);
  // A compiled edition never replaces a written one.
  if (previous && previous.source === "agent" && by.source === "auto") throw new CockpitError("A written edition is already published for that day.");
  const agent = by.agentId ? await ctx.agents.get(by.agentId, companyId).catch(() => null) : null;
  const doc: PaperEditionDoc = {
    date: input.date,
    edition: input.edition,
    number: previous?.number || meta.count + 1,
    name: paperName(settings, company.name),
    headline: input.headline,
    standfirst: input.standfirst,
    figures: input.figures,
    sections: input.sections,
    source: by.source,
    author: agent ? String(agent.name) : null,
    authorAgentId: by.agentId,
    publishedAt: now.toISOString(),
    revision: (previous?.revision ?? 0) + 1,
    words: 0,
  };
  doc.words = countWords(doc);
  await ctx.state.set(EDITION(companyId, doc.date, doc.edition), doc);
  const month = monthOf(doc.date);
  await ctx.state.set(MONTH(companyId, month), upsertIndex(await listMonth(env, companyId, month), indexEntry(doc)));
  const latest = meta.published[doc.edition];
  const nextMeta: PaperMeta = {
    ...meta,
    count: previous?.number ? meta.count : meta.count + 1,
    months: meta.months.includes(month) ? meta.months : [...meta.months, month].sort().reverse(),
    published: { ...meta.published, [doc.edition]: !latest || doc.date > latest ? doc.date : latest },
  };

  // The writing task for that day and edition is done once the edition is out.
  let closedTaskId: string | null = null;
  try {
    const open = (await ctx.issues.list({ companyId, originKind: ORIGIN.paper as `plugin:${string}`, originId: paperTaskOriginId(companyId, doc.date, doc.edition), limit: 5 })) as Array<{ id: string; status?: string }>;
    for (const task of open) {
      if (["done", "cancelled"].includes(String(task.status))) continue;
      await ctx.issues.update(task.id, { status: "done" }, companyId);
      closedTaskId = task.id;
    }
  } catch (error) {
    ctx.logger.info("Paper: the writing task was not closed", { companyId, error: message(error) });
  }
  await ctx.state.set(META(companyId), nextMeta);

  const href = linkFor(paperPath(doc.date, doc.edition), company.prefix);
  // A copy on the Daily brief issue: the thread the owner replies on, and what reaches their inbox.
  let briefIssueId: string | null = null;
  try {
    if (by.copy !== false) briefIssueId = (await postDailyBrief(env, companyId, editionMarkdown(doc, href), by.agentId)).issueId;
  } catch (error) {
    ctx.logger.info("Paper: the copy on the Daily brief issue was not posted", { companyId, error: message(error) });
  }
  // One push per edition (a re-publish the same day is dropped as a duplicate by the push policy).
  let push: string | null = null;
  try {
    const owner = assignableUser((await getRoles(ctx, companyId))?.ownerUserId ?? null);
    if (owner) {
      push = (await notifyOwner(ctx, { companyId, class: "paper", title: `${EDITION_LABEL[doc.edition]}: ${doc.headline}`.slice(0, 120), body: doc.standfirst.slice(0, 240), issueRef: `paper:${doc.date}:${doc.edition}`, ownerUserId: owner, url: href }, { now: () => now })).outcome;
    }
  } catch (error) {
    ctx.logger.info("Paper: the push was not sent", { companyId, error: message(error) });
  }
  return { doc, href, briefIssueId, replaced: Boolean(previous), closedTaskId, push };
}

// ---------------------------------------------------------------------------
// The writing task
// ---------------------------------------------------------------------------

const tool = (name: string) => `${PLUGIN_KEY}:${name}`;

export function taskDescription(input: { name: string; edition: PaperEditionKey; date: string }): string {
  const hours = input.edition === "evening" ? 12 : 24;
  return [
    `Write the ${EDITION_LABEL[input.edition].toLowerCase()} of ${input.name} for ${longDate(input.date)}. The owner reads it on Cockpit → Paper.`,
    "",
    `1. Call ${tool(PAPER_TOOL_NAMES.assignment)} with edition "${input.edition}". It gives the sections the owner asked for, each with its instruction, the writing rules, and the last editions (say what changed; do not repeat them).`,
    `2. Call ${tool(TOOL_NAMES.brief)} (windowHours ${hours}) and any other tool a section needs. For a section with source "web", search the web.`,
    `3. Publish with ${tool(PAPER_TOOL_NAMES.publish)}. It puts the edition on Cockpit → Paper, posts a copy on this week's Daily brief issue and closes this task.`,
    "",
    "Only write and publish the paper from this task. Never send, approve or change anything else.",
  ].join("\n");
}

export type RequestResult = { requested: true; issueId: string; created: boolean } | { requested: false; reason: "no-operator" | "operator-paused" | "off" };

/** Statuses in which an agent picks up a task it is given. */
const WORKING = new Set(["active", "idle", "running"]);

/** The Operator when it can write today: linked and not paused, in error or waiting for approval. */
async function writer(env: Env, companyId: string): Promise<{ id: string | null; usable: boolean }> {
  const id = await operatorAgentId(env, companyId).catch(() => null);
  if (!id) return { id: null, usable: false };
  const agent = await env.ctx.agents.get(id, companyId).catch(() => null);
  return { id, usable: Boolean(agent && WORKING.has(String(agent.status))) };
}

/** Opens (or wakes) the Operator's task to write an edition for today. One task per day and edition. */
export async function requestEdition(env: Env, companyId: string, edition: PaperEditionKey, options: { force?: boolean; by?: string } = {}): Promise<RequestResult> {
  const { ctx } = env;
  const settings = await readPaperSettings(env, companyId);
  if (!settings.editions[edition].enabled && !options.force) return { requested: false, reason: "off" };
  const who = await writer(env, companyId);
  if (!who.id) return { requested: false, reason: "no-operator" };
  // A task for a paused Operator would only sit there: the compiled edition covers the day.
  if (!who.usable) return { requested: false, reason: "operator-paused" };
  const operator = who.id;
  const date = sastDate(env.now());
  const originId = paperTaskOriginId(companyId, date, edition);
  const meta = await readMeta(env, companyId);
  const mark = async (issueId: string) => ctx.state.set(META(companyId), { ...meta, taskDate: { ...meta.taskDate, [edition]: date }, taskIssueId: { ...meta.taskIssueId, [edition]: issueId } });
  const found = (await ctx.issues.list({ companyId, originKind: ORIGIN.paper as `plugin:${string}`, originId, limit: 5 }).catch(() => [])) as Array<{ id: string; status?: string }>;
  const open = found.find((i) => !["done", "cancelled"].includes(String(i.status)));
  if (open) {
    await mark(open.id);
    if (options.force) await ctx.issues.requestWakeup(open.id, companyId, { reason: `${options.by ?? "The owner"} asked for the ${edition} edition now.`, idempotencyKey: `paper:${open.id}:${env.now().toISOString()}` }).catch(() => undefined);
    return { requested: true, issueId: open.id, created: false };
  }
  // A closed task for today means the edition was already written: only a person asking again opens another.
  if (found.length > 0 && !options.force) {
    await mark(found[0]!.id);
    return { requested: true, issueId: found[0]!.id, created: false };
  }
  // An edition nobody wrote on an earlier day is not owed any more: its task goes, so they do not pile up.
  try {
    const old = (await ctx.issues.list({ companyId, originKind: ORIGIN.paper as `plugin:${string}`, limit: 50 })) as Array<{ id: string; status?: string; originId?: string | null }>;
    for (const task of old) {
      if (["done", "cancelled"].includes(String(task.status)) || task.originId === originId || !String(task.originId ?? "").endsWith(`:${edition}`)) continue;
      await ctx.issues.update(task.id, { status: "cancelled" }, companyId);
    }
  } catch (error) {
    ctx.logger.info("Paper: old writing tasks were not cancelled", { companyId, error: message(error) });
  }
  const company = await companyInfo(ctx, companyId);
  const made = await createWorkIssue(ctx, {
    companyId,
    title: `${EDITION_LABEL[edition].replace(" edition", "")} paper, ${shortDate(date)}`,
    description: taskDescription({ name: paperName(settings, company.name), edition, date }),
    assigneeAgentId: operator,
    priority: "high",
    originKind: ORIGIN.paper as `plugin:${string}`,
    originId,
    wake: true,
    wakeReason: `The ${edition} edition of the paper is due.`,
  });
  await mark(made.id);
  return { requested: true, issueId: made.id, created: true };
}

/** An edition from the numbers alone, published as `auto`. */
export async function publishCompiled(env: Env, companyId: string, edition: PaperEditionKey, why: string): Promise<PublishResult> {
  const settings = await readPaperSettings(env, companyId);
  const date = sastDate(env.now());
  const brief = await companyBrief(env, companyId, { windowHours: edition === "evening" ? 12 : 24 });
  const compiled = compileEdition({ brief, edition, date, spec: settings.editions[edition].sections, why });
  return publishEdition(env, companyId, { edition, date, ...compiled }, { source: "auto", agentId: null });
}

/** Rides on the 15-minute sweep: the evening edition's task at its time, and a compiled edition when none arrived two hours after its time. */
export async function paperTick(env: Env): Promise<{ requested: number; compiled: number; failed: number }> {
  const out = { requested: 0, compiled: 0, failed: 0 };
  const now = env.now();
  const today = sastDate(now);
  for (const row of await listRoles(env.ctx)) {
    try {
      const settings = await readPaperSettings(env, row.companyId);
      if (!PAPER_EDITIONS.some((e) => settings.editions[e].enabled)) continue;
      let meta = await readMeta(env, row.companyId);
      // A company with no working Operator that never had an edition is parked: no task, no compiled paper, no noise.
      if (meta.count === 0 && !(await writer(env, row.companyId)).usable) continue;
      if (!meta.firstSeenAt) {
        meta = { ...meta, firstSeenAt: now.toISOString() };
        await env.ctx.state.set(META(row.companyId), meta);
      }
      // The morning edition is written at the end of the daily operations review (its routine wakes the Operator), so only the evening one gets a task.
      if (taskDue(settings.editions.evening, now, { taskDate: meta.taskDate.evening, publishedDate: meta.published.evening })) {
        const result = await requestEdition(env, row.companyId, "evening");
        if (result.requested && result.created) out.requested += 1;
      }
      for (const edition of PAPER_EDITIONS) {
        if (!fallbackDue(settings.editions[edition], now, { publishedDate: meta.published[edition], firstSeenAt: meta.firstSeenAt })) continue;
        // The state can lag a publish by another worker: the edition itself is the second guard.
        if (await getEdition(env, row.companyId, today, edition)) continue;
        await publishCompiled(env, row.companyId, edition, "Compiled by the Cockpit from the numbers: the written edition did not arrive.");
        out.compiled += 1;
      }
    } catch (error) {
      out.failed += 1;
      env.ctx.logger.warn("Paper: the tick failed for a company", { companyId: row.companyId, error: message(error) });
    }
  }
  return out;
}

/**
 * The Operator posted its markdown brief with `post-daily-brief` (a company whose instructions still say so):
 * the same text becomes today's morning edition, unless a written one is already there. Before noon SAST only,
 * and never for the Weekly retro. No second copy goes on the Daily brief issue.
 */
export async function editionFromBrief(env: Env, companyId: string, body: string, agentId: string | null): Promise<PublishResult | null> {
  const now = env.now();
  if (sastMinutes(now) >= 12 * 60) return null;
  if (!(await readPaperSettings(env, companyId)).editions.morning.enabled) return null;
  const date = sastDate(now);
  const existing = await getEdition(env, companyId, date, "morning");
  if (existing && existing.source === "agent") return null;
  const edition = briefToEdition(body);
  if (!edition) return null;
  return publishEdition(env, companyId, { edition: "morning", date, ...edition }, { source: "agent", agentId, copy: false });
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

function params(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function plainBody(doc: PaperEditionDoc, max: number): string {
  const text = [doc.standfirst, ...doc.sections.map((s) => `${s.title}: ${s.body}`)].join("\n");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** What the writer needs for one edition: the owner's sections, the rules, and the last editions so it says what changed. */
export async function paperAssignment(env: Env, companyId: string, edition: PaperEditionKey) {
  const [settings, company, meta] = await Promise.all([readPaperSettings(env, companyId), companyInfo(env.ctx, companyId), readMeta(env, companyId)]);
  const date = sastDate(env.now());
  const spec = settings.editions[edition];
  const { entries } = await latestEntries(env, companyId, 6);
  const previous: Array<Record<string, unknown>> = [];
  for (const entry of entries.filter((e) => !(e.date === date && e.edition === edition)).slice(0, 2)) {
    const doc = await getEdition(env, companyId, entry.date, entry.edition);
    if (doc) previous.push({ date: doc.date, edition: doc.edition, headline: doc.headline, source: doc.source, text: plainBody(doc, 3500) });
  }
  return {
    paper: paperName(settings, company.name),
    edition,
    editionLabel: EDITION_LABEL[edition],
    date,
    dateLabel: longDate(date),
    enabled: spec.enabled,
    alreadyPublished: Boolean(await getEdition(env, companyId, date, edition)),
    /** The owner's standing instructions for this edition. */
    note: spec.note || null,
    sections: spec.sections.filter((s) => s.enabled).map((s) => ({ id: s.id, title: s.title, source: s.source, instruction: s.instruction })),
    rules: WRITING_RULES,
    linkPrefix: company.prefix ? `/${company.prefix}` : "",
    previous,
    editionsSoFar: meta.count,
    publishWith: tool(PAPER_TOOL_NAMES.publish),
  };
}

type SectionChange = { edition: PaperEditionKey; settings: PaperSettings };

/** One change to an edition's section list (the `paper-settings` tool): add, update, remove, move, or the edition's note and switch. */
export function applySettingsChange(settings: PaperSettings, p: Record<string, unknown>): SectionChange {
  if (!isEdition(p.edition)) throw new CockpitError("edition must be \"morning\" or \"evening\".");
  const edition = p.edition;
  const current = settings.editions[edition];
  let sections = current.sections.map((s) => ({ ...s }));
  const action = String(p.action ?? "");
  const find = () => {
    const id = typeof p.id === "string" ? p.id : "";
    const at = sections.findIndex((s) => s.id === id);
    if (at < 0) throw new CockpitError(`No section "${id}" in the ${edition} edition. Sections: ${sections.map((s) => s.id).join(", ")}.`);
    return at;
  };
  const next = { ...current };
  if (action === "add") {
    const preset = typeof p.preset === "string" ? SECTION_PRESETS.find((s) => s.id === p.preset) : undefined;
    const title = typeof p.title === "string" && p.title.trim() ? p.title : preset?.title;
    if (!title) throw new CockpitError("add needs a title (or a preset).");
    const instruction = typeof p.instruction === "string" && p.instruction.trim() ? p.instruction : preset?.instruction ?? "";
    if (!instruction) throw new CockpitError("add needs an instruction: what the owner wants in this section, in their words.");
    if (sections.length >= PAPER_LIMITS.sections) throw new CockpitError(`An edition has at most ${PAPER_LIMITS.sections} sections. Remove one first.`);
    sections = normalizeSections([...sections, { id: typeof p.id === "string" ? p.id : preset?.id, title, instruction, source: p.source === "web" || p.source === "company" ? p.source : preset?.source ?? "company", enabled: true }]);
  } else if (action === "update") {
    const at = find();
    const s = sections[at]!;
    sections[at] = {
      ...s,
      ...(typeof p.title === "string" && p.title.trim() ? { title: p.title } : {}),
      ...(typeof p.instruction === "string" ? { instruction: p.instruction } : {}),
      ...(p.source === "web" || p.source === "company" ? { source: p.source } : {}),
      ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}),
    };
    sections = normalizeSections(sections);
  } else if (action === "remove") {
    const at = find();
    if (sections.length === 1) throw new CockpitError("An edition needs at least one section. Turn the edition off instead.");
    sections.splice(at, 1);
  } else if (action === "move") {
    const at = find();
    const to = typeof p.position === "number" ? Math.min(Math.max(Math.round(p.position), 1), sections.length) - 1 : null;
    if (to === null) throw new CockpitError("move needs position (1 is the top).");
    const [row] = sections.splice(at, 1);
    sections.splice(to, 0, row!);
  } else if (action === "set") {
    if (typeof p.note === "string") next.note = p.note.slice(0, PAPER_LIMITS.note);
    if (typeof p.enabled === "boolean") next.enabled = p.enabled;
    if (typeof p.time === "string") next.time = p.time;
    if (p.days === "every" || p.days === "weekdays") next.days = p.days;
  } else {
    throw new CockpitError("action must be get, add, update, remove, move or set.");
  }
  return { edition, settings: { ...settings, editions: { ...settings.editions, [edition]: { ...next, sections } } } };
}

export async function runPaperTool(env: Env, name: string, raw: unknown, run: ToolRunContext): Promise<ToolResult> {
  const companyId = run.companyId;
  const p = params(raw);
  try {
    if (name === PAPER_TOOL_NAMES.assignment) {
      if (p.edition != null && !isEdition(p.edition)) return toolFail("edition must be \"morning\" or \"evening\".");
      // Left out: the edition of this part of the day (before noon SAST the morning one).
      const assignment = await paperAssignment(env, companyId, isEdition(p.edition) ? p.edition : sastMinutes(env.now()) < 12 * 60 ? "morning" : "evening");
      const off = assignment.enabled ? "" : " The owner has switched this edition off: do not publish it unless a person asked for it.";
      return toolOk(`${assignment.editionLabel} of ${assignment.paper} for ${assignment.dateLabel}: ${assignment.sections.length} sections.${assignment.alreadyPublished ? " Already published today (publishing again replaces it)." : ""}${off}`, assignment);
    }
    if (name === PAPER_TOOL_NAMES.publish) {
      const settings = await readPaperSettings(env, companyId);
      const edition = isEdition(p.edition) ? p.edition : "morning";
      const checked = checkPublish(p, settings.editions[edition].sections, env.now());
      if (!checked.ok) return toolFail(checked.error);
      const result = await publishEdition(env, companyId, checked.input, { source: "agent", agentId: run.agentId ?? null });
      const missing = settings.editions[edition].sections.filter((s) => s.enabled && !result.doc.sections.some((d) => d.id === s.id)).map((s) => s.title);
      return toolOk(
        `Published the ${EDITION_LABEL[result.doc.edition].toLowerCase()} for ${result.doc.date} (No. ${result.doc.number}, ${result.doc.words} words)${result.replaced ? ", replacing the earlier one" : ""}. ${result.briefIssueId ? "A copy is on this week's Daily brief issue." : "The copy on the Daily brief issue failed: post it with post-daily-brief."}${result.closedTaskId ? " The writing task is closed." : ""}${missing.length ? ` Sections the owner asked for that are not in it: ${missing.join(", ")}.` : ""}`,
        { date: result.doc.date, edition: result.doc.edition, number: result.doc.number, words: result.doc.words, href: result.href, briefIssueId: result.briefIssueId, replaced: result.replaced, closedTaskId: result.closedTaskId, missingSections: missing },
      );
    }
    if (name === PAPER_TOOL_NAMES.settings) {
      const settings = await readPaperSettings(env, companyId);
      const view = (s: PaperSettings) => ({
        name: s.name || null,
        editions: Object.fromEntries(PAPER_EDITIONS.map((e) => [e, { enabled: s.editions[e].enabled, time: s.editions[e].time, days: s.editions[e].days, note: s.editions[e].note || null, sections: s.editions[e].sections }])),
        presets: SECTION_PRESETS.map((s) => ({ preset: s.id, title: s.title, source: s.source, instruction: s.instruction })),
      });
      if (!p.action || p.action === "get") return toolOk("The paper's editions and sections.", view(settings));
      const changed = applySettingsChange(settings, p);
      const saved = await savePaperSettings(env, companyId, changed.settings, `agent:${run.agentId ?? "unknown"}`);
      return toolOk(`Saved. The ${changed.edition} edition has ${saved.editions[changed.edition].sections.filter((s) => s.enabled).length} sections; the change shows from the next edition.`, view(saved));
    }
    return toolFail(`Unknown tool ${name}`);
  } catch (error) {
    return toolFail(message(error));
  }
}

// ---------------------------------------------------------------------------
// Page actions
// ---------------------------------------------------------------------------

export interface PaperView {
  name: string;
  settings: PaperSettings;
  presets: PaperSectionSpec[];
  /** The edition shown: the one asked for, else the newest. Null when there is none yet. */
  edition: PaperEditionDoc | null;
  /** The newest editions (for the earlier and later arrows and the first archive page). */
  recent: PaperIndexEntry[];
  /** Months that have editions, newest first. */
  months: string[];
  today: string;
  operator: { id: string; name: string } | null;
  /** Open writing tasks for today, by edition. */
  writing: Partial<Record<PaperEditionKey, string>>;
}

function requireCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new CockpitError("Company is required");
  return context.companyId;
}

function boardUser(context: PluginPerformActionContext): { companyId: string; userId: string } {
  const companyId = requireCompany(context);
  if (context.actor?.type !== "user") throw new CockpitError("Only a board user can change the paper");
  return { companyId, userId: String((context.actor as { userId?: unknown }).userId ?? "board") };
}

export async function loadPaperView(env: Env, companyId: string, p: Record<string, unknown>): Promise<PaperView> {
  const [settings, company, latest, meta] = await Promise.all([readPaperSettings(env, companyId), companyInfo(env.ctx, companyId), latestEntries(env, companyId, 40), readMeta(env, companyId)]);
  const today = sastDate(env.now());
  const wanted = isDate(p.date) ? { date: p.date, edition: isEdition(p.edition) ? p.edition : null } : null;
  let edition: PaperEditionDoc | null = null;
  if (wanted) {
    for (const e of wanted.edition ? [wanted.edition] : (["evening", "morning"] as const)) {
      edition = await getEdition(env, companyId, wanted.date, e);
      if (edition) break;
    }
  } else if (latest.entries[0]) {
    edition = await getEdition(env, companyId, latest.entries[0].date, latest.entries[0].edition);
  }
  const operatorId = await operatorAgentId(env, companyId).catch(() => null);
  const operator = operatorId ? await env.ctx.agents.get(operatorId, companyId).catch(() => null) : null;
  const writing: PaperView["writing"] = {};
  for (const e of PAPER_EDITIONS) {
    const taskId = meta.taskDate[e] === today && meta.published[e] !== today ? meta.taskIssueId[e] : null;
    if (taskId) writing[e] = taskId;
  }
  return {
    name: paperName(settings, company.name),
    settings,
    presets: SECTION_PRESETS,
    edition,
    recent: latest.entries,
    months: latest.months,
    today,
    operator: operator ? { id: String(operator.id), name: String(operator.name) } : null,
    writing,
  };
}

export function registerPaper(env: Env): void {
  const { ctx } = env;
  ctx.actions.register("paper.load", async (raw, context) => loadPaperView(env, requireCompany(context), params(raw)));
  ctx.actions.register("paper.month", async (raw, context) => {
    const month = String(params(raw).month ?? "");
    if (!/^\d{4}-\d{2}$/.test(month)) throw new CockpitError("month must be YYYY-MM");
    return { month, entries: await listMonth(env, requireCompany(context), month) };
  });
  ctx.actions.register("paper.save", async (raw, context) => {
    const { companyId, userId } = boardUser(context);
    return { settings: await savePaperSettings(env, companyId, params(raw).settings, `user:${userId}`) };
  });
  ctx.actions.register("paper.reset", async (_raw, context) => {
    const { companyId, userId } = boardUser(context);
    const current = await readPaperSettings(env, companyId);
    return { settings: await savePaperSettings(env, companyId, { ...defaultSettings(), name: current.name }, `user:${userId}`) };
  });
  // Ask the Operator for an edition now (a fresh task, or a wake on today's open one).
  ctx.actions.register("paper.write-now", async (raw, context) => {
    const { companyId } = boardUser(context);
    const edition = params(raw).edition;
    if (!isEdition(edition)) throw new CockpitError("edition must be morning or evening");
    return requestEdition(env, companyId, edition, { force: true, by: "The owner" });
  });
  // An edition from the numbers right now (no writer): for a first look, or a day the Operator is down.
  ctx.actions.register("paper.compile-now", async (raw, context) => {
    const { companyId } = boardUser(context);
    const edition = params(raw).edition;
    if (!isEdition(edition)) throw new CockpitError("edition must be morning or evening");
    const result = await publishCompiled(env, companyId, edition, "Compiled by the Cockpit from the numbers.");
    return { date: result.doc.date, edition: result.doc.edition, number: result.doc.number };
  });
}
