/**
 * The checks the Cockpit adds to its own snapshot beyond the operations watch
 * (`watch.ts`): the kit's drift, grant, approval and run-profile checks, the
 * measurement alerts, the registers and confirmations, and what waits on the
 * owner. Each runs on its own: one that cannot read its data says nothing
 * (and logs) instead of failing the snapshot. Each part is cached for ten
 * minutes per company because the snapshot is read on every page load.
 *
 * A run reads the company before its first part and after each part that ran
 * (the "probe", PAR-11071 rules 2-3). Once the plugin call that started it has
 * ended, every company-named read is refused (-32005), and a part would turn
 * that into "nothing to flag". So a refused probe stops the run: the part that
 * just ran is `lost` (not stored), the parts still due are `notRun`, and the
 * snapshot shows one row naming them (`OWN_CHECKS_INCOMPLETE_KEY`).
 *
 * A call never lets the parts outlive it (PAR-14009): for a company with saved
 * settings they run outside the call's invocation and the call waits for them
 * only so long (`runDueParts`); the rest land in the cache for the next load.
 *
 * Findings: Q9-8 / Q9-13 (role drift, run profile), RC5 (unrouted approvals,
 * blocked, grants), Q8-3 / Q8-8 / Q9-12 (measurement), Q1b-14 (client effort),
 * Q2-3 (improvements), Q10-3 (goals), and the critic's registers, custody and
 * backlog items.
 */
import { clientSendChecks } from "./outward-sends.js";
import {
  agentsWithoutPluginTools,
  backlogWaitingItems,
  dbBlockedByLookup,
  blockersUnreadableCheck,
  configSaved,
  isModuleEnabled,
  MEMORY_GRANT_EFFECT_KEY,
  MODULES,
  pluginToolsGrantCheck,
  rolesCopyHealth,
  roleDriftCheck,
  skillSyncCheck,
  toolsGrantWaitingItem,
  unpinnedRunProfileCheck,
  unboundModelKeyCheck,
  hostingFromConfig,
  readConfig,
  unroutedApprovalsCheck,
  waitingBacklog,
  type CockpitKpi,
  type HealthCheck,
  type ModuleKey,
  type QualityMetric,
  type WaitingItem,
} from "@partnersinbiz/pib-plugin-kit";
import { acceptanceChecks } from "./acceptance.js";
import { backlogCheck, unhandledAsksCheck, type BacklogItem, type UnhandledAsk } from "./backlog-model.js";
import { clientEffortHealth } from "./client-cost.js";
import { credentialHealth } from "./credentials.js";
import { getRoles } from "./db.js";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { effectWaitingItems, listOpenAsks } from "./asks.js";
import { grantAskedRecently } from "./effects.js";
import { goalViews } from "./goals.js";
import { improvementsBrief } from "./improvements.js";
import { measureReviewCoverage, readLimitFailures, readSpendWindows, spendCaps, agentNames } from "./measure.js";
import { formatUsd, limitFailureChecks, reviewCoverageCheck, spendChecks } from "./measure-model.js";
import { memoryStats } from "./memory/store.js";
import { feedbackSignal } from "./memory/signal.js";
import { NAMESPACE } from "./namespace.js";
import { proofGapCheck, unreviewedApprovalCheck } from "./quality.js";
import { currentRoles } from "./roles.js";
import { runDetached } from "./detach.js";
import { clockMs, recordString, timed, type PartRecord } from "./run-record.js";
import { currentTrigger } from "./run-trigger.js";
import { attestationChecks, attestationState, membersCheck, readAttestations } from "./security.js";

export interface ExtraChecks {
  health: HealthCheck[];
  kpis: CockpitKpi[];
  quality: QualityMetric[];
  waiting: WaitingItem[];
  /** Each part's name, state and time, in run order; absent when every part was served from the cache. */
  run?: PartRecord[];
  /** Set when a refused company read stopped the run: the part it cut off ("" when no part could start) and the error's numeric code (0 when it had none). */
  stop?: { lostPart: string; code: number };
}

const TTL_MS = 10 * 60_000;

/** What a part returned (`failed`: it threw, stored empty). */
interface StoredPart {
  at: number;
  value: Partial<ExtraChecks>;
  failed: boolean;
}

/** One company's cache: each part's last result, its losses in a row, and until when a part lost twice is left alone. */
interface CompanyChecks {
  parts: Map<string, StoredPart>;
  losses: Map<string, number>;
  heldUntil: Map<string, number>;
}

const caches = new WeakMap<object, Map<string, CompanyChecks>>();

function companyChecks(env: Env, companyId: string): CompanyChecks {
  let byCompany = caches.get(env);
  if (!byCompany) caches.set(env, (byCompany = new Map()));
  let entry = byCompany.get(companyId);
  if (!entry) byCompany.set(companyId, (entry = { parts: new Map(), losses: new Map(), heldUntil: new Map() }));
  return entry;
}

/** The row's key; PAR-11233 reads the row back by it. */
export const OWN_CHECKS_INCOMPLETE_KEY = "own_checks_incomplete";
const PARTS_LEAD = "Not finished this time: ";
const NOT_STARTED = "The checks that were due could not run: the Cockpit could no longer read this company. ";

/** The row's `detail`: the unfinished parts by name. `notStarted` when no part could start. Read back with `parseIncompleteParts` only. */
export function formatIncompleteParts(names: string[], options: { notStarted?: boolean } = {}): string {
  return `${options.notStarted ? NOT_STARTED : ""}${PARTS_LEAD}${names.length ? names.join(", ") : "none"}. Until they finish they say nothing, so a problem only they find is not shown; the next page load or the hourly check runs them again.`;
}

/** The part names in a `detail` written by `formatIncompleteParts` (none for any other text). */
export function parseIncompleteParts(detail: string | null | undefined): string[] {
  if (!detail) return [];
  const at = detail.indexOf(PARTS_LEAD);
  if (at < 0) return [];
  const rest = detail.slice(at + PARTS_LEAD.length);
  const end = rest.indexOf(".");
  const list = (end < 0 ? rest : rest.slice(0, end)).trim();
  if (!list || list === "none") return [];
  return list.split(",").map((name) => name.trim()).filter(Boolean);
}

/** The numeric `code` of a refused read (-32005 is a scope refusal), else 0. Never the text. */
function errorCode(error: unknown): number {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" && Number.isFinite(code) ? code : 0;
}

/** The modules the company has switched on, as the kit's role drift check wants them. */
async function moduleMap(env: Env, companyId: string): Promise<Partial<Record<ModuleKey, boolean>>> {
  const out: Partial<Record<ModuleKey, boolean>> = {};
  for (const key of Object.keys(MODULES) as ModuleKey[]) {
    let on = false;
    for (const plugin of MODULES[key].plugins) if (await isModuleEnabled(env.ctx, companyId, plugin)) on = true;
    out[key] = on;
  }
  return out;
}

type Part = () => Promise<Partial<ExtraChecks>>;

function merge(out: ExtraChecks, got: Partial<ExtraChecks>): void {
  out.health.push(...(got.health ?? []));
  out.kpis.push(...(got.kpis ?? []));
  out.quality.push(...(got.quality ?? []));
  out.waiting.push(...(got.waiting ?? []));
}

/**
 * How long a call (a page load, the brief, an action) waits for the parts that must run (PAR-14009). The host ends a
 * plugin call after 30 s and then refuses every read the call still makes (`unknown_invocation`); `cockpit.load` also
 * reads other things around the checks. A test may lower it.
 */
export const CALL_LIMITS = { waitMs: 12_000 };

type Start = (company: { issuePrefix?: string | null } | null) => Promise<void>;

/** One run of the due parts: what each did, what each returned, and why it stopped. Filled in as the parts finish. */
interface Progress {
  record: PartRecord[];
  values: Map<string, Partial<ExtraChecks>>;
  stop?: { lostPart: string; code: number };
  done: boolean;
  /** The call stopped waiting before the run ended (the run went on outside the call). */
  outlived: boolean;
}

const newProgress = (): Progress => ({ record: [], values: new Map(), done: false, outlived: false });

/** The run of the due parts in flight for each company, outside any call; a second load waits on it instead of starting another. */
const inFlight = new WeakMap<object, Map<string, { progress: Progress; finished: Promise<void> }>>();

function inFlightFor(env: Env): Map<string, { progress: Progress; finished: Promise<void> }> {
  let byCompany = inFlight.get(env);
  if (!byCompany) inFlight.set(env, (byCompany = new Map()));
  return byCompany;
}

/**
 * Runs the due parts in order (each may fail alone) and stores each result. Before the first part, and after each
 * part that ran, the company is read; a refusal stops the run (see the file comment). `start` reads what the parts
 * share, once, after the first probe. Past `deadline` (a `clockMs` value) no part starts: the rest are `notRun`.
 */
async function runDue(env: Env, companyId: string, now: number, store: CompanyChecks, due: Array<[string, Part]>, start: Start, progress: Progress, deadline: number | null): Promise<void> {
  const record = progress.record;
  const probe = () => env.ctx.companies.get(companyId);
  let started = false;
  for (const [name, run] of due) {
    if (progress.stop || (deadline !== null && clockMs() > deadline)) {
      record.push({ name, state: "notRun", ms: 0 });
      continue;
    }
    if (!started) {
      started = true;
      let company: { issuePrefix?: string | null } | null;
      try {
        company = await probe();
      } catch (error) {
        progress.stop = { lostPart: "", code: errorCode(error) };
        record.push({ name, state: "notRun", ms: 0 });
        continue;
      }
      await start(company);
    }
    let got: Partial<ExtraChecks> = {};
    let failure: unknown;
    try {
      got = await timed(record, name, run);
    } catch (error) {
      failure = error;
    }
    try {
      await probe();
    } catch (error) {
      // Whatever the part returned or threw, it may have read nothing: not stored, not merged.
      record[record.length - 1]!.state = "lost";
      progress.stop = { lostPart: name, code: errorCode(error) };
      const losses = (store.losses.get(name) ?? 0) + 1;
      store.losses.set(name, losses);
      if (losses >= 2) store.heldUntil.set(name, now + TTL_MS);
      continue;
    }
    store.losses.delete(name);
    store.heldUntil.delete(name);
    if (failure !== undefined) {
      env.ctx.logger.info("Cockpit check failed", { companyId, check: name, error: message(failure) });
      store.parts.set(name, { at: now, value: {}, failed: true });
      continue;
    }
    store.parts.set(name, { at: now, value: got, failed: false });
    progress.values.set(name, got);
  }
}

/**
 * Where the due parts run (PAR-14009). A job runs them in place and waits for all of them. A call must end inside
 * the host's 30 s, and every read made after that is refused (the bursts of `state.get` refusals were `client-effort`
 * reading each CRM client's project links after `cockpit.load` had timed out). So for a company with saved settings
 * a call runs them outside its invocation (`runDetached`, the scope the hourly job uses), waits `CALL_LIMITS.waitMs`
 * at most, and the parts still running finish into the cache for the next load. A company without saved settings
 * is refused that scope: its call runs them in place and starts no part after the wait.
 */
async function runDueParts(env: Env, companyId: string, now: number, store: CompanyChecks, due: Array<[string, Part]>, start: Start): Promise<Progress> {
  if (currentTrigger() === "job") {
    const progress = newProgress();
    await runDue(env, companyId, now, store, due, start, progress, null);
    return progress;
  }
  const begun = clockMs();
  if (!(await configSaved(env.ctx, companyId))) {
    const progress = newProgress();
    await runDue(env, companyId, now, store, due, start, progress, begun + CALL_LIMITS.waitMs);
    return progress;
  }
  const flights = inFlightFor(env);
  let flight = flights.get(companyId);
  if (!flight) {
    const progress = newProgress();
    const finished = runDetached(() => runDue(env, companyId, now, store, due, start, progress, null))
      .catch((error) => env.ctx.logger.info("Cockpit checks failed", { companyId, error: message(error) }))
      .finally(() => {
        progress.done = true;
        if (flights.get(companyId)?.progress === progress) flights.delete(companyId);
        if (progress.outlived) env.ctx.logger.info("Cockpit checks finished after the call", { companyId, totalMs: Math.round(clockMs() - begun), parts: recordString(progress.record) });
      });
    flight = { progress, finished };
    flights.set(companyId, flight);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, begun + CALL_LIMITS.waitMs - clockMs()));
    timer.unref?.();
  });
  try {
    await Promise.race([flight.finished, waited]);
  } finally {
    clearTimeout(timer);
  }
  if (!flight.progress.done) flight.progress.outlived = true;
  return flight.progress;
}

/**
 * Runs the due parts and merges what they return with what the cache holds, in part order. The map is read first: a
 * part stored inside ten minutes is `cached`, a held one `held`, and neither reads the host. A due part that has not
 * finished when the call stops waiting is `notRun` (it is still running; the next load reads it from the cache).
 */
async function gather(env: Env, companyId: string, now: number, parts: Array<[string, Part]>, start: Start): Promise<ExtraChecks> {
  const store = companyChecks(env, companyId);
  const out: ExtraChecks = { health: [], kpis: [], quality: [], waiting: [] };
  const due: Array<[string, Part]> = [];
  const plan: Array<{ name: string; state: "cached" | "held" | "due"; value?: Partial<ExtraChecks> }> = [];
  for (const [name, run] of parts) {
    const stored = store.parts.get(name);
    if (stored && now - stored.at < TTL_MS) plan.push({ name, state: "cached", value: stored.value });
    else if ((store.heldUntil.get(name) ?? 0) > now) plan.push({ name, state: "held" });
    else {
      plan.push({ name, state: "due" });
      due.push([name, run]);
    }
  }
  const progress = due.length ? await runDueParts(env, companyId, now, store, due, start) : newProgress();
  // A snapshot of the run so far: a run still going on outside the call keeps adding to it.
  const ran = new Map(progress.record.map((r) => [r.name, { ...r }]));
  const record: PartRecord[] = [];
  for (const step of plan) {
    if (step.state !== "due") {
      if (step.value) merge(out, step.value);
      record.push({ name: step.name, state: step.state, ms: 0 });
      continue;
    }
    const value = progress.values.get(step.name);
    const done = ran.get(step.name);
    if (value && done) merge(out, value);
    record.push(done ?? { name: step.name, state: "notRun", ms: 0 });
  }
  // Every part from the cache: not a run, no record.
  if (record.some((r) => r.state !== "cached")) out.run = record;
  if (progress.stop) out.stop = { ...progress.stop };
  return out;
}

const nonOk = (check: HealthCheck | null | undefined): HealthCheck[] => (check && check.status !== "ok" ? [check] : []);

/** Whether a Cockpit question with this effect is open (the Needs-you list then already shows it). */
async function openCockpitAsk(env: Env, companyId: string, effectKey: string): Promise<boolean> {
  const rows = await env.ctx.db.query<Record<string, unknown>>(`SELECT id FROM ${NAMESPACE}.asks WHERE company_id = $1 AND source = 'cockpit' AND status = 'open' AND effect ->> 'key' = $2 LIMIT 1`, [companyId, effectKey]);
  return rows.length > 0;
}

export async function extraChecks(env: Env, companyId: string, options: { fresh?: boolean } = {}): Promise<ExtraChecks> {
  // `fresh` recomputes every part, as if the cache had just been forgotten (results are stored as usual).
  if (options.fresh) forgetChecks(env, companyId);
  const now = env.now();
  const ctx = env.ctx;
  // Read once, after the first probe, and only when a part must run.
  let prefix: string | null = null;
  let roles: Awaited<ReturnType<typeof getRoles>> | null = null;
  const start = async (company: { issuePrefix?: string | null } | null) => {
    prefix = company?.issuePrefix ?? null;
    roles = await getRoles(ctx, companyId).catch(() => null);
  };

  const parts: Array<[string, Part]> = [
    // Skills and tool access of the staffed agents, and agents with no model or timeout pinned (Q9-8, Q9-13, Q8-7).
    ["role-drift", async () => {
      const report = await roleDriftCheck(ctx, companyId, { roles: await currentRoles(env, companyId), modules: await moduleMap(env, companyId) });
      return { health: nonOk(report.check) };
    }],
    ["run-profile", async () => {
      const agents = (await ctx.agents.list({ companyId, limit: 200 })) as unknown as Array<Record<string, unknown>>;
      return { health: nonOk(unpinnedRunProfileCheck(agents.map((a) => ({ id: String(a.id), name: String(a.name ?? "Agent"), status: a.status == null ? null : String(a.status), adapterType: a.adapterType == null ? null : String(a.adapterType), adapterConfig: (a.adapterConfig as Record<string, unknown> | null) ?? null })))) };
    }],
    // A client company's Claude agents must run on the company's own key, not PiB's subscription (PAR-5158).
    ["model-key", async () => {
      const hosting = hostingFromConfig(await readConfig(ctx, companyId));
      if (hosting.profile !== "client") return {};
      // The first 200 agents, like the run-profile check above.
      const agents = (await ctx.agents.list({ companyId, limit: 200 })) as unknown as Array<Record<string, unknown>>;
      return { health: nonOk(unboundModelKeyCheck(agents.map((a) => ({ id: String(a.id), name: String(a.name ?? "Agent"), status: a.status == null ? null : String(a.status), adapterType: a.adapterType == null ? null : String(a.adapterType), adapterConfig: (a.adapterConfig as Record<string, unknown> | null) ?? null })), hosting)) };
    }],
    // Agents that cannot call the memory tools (Q9-6, Q8-12). The owner is asked once (effects.ts); the kit's Needs-you item stands in only until that question is open.
    ["grants", async () => {
      const check = await pluginToolsGrantCheck(ctx, companyId);
      if (!check) return {};
      const waiting: WaitingItem[] = [];
      if (!(await openCockpitAsk(env, companyId, MEMORY_GRANT_EFFECT_KEY))) {
        // Not for agents the Cockpit already asked the owner about: an answered "no" is a no for the cooldown, not a reason to list the same item again at once.
        const asked = await grantAskedRecently(env, companyId);
        const { problems } = await agentsWithoutPluginTools(ctx, companyId);
        const item = toolsGrantWaitingItem(problems.filter((p) => !asked.has(p.agentId)), { prefix });
        if (item) waiting.push(item);
      }
      return { health: [check], waiting };
    }],
    ["roles-copy", async () => ({ health: nonOk(await rolesCopyHealth(ctx, companyId)) })],
    ["approvals", async () => ({ health: nonOk(await unroutedApprovalsCheck(ctx, companyId, { now: now.getTime() })) })],
    // Outward approvals a person holds that the Reviewer never saw (Q5-6), and finished code with no review and no proof (Q5-4).
    ["review-routing", async () => ({ health: nonOk(await unreviewedApprovalCheck(env, companyId)) })],
    ["proof", async () => ({ health: nonOk(await proofGapCheck(env, companyId)) })],
    // The canary journeys: failing ones, and a nightly request nobody works (Q5-1).
    ["acceptance", async () => acceptanceChecks(env, companyId)],
    // Everything that waits on the owner without being in their queue: approvals nobody was assigned and blocked issues with no way out (RC5).
    ["backlog", async () => {
      const asks = await listOpenAsks(env, companyId, 200).catch(() => []);
      const backlog = await waitingBacklog(ctx, companyId, { askIssueIds: new Set(asks.map((a) => a.issueId)), now: now.getTime(), blockedBy: dbBlockedByLookup(ctx) });
      const items: BacklogItem[] = [
        ...asks.map((a): BacklogItem => ({ id: a.issueId, kind: "ask", since: a.askedAt })),
        ...backlog.unroutedApprovals.map((a): BacklogItem => ({ id: a.id, kind: "unrouted", since: a.createdAt })),
        ...backlog.blockedNoPath.map((b): BacklogItem => ({ id: b.id, kind: "blocked", since: b.blockedSince })),
      ];
      const owner = roles?.ownerUserId ?? null;
      if (owner) {
        const mine = await ctx.db.query<Record<string, unknown>>(
          `SELECT id::text AS id, updated_at FROM public.issues WHERE company_id = $1::uuid AND assignee_user_id = $2 AND hidden_at IS NULL AND status IN ('todo', 'in_progress', 'in_review', 'blocked') LIMIT 200`,
          [companyId, owner],
        );
        for (const r of mine) items.push({ id: String(r.id), kind: "issue", since: r.updated_at ? new Date(String(r.updated_at)).toISOString() : null });
      }
      const pending = ((await ctx.approvals.list({ companyId }).catch(() => [])) as unknown as Array<Record<string, unknown>>).filter((a) => String(a.status) === "pending");
      for (const a of pending) items.push({ id: `approval:${String(a.id)}`, kind: "approval", since: a.createdAt ? new Date(String(a.createdAt)).toISOString() : null });
      return {
        health: [...nonOk(backlogCheck(items, now)), ...nonOk(blockersUnreadableCheck(backlog.blockedUnknown))],
        waiting: [...backlogWaitingItems(backlog, { prefix }), ...(await effectWaitingItems(env, companyId))],
      };
    }],
    ["unhandled-asks", async () => {
      const day = 86_400_000;
      const rows = await ctx.db.query<Record<string, unknown>>(
        `SELECT a.issue_id, a.issue_identifier, a.asked_at FROM ${NAMESPACE}.asks a JOIN public.issues i ON i.id::text = a.issue_id AND i.company_id::text = a.company_id
          WHERE a.company_id = $1 AND a.status = 'open' AND a.asked_at < $2::timestamptz AND i.updated_at < $3::timestamptz ORDER BY a.asked_at LIMIT 50`,
        [companyId, new Date(now.getTime() - 3 * day).toISOString(), new Date(now.getTime() - 3 * day).toISOString()],
      );
      const asks: UnhandledAsk[] = rows.map((r) => ({ issueId: String(r.issue_id), identifier: r.issue_identifier == null ? null : String(r.issue_identifier), askedAt: new Date(String(r.asked_at)).toISOString() }));
      return { health: nonOk(unhandledAsksCheck(asks)) };
    }],
    // Tier A client sends: sends with no gate approval, and the 14-day info cards (client-send policy, PAR-7868).
    ["client-sends", async () => clientSendChecks(env, companyId)],
    ["skill-sync", async () => ({ health: nonOk(await skillSyncCheck(ctx, companyId, "Cockpit", now.getTime())) })],
    // The measurement layer (Q8-3, Q8-8, Q9-12).
    ["measure", async () => {
      const [spend, caps, limits, coverage, names] = await Promise.all([
        readSpendWindows(ctx, companyId, now),
        spendCaps(ctx, companyId),
        readLimitFailures(ctx, companyId, new Date(now.getTime() - 24 * 3_600_000).toISOString()),
        measureReviewCoverage(env, companyId, 30, roles?.reviewerAgentId ?? null),
        agentNames(env, companyId),
      ]);
      const kpis: CockpitKpi[] = [{ key: "ai_spend_7d", label: "AI spend, 7 days (notional)", value: formatUsd(spend.usd7d), raw: Math.round(spend.usd7d * 100) / 100, hint: `${formatUsd(spend.usd24h)} in the last day. Not billed: flat-plan tokens at list price.`, tone: "neutral", group: "delivery", href: "/cockpit" }];
      if (coverage && coverage.coverage !== null) {
        kpis.push({ key: "review_coverage", label: "Code work reviewed (30 days)", value: `${Math.round(coverage.coverage * 100)}%`, raw: Math.round(coverage.coverage * 100), hint: `${coverage.reviewed} of ${coverage.done} closed${coverage.latencyP50Hours !== null ? `; typical review ${coverage.latencyP50Hours} h` : ""}`, tone: coverage.coverage >= 0.7 ? "ok" : "warn", group: "delivery", href: "/cockpit" });
      }
      return {
        health: [...spendChecks(spend, caps), ...limitFailureChecks(limits, names, 24), ...(coverage ? nonOk(reviewCoverageCheck(coverage)) : [])],
        kpis,
      };
    }],
    ["client-effort", async () => ({ health: await clientEffortHealth(env, companyId) })],
    ["credentials", async () => ({ health: await credentialHealth(env, companyId) })],
    // What only the owner can confirm, and the single admin (the critic's custody items).
    ["custody", async () => {
      const attested = await readAttestations(ctx, companyId);
      // A confirmation that has lapsed (180 days) no longer excuses the single-admin warning.
      const members = await membersCheck(env, companyId, attestationState(attested.get("second_admin"), now) === "confirmed");
      return { health: [...attestationChecks(attested, now), ...nonOk(members)] };
    }],
    // Self-improvement and goals (Q2-3, Q10-3).
    ["improvements", async () => {
      const brief = await improvementsBrief(env, companyId);
      const health: HealthCheck[] = brief.overdue > 0
        ? [{ key: "improvements:overdue", title: `${brief.overdue} improvement${brief.overdue === 1 ? "" : "s"} past the re-check date`, status: "warn", detail: "A change was recorded with a number to move and a date to look again, and the date passed without a measurement: the Cockpit could not read the number, or nobody recorded it.", href: "/cockpit", fix: "Record the number (improvement-resolve with resultValue) or drop the improvement; the weekly retro lists them." }]
        : [];
      return { health, kpis: brief.open > 0 ? [{ key: "improvements_open", label: "Open improvements", value: String(brief.open), raw: brief.open, hint: brief.due ? `${brief.due} due for a re-check` : "None due yet", tone: brief.overdue > 0 ? "warn" : "neutral", group: "other", href: "/cockpit" }] : [] };
    }],
    ["goals", async () => {
      const views = await goalViews(env, companyId, ["active"]);
      if (views.length === 0) return {};
      const good = views.filter((v) => v.progress.state === "reached" || v.progress.state === "on_track").length;
      return { kpis: [{ key: "goals_on_track", label: "Goals on track", value: `${good} of ${views.length}`, raw: good, hint: views.filter((v) => v.progress.state === "no_data").length ? "Some goals have no number yet" : "Reached or at least 80% of the way", tone: good === views.length ? "ok" : "warn", group: "other", href: "/cockpit" }] };
    }],
    ["memory-signal", async () => {
      const stats = await memoryStats(ctx, companyId);
      const signal = feedbackSignal(stats.briefs30d.total, stats.feedback30d.briefsWithFeedback);
      return { quality: [{ key: "memory_feedback_signal", label: "Memory brief feedback coverage (30 days)", value: signal.level === "none" ? "No signal" : `${stats.feedback30d.briefsWithFeedback} of ${stats.briefs30d.total}`, raw: stats.feedback30d.briefsWithFeedback, tone: signal.level === "ok" ? "ok" : "warn" }] };
    }],
  ];
  return gather(env, companyId, now.getTime(), parts, start);
}

/** Forget a company's cached parts, losses and holds (after a change that should show at once). */
export function forgetChecks(env: Env, companyId: string): void {
  caches.get(env)?.delete(companyId);
  // A run still going on writes to the forgotten cache; the next call starts its own.
  inFlight.get(env)?.delete(companyId);
}

