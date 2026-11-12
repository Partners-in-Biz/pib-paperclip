/**
 * Client preview links: the agent proposes a page's copy, the server renders it on top of the live page and the
 * client opens `PREVIEW_BASE/p/<site>/<token>` (preview service on the VPS) to approve or ask for changes. Nothing is
 * applied to the site here; a person approves, then the agent applies the change through the Connector.
 */
import { randomBytes } from "node:crypto";
import { reviewerAgentId, wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { t } from "../db.js";
import { checkClaims } from "../engine/claims.js";
import { checkWhy } from "../engine/why.js";
import { rubricLines, scorePreviewCopy, type PreviewRubric } from "../engine/rubric.js";
import { isRehearsalSprint } from "../engine/rehearsal.js";
import { loadFacts } from "./facts.js";
import { buildPreviewHtml, checkLinkText, countBySelector, MIN_KEPT_PCT, parseContentSelector, fingerprintChanges, liveFingerprint, previewStats, visibleWords, type LiveFingerprint, withDoctype, type BodyMode, type LinkEdit, type PreviewChanges } from "../engine/preview.js";
import { ORIGIN } from "../constants.js";
import { IN_FLIGHT_MAX_MS, previewRequestKey, REUSE_RECHECK_MS, REUSE_WINDOW_MINUTES } from "../engine/request-key.js";
import { capComment, commentFingerprint } from "../engine/thread.js";
import { actorId, assignableUser, bool, errorMessage, num, oneOf, reqStr, SeoError, str, type Actor, type Env, type Params } from "./common.js";
import { assertWritable, loadSprintContext } from "./context.js";
import { companyInfo } from "./common.js";
import { seniorTried, startPreviewFix } from "./build.js";
import { addNeedsYou, closeNeedsYouItems, closeSignoffItems } from "./needs-you.js";
import { afterPreviewPassed, handleClientAnswer, isAutoSignoff } from "./client-signoff.js";
import { commentOn, getIssue, openIssue, patchIssue } from "./issues.js";
import { exportToDrive, sprintDriveTarget } from "./drive-export.js";

export const PREVIEW_DAYS = 30;
const MAX_HTML = 1_500_000;
export { PREVIEW_BASE, previewLink, previewSlug } from "./preview-links.js";
import { assertWpBodyApplicable, needsWpBodyCheck, wpPostContent } from "./wp-body.js";
import { PREVIEW_RENDER_URL, previewLink, previewSlug } from "./preview-links.js";

function hostOf(url: string): string {
  return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
}

/** A link target for linkEdits: http/https, no userinfo, this sprint's own host. Returns what is stored. Never a prefix or substring test. */
export function parseLinkHref(raw: string, siteUrl: string): string {
  const refuse = (why: string): never => {
    throw new SeoError(`linkEdits href "${raw.slice(0, 120).replace(/[\u0000-\u001f\u007f]/g, "?")}" refused: ${why}.`);
  };
  if (/[\u0000-\u001f\u007f\s\\]/.test(raw)) refuse("it has a control character, space or backslash");
  const relative = raw.startsWith("/") && !raw.startsWith("//");
  let url: URL;
  try {
    url = relative ? new URL(raw, siteUrl) : new URL(raw);
  } catch {
    return refuse("it is not a full http(s) address or a path starting with one /");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") refuse("only http and https links are allowed");
  if (url.username || url.password) refuse("it carries a username or password");
  if (hostOf(url.href) !== hostOf(siteUrl)) refuse(`links must go to ${siteUrl}'s own site`);
  return relative ? `${url.pathname}${url.search}${url.hash}` : url.href;
}

function linkEditsOf(params: Params, siteUrl: string): LinkEdit[] | undefined {
  const raw = params.linkEdits;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 5) throw new SeoError("linkEdits must be 1 to 5 entries of { text, href }.");
  return raw.map((entry) => {
    const e = entry as { text?: unknown; href?: unknown } | null;
    if (!e || typeof e.text !== "string" || typeof e.href !== "string") throw new SeoError("Each linkEdits entry needs text and href (strings).");
    checkLinkText(e.text);
    return { text: e.text, href: parseLinkHref(e.href, siteUrl) };
  });
}

/** Postgres text and jsonb cannot hold a NUL (0x00): a page that has one (a stray byte in a script or an attribute) made every preview of it fail to save. */
export function withoutNul<T>(value: T): T {
  if (typeof value === "string") return value.replace(/\u0000/g, "") as T;
  if (Array.isArray(value)) return value.map((v) => withoutNul(v)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, withoutNul(v)])) as T;
  return value;
}

/** Optional caller-supplied CRM client for the Drive copy (no CRM lookup here): `{ kind: company|contact, ref }`. */
export function previewClient(params: Params): { kind: "company" | "contact"; ref: string } | undefined {
  const raw = params.client;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new SeoError("client must be an object { kind, ref }.");
  const { kind, ref } = raw as Record<string, unknown>;
  if (kind !== "company" && kind !== "contact") throw new SeoError("client.kind must be company or contact.");
  if (typeof ref !== "string" || ref.trim().length === 0) throw new SeoError("client.ref must be a non-empty CRM id.");
  return { kind, ref: ref.trim().slice(0, 200) };
}

/** What create-preview stores in `previews.stats`: exactly one kept-text figure (PAR-8787). */
export type StoredPreviewStats = (
  | { basis: "rendered"; rendered: ReturnType<typeof previewStats> & { at: string } }
  | (ReturnType<typeof previewStats> & { basis: "source"; rendered?: undefined })
) & { liveFingerprint?: LiveFingerprint };

/** Shown wherever a preview was built from the page source because the render was not usable (PiB, PAR-8791 Q5). */
export const SOURCE_BASIS_NOTICE = "Made from the page source: header and scripted parts may differ.";
/** /render is only asked while the 30 s tool call still has room for it (source fetch <= 12 s + render <= 15 s). */
const RENDER_START_BY_MS = 12_000;
const RENDER_TIMEOUT_MS = 15_000;

/** Pause before asking a busy render service (503) again. */
const RENDER_BUSY_WAIT_MS = 1_500;
const RENDER_BUSY_TRIES = 6;
const askRender = (env: Env, url: string) =>
  env.fetch(PREVIEW_RENDER_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(RENDER_TIMEOUT_MS) });

const basisOf = (stats: { basis?: unknown } | null | undefined): "rendered" | "source" => (stats?.basis === "rendered" ? "rendered" : "source");

/**
 * The live page's DOM after its scripts ran, from the preview service's fixed loopback endpoint. Never throws: any
 * problem returns the reason, and the caller builds from the source as before.
 */
async function renderedLive(env: Env, url: string, source: string, selector: string | undefined, startedAt: number): Promise<{ html: string; note: string } | { note: string }> {
  const fallback = (reason: string) => ({ note: `${SOURCE_BASIS_NOTICE} (Render not used: ${reason}.)` });
  const elapsed = env.now().getTime() - startedAt;
  if (elapsed >= RENDER_START_BY_MS) return fallback(`${Math.round(elapsed / 1000)} s already spent fetching the page`);
  let html: unknown;
  try {
    const waitFrom = Date.now();
    let r = await askRender(env, url);
    // 503 = another render is running (one at a time, a few seconds each): wait for it while there is still room,
    // rather than build from the source on a busy minute (PAR-9945: a source-built preview lost the page's tabs).
    for (let tries = 1; r.status === 503 && tries < RENDER_BUSY_TRIES && Date.now() - waitFrom + RENDER_BUSY_WAIT_MS < RENDER_START_BY_MS - elapsed; tries++) {
      await new Promise((done) => setTimeout(done, RENDER_BUSY_WAIT_MS));
      r = await askRender(env, url);
    }
    if (r.status !== 200) return fallback(`the render service answered ${r.status}${r.status === 503 ? " (busy with another render)" : ""}`);
    const text = await r.text();
    try {
      html = (JSON.parse(text) as { html?: unknown } | null)?.html;
    } catch {
      return fallback("the render service did not answer JSON");
    }
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    return fallback(name === "AbortError" || name === "TimeoutError" ? `no render within ${RENDER_TIMEOUT_MS / 1000} s` : `the render service could not be reached (${errorMessage(error).slice(0, 120)})`);
  }
  if (typeof html !== "string" || !html.trim()) return fallback("the render came back empty");
  if (html.length > MAX_HTML) return fallback("the rendered page is too large");
  if (visibleWords(html).length === 0) return fallback("the rendered page shows 0 words");
  let counts = "";
  if (selector) {
    const inRender = countBySelector(html, selector);
    const inSource = countBySelector(source, selector);
    counts = ` contentSelector ${selector}: ${inRender} in the rendered page, ${inSource} in the source.`;
    if (inRender < 1 || inRender !== inSource) return fallback(`contentSelector ${selector} matches ${inRender} element(s) in the rendered page and ${inSource} in the source`);
  }
  return { html: withDoctype(html), note: `Built from the live page as a visitor's browser shows it (scripts ran, 1280 px wide).${counts}` };
}

export async function createPreview(env: Env, companyId: string, actor: Actor, params: Params) {
  const startedAt = env.now().getTime();
  const sprintId = reqStr(params, "sprintId");
  const client = previewClient(params);
  const { sprint } = await loadSprintContext(env, companyId, sprintId);
  assertWritable(sprint);
  const rawUrl = reqStr(params, "pageUrl", { max: 2000 });
  let pageUrl: string;
  try {
    pageUrl = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : new URL(rawUrl, sprint.siteUrl).toString()).toString();
  } catch {
    throw new SeoError("pageUrl must be a page of the client's site (a full URL or a path such as /about).");
  }
  if (hostOf(pageUrl) !== hostOf(sprint.siteUrl)) throw new SeoError(`pageUrl must be a page on ${sprint.siteUrl}; previews are only built for this sprint's own site.`);
  const changes: PreviewChanges = {
    title: str(params, "title", { max: 300 }),
    metaDescription: str(params, "metaDescription", { max: 500 }),
    h1: str(params, "h1", { max: 300 }),
    bodyHtml: str(params, "bodyHtml", { max: 200_000 }),
    bodyMode: oneOf(params, "bodyMode", ["before", "after", "replace"] as const) as BodyMode | undefined,
    css: str(params, "css", { max: 80_000 }),
    contentSelector: str(params, "contentSelector", { max: 100 }),
  };
  const linkEdits = linkEditsOf(params, sprint.siteUrl);
  if (linkEdits) changes.linkEdits = linkEdits;
  if (changes.contentSelector) parseContentSelector(changes.contentSelector);
  else delete changes.contentSelector;
  const why = checkWhy(str(params, "why", { max: 1000 }));
  if (why.error) throw new SeoError(why.error);
  if (why.why) changes.why = why.why;
  const allowReplace = bool(params, "allowReplace") ?? false;
  if (!changes.title && !changes.metaDescription && !changes.h1 && !changes.bodyHtml && !changes.css && !changes.linkEdits) throw new SeoError("Send at least one proposed change: title, metaDescription, h1, bodyHtml or linkEdits.");
  let taskId = str(params, "taskId", { max: 80 });
  // A corrected preview made without a taskId (a developer's fix) belongs to the task the page's earlier preview belonged to.
  if (!taskId) {
    const earlier = await env.ctx.db.query(`SELECT task_id FROM ${t("previews")} WHERE company_id = $1 AND sprint_id = $2 AND page_url = $3 AND task_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [companyId, sprintId, pageUrl]);
    if (earlier[0]?.task_id) taskId = String(earlier[0].task_id);
  }
  const task = taskId ? await db.getTask(env.ctx.db, companyId, taskId) : null;
  if (taskId && (!task || task.sprintId !== sprintId)) throw new SeoError("No such task on this sprint.");
  const redesign = task?.taskType === "redesign";
  if (changes.css && !redesign) throw new SeoError("css (styles on the preview) is only for redesign tasks. Copy goes in bodyHtml; styling an ordinary page is a build problem for a developer.");

  // The claims rule: statements about how the business works need an approved wording from the fact sheet.
  const sheet = await loadFacts(env, companyId, sprintId);
  const violations = checkClaims([changes.title, changes.metaDescription, changes.h1, changes.bodyHtml, changes.why], sheet.facts);
  if (violations.length > 0) {
    const approved = sheet.facts.filter((f) => f.kind === "say").slice(0, 12).map((f) => `- ${f.text}`);
    throw new SeoError(
      [
        `The copy makes claims about how the business works that the client fact sheet does not cover (${violations.length}):`,
        ...violations.slice(0, 8).map((v) => `- "${v.sentence.slice(0, 220)}": ${v.why}`),
        "",
        approved.length > 0 ? `Approved wordings you may reuse (shortened is fine, reworded is not):\n${approved.join("\n")}` : "There are no approved wordings yet for this client.",
        "Leave the claim out, or use an approved wording. If the client says it on their own site (terms, delivery, returns, FAQ, about), copy the sentence exactly and add it with propose-client-facts (the plugin checks it against that page). If the client does not say it anywhere, leave the claim out. Do not invent or paraphrase it.",
      ].join("\n"),
    );
  }

  const label = str(params, "label", { max: 200 });
  const rubric = scorePreviewCopy(changes);
  const requestKey = previewRequestKey({ companyId, sprintId, pageUrl, taskId: task?.id ?? null, changes: withoutNul(changes), allowReplace, label, client, rubric });
  const req: PreviewRequestContext = { companyId, sprintId, sprint, pageUrl, changes, allowReplace, task, redesign, label, client, rubric, requestKey, startedAt };
  return onceInFlight(requestKey, env.now().getTime(), async () => (await reuseStoredPreview(env, req)) ?? (await freshPreview(env, actor, req)));
}

/** A type, not an interface: callers read it as a plain record. */
export type CreatePreviewResult = {
  previewId: string;
  url: string;
  pageUrl: string;
  expiresAt: string;
  applied?: string[];
  stats: StoredPreviewStats;
  basis: "rendered" | "source";
  reviewStatus: string;
  reviewIssueId: string | null;
  rubric?: PreviewRubric;
  notes?: string[];
  /** true: this exact preview already existed (a repeated call); use its previewId and do not call again. */
  reused: boolean;
  next: string;
};

interface PreviewRequestContext {
  companyId: string;
  sprintId: string;
  sprint: db.Sprint;
  pageUrl: string;
  changes: PreviewChanges;
  allowReplace: boolean;
  task: db.SprintTask | null;
  redesign: boolean;
  label: string | undefined;
  client: ReturnType<typeof previewClient>;
  rubric: PreviewRubric | null;
  requestKey: string;
  startedAt: number;
}

/**
 * Identical create-preview calls running at the same time share one build. One worker process serves the plugin, so this map
 * sees every concurrent call; an entry older than IN_FLIGHT_MAX_MS is treated as hung and dropped, so a stuck call blocks retries
 * for at most that long. After a restart the map is empty and the stored lookup (reuseStoredPreview) answers instead.
 */
const IN_FLIGHT = new Map<string, { promise: Promise<CreatePreviewResult>; startedAt: number }>();

/** Running create-preview builds (tests). */
export const inFlightPreviewCount = (): number => IN_FLIGHT.size;

async function onceInFlight(key: string, now: number, run: () => Promise<CreatePreviewResult>): Promise<CreatePreviewResult> {
  const running = IN_FLIGHT.get(key);
  if (running) {
    if (now - running.startedAt < IN_FLIGHT_MAX_MS) return { ...(await running.promise), reused: true };
    if (IN_FLIGHT.get(key) === running) IN_FLIGHT.delete(key);
  }
  const entry = { promise: run(), startedAt: now };
  IN_FLIGHT.set(key, entry);
  try {
    return await entry.promise;
  } finally {
    if (IN_FLIGHT.get(key) === entry) IN_FLIGHT.delete(key);
  }
}

const isoOf = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();

/** The newest pending, not sent-back, unexpired preview made for this exact request in the last REUSE_WINDOW_MINUTES. */
export async function findReusablePreview(env: Env, companyId: string, requestKey: string): Promise<Record<string, unknown> | null> {
  const rows = await env.ctx.db.query(
    `SELECT id, created_at, expires_at, stats, review_status, review_issue_id, review_key, task_id FROM ${t("previews")}
      WHERE company_id = $1 AND request_key = $2 AND status = 'pending' AND review_status <> 'changes_needed'
        AND expires_at > now() AND created_at > now() - interval '${REUSE_WINDOW_MINUTES} minutes'
      ORDER BY created_at DESC LIMIT 1`,
    [companyId, requestKey],
  );
  return rows[0] ?? null;
}

/** The page source, or null when it cannot be read within `ms` (no render: this only checks whether the page changed). */
async function sourceWithin(env: Env, url: string, ms: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([env.site(url, { maxChars: MAX_HTML }), new Promise<null>((done) => { timer = setTimeout(() => done(null), ms); })]);
    return res && res.status < 400 && res.text ? res.text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The open review issue a first call opened for this preview but did not record (it was cut off), if any. */
async function openReviewIssueOf(env: Env, companyId: string, previewId: string): Promise<string | null | undefined> {
  try {
    const found = await env.ctx.issues.list({ companyId, originKind: ORIGIN.previewReview, originId: `preview-review:${previewId}`, limit: 5 });
    return found.find((i) => i.status !== "done" && i.status !== "cancelled")?.id ?? null;
  } catch (error) {
    env.ctx.logger.info("SEO preview review lookup failed", { previewId, error: errorMessage(error) });
    return undefined;
  }
}

/**
 * A repeated call (for example after a gateway timeout): return the stored preview instead of building a second one, and
 * finish what the first call may not have done (the review issue, parking the task). Null when there is none to reuse or the
 * live page changed since.
 */
async function reuseStoredPreview(env: Env, req: PreviewRequestContext): Promise<CreatePreviewResult | null> {
  const row = await findReusablePreview(env, req.companyId, req.requestKey);
  if (!row) return null;
  const stats = (typeof row.stats === "string" ? JSON.parse(row.stats) : row.stats ?? {}) as StoredPreviewStats;
  const madeAt = isoOf(row.created_at);
  const notes = [`This exact preview was already made at ${madeAt} (a repeated call, for example after a gateway timeout). No new preview was made.`];
  if (stats.liveFingerprint && typeof stats.liveFingerprint.title === "string") {
    const source = await sourceWithin(env, req.pageUrl, REUSE_RECHECK_MS);
    if (source === null) notes.push(`Could not re-check the live page; reused the preview made at ${madeAt}.`);
    else if (fingerprintChanges(stats.liveFingerprint, liveFingerprint(source)).length > 0) return null;
  }
  const previewId = String(row.id);
  const reviewStatus = String(row.review_status);
  let reviewIssueId = row.review_issue_id ? String(row.review_issue_id) : null;
  const title = req.changes.title ?? req.changes.h1 ?? req.pageUrl;
  // A passed preview's task was already handed back to the agent: parking it again would wait for a verdict that came.
  if (reviewStatus === "pending") {
    if (!reviewIssueId && !isRehearsalSprint(req.sprint)) {
      const existing = await openReviewIssueOf(env, req.companyId, previewId);
      if (existing) {
        await env.ctx.db.execute(`UPDATE ${t("previews")} SET review_issue_id = $2 WHERE id = $1 AND company_id = $3`, [previewId, existing, req.companyId]);
        reviewIssueId = existing;
      } else if (existing === null) {
        const c = req.changes;
        const applied = [c.title && "title", c.metaDescription && "metaDescription", c.h1 && "h1", c.bodyHtml && "bodyHtml", c.linkEdits?.length && "links", c.css && "css"].filter((a): a is string => typeof a === "string");
        reviewIssueId = await routePreviewReview(env, req.sprint, { rubric: req.rubric, id: previewId, key: String(row.review_key), pageUrl: req.pageUrl, title, stats, applied, notes: [], taskIssueId: req.task?.issueId ?? null, redesign: req.redesign, linkEdits: c.linkEdits });
      }
    }
    await parkTaskForReview(env, req.companyId, row.task_id ? String(row.task_id) : null, title);
  }
  return {
    previewId,
    url: previewLink(req.sprint.siteUrl, previewId),
    pageUrl: req.pageUrl,
    expiresAt: isoOf(row.expires_at),
    stats,
    basis: basisOf(stats),
    reviewStatus,
    reviewIssueId,
    reused: true,
    notes,
    next: reviewStatus === "passed" ? "The Reviewer already passed this preview: use this previewId and link. Do not make it again." : nextAfterPreview(req.sprint),
  };
}

const nextAfterPreview = (sprint: db.Sprint): string =>
  sprint.clientSignoff === "auto"
    ? "The link is HELD: the client sees a 'being checked' page until the Reviewer has compared it with the live page and passed it. Make a preview for every page of this task, then END your turn. The plugin does the rest: it parks this task on the client, drafts one approval email in Gmail for a person to send, and wakes you when the client has answered every preview of the task (with what to apply and what to revise). Do not put the links on Needs you and do not use block-task for this. Apply nothing before then."
    : "The link is HELD: the client sees a 'being checked' page until the Reviewer has compared it with the live page and passed it. End your turn after making your previews; you are woken on this task's issue with the result. Only then put the link on Needs you for the owner. If the Reviewer asks for changes, fix and make a new preview. Apply anything through the Connector only after the client approved and the owner confirmed.";

async function freshPreview(env: Env, actor: Actor, req: PreviewRequestContext): Promise<CreatePreviewResult> {
  const { companyId, sprintId, sprint, pageUrl, changes, allowReplace, task, redesign, label, client, rubric, requestKey, startedAt } = req;
  const res = await env.site(pageUrl, { maxChars: MAX_HTML });
  if (res.status >= 400 || !res.text) throw new SeoError(`The live page answered ${res.status}; check the URL (a new page that is not live yet cannot be previewed on top of a live page).`);
  const token = randomBytes(24).toString("base64url");
  const sourceUrl = res.url || pageUrl;
  // Build from the page as a visitor sees it (scripts ran) when the preview service can render it; else from the source.
  // The WordPress body check (PAR-10302) runs beside the render; wpPostContent never throws.
  const wpBody = needsWpBodyCheck(changes) ? wpPostContent(env, res.text, sourceUrl) : null;
  const render = await renderedLive(env, sourceUrl, res.text, changes.contentSelector, startedAt);
  const wp = wpBody ? await wpBody : ({ kind: "none" } as const);
  assertWpBodyApplicable(wp, changes);
  const liveHtml = withoutNul("html" in render ? render.html : res.text);
  const built = buildPreviewHtml(liveHtml, sourceUrl, withoutNul(changes), { token, clientName: sprint.clientName });
  if (built.applied.length === 0) throw new SeoError(`None of the changes could be placed on the page. ${built.notes.join(" ")}`.trim());
  built.notes.unshift(render.note);
  if (wp.kind === "skip") built.notes.push(wp.note);
  const figure = previewStats(liveHtml, built.html);
  // One stored figure: on the rendered basis it is `stats.rendered` (the review page never recomputes it); on the
  // source basis the review page measures `stats.rendered` on first open.
  const stats: StoredPreviewStats = {
    ...("html" in render ? { basis: "rendered" as const, rendered: { ...figure, at: env.now().toISOString() } } : { ...figure, basis: "source" as const }),
    // The live page as it was when the preview was made (the page source, the same thing checkLive fetches); list-previews checkLive compares it later.
    liveFingerprint: liveFingerprint(res.text),
  };
  if (figure.keptPct < MIN_KEPT_PCT && !(changes.bodyMode === "replace" && allowReplace)) {
    throw new SeoError(
      `This preview would keep only ${figure.keptPct}% of the live page's text (${figure.removedWords} of ${figure.liveWords} words gone). A change is added to the page, it does not wipe it: use bodyMode "before" or "after" to add copy next to the existing content. Only if you really are rewriting the whole page, send bodyMode "replace" with allowReplace true and say why in the summary.`,
    );
  }
  const reviewKey = randomBytes(18).toString("base64url");
  const expiresAt = new Date(env.now().getTime() + PREVIEW_DAYS * 86_400_000).toISOString();
  await env.ctx.db.execute(
    `INSERT INTO ${t("previews")} (id, company_id, sprint_id, task_id, issue_id, page_url, title, html, changes, expires_at, created_by, review_key, stats, request_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz, $11, $12, $13::jsonb, $14)`,
    [token, companyId, sprintId, task?.id ?? null, task?.issueId ?? sprint.rootIssueId ?? null, pageUrl, withoutNul(label ?? changes.title ?? changes.h1 ?? pageUrl), withoutNul(built.html), JSON.stringify(withoutNul(changes)), expiresAt, actorId(actor), reviewKey, JSON.stringify(withoutNul(stats)), requestKey],
  );
  // Save preview to Drive (non-blocking, errors only log warnings)
  const today = env.now().toISOString().split("T")[0]!;
  const previewLabel = label ?? changes.title ?? changes.h1 ?? "preview";
  const driveName = `${today} SEO preview ${previewLabel.slice(0, 80).replace(/[/\\:*?"<>|]/g, "")} v01.html`;
  // The sprint's own client wins over the caller's; an own sprint asks for the own folder (PAR-8128). null = no copy.
  const driveTarget = sprintDriveTarget(sprint, client);
  if (!driveTarget) env.ctx.logger.warn("SEO preview not copied to Drive: the sprint names a client that is not linked in the CRM", { sprintId });
  if (driveTarget) void exportToDrive(env.ctx, {
    companyId,
    kind: "seo",
    name: driveName,
    mimeType: "text/html",
    bytes: Buffer.from(withoutNul(built.html)),
    subfolder: "03 Deliverables",
    ...driveTarget,
  }).catch(() => {
    // Suppress errors; exportToDrive never throws but we catch any unexpected issue
  });
  const review = await routePreviewReview(env, sprint, { rubric, id: token, key: reviewKey, pageUrl, title: changes.title ?? changes.h1 ?? pageUrl, stats, applied: built.applied, notes: built.notes, taskIssueId: task?.issueId ?? null, redesign, linkEdits: changes.linkEdits });
  await parkTaskForReview(env, companyId, task?.id ?? null, changes.title ?? changes.h1 ?? pageUrl);
  return {
    previewId: token,
    url: previewLink(sprint.siteUrl, token),
    pageUrl,
    expiresAt,
    applied: built.applied,
    stats,
    basis: stats.basis,
    reviewStatus: "pending",
    reviewIssueId: review,
    ...(rubric ? { rubric } : {}),
    ...(built.notes.length > 0 ? { notes: built.notes } : {}),
    reused: false,
    next: nextAfterPreview(sprint),
  };
}

/** Rows `list-previews` returns by default (agents were handed up to 100 full rows, ~89 KB on average). */
export const PREVIEW_LIST_DEFAULT = 20;
const PREVIEW_NOTE_COMPACT = 200;

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/**
 * Previews of a sprint, newest first. Short rows by default (notes cut to ~200 characters, no figures, the client
 * link only on previews the Reviewer passed); `previewId` returns one preview in full, `compact: false` every row in full.
 */
export async function listPreviews(env: Env, companyId: string, params: Params) {
  const sprintId = reqStr(params, "sprintId");
  const previewId = str(params, "previewId", { max: 80 });
  const where = ["company_id = $1", "sprint_id = $2"];
  const args: unknown[] = [companyId, sprintId];
  const filter = (column: string, value: string | undefined) => {
    if (!value) return;
    args.push(value);
    where.push(`${column} = $${args.length}`);
  };
  filter("id", previewId);
  filter("task_id", str(params, "taskId", { max: 80 }));
  filter("status", oneOf(params, "status", ["pending", "approved", "changes_requested", "declined", "cancelled"] as const));
  filter("review_status", oneOf(params, "reviewStatus", ["pending", "passed", "changes_needed"] as const));
  const limit = previewId ? 1 : num(params, "limit", { integer: true, min: 1, max: 100 }) ?? PREVIEW_LIST_DEFAULT;
  const compact = previewId ? false : bool(params, "compact") ?? true;
  const includeHtml = Boolean(previewId) && bool(params, "includeHtml") === true;
  args.push(limit);
  const rows = await env.ctx.db.query(
    `SELECT id, task_id, page_url, title, status, decision_note, decided_at, expires_at, created_at, review_status, review_note, stats, cancel_reason, cancelled_at, changes, ${includeHtml ? "html," : ""} count(*) OVER() AS total FROM ${t("previews")}
      WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT $${args.length}::int`,
    args,
  );
  const total = rows[0] ? Number(rows[0].total ?? rows.length) : 0;
  const checkLive = Boolean(previewId) && bool(params, "checkLive") === true;
  const previews = await Promise.all(rows.map(async (r) => {
    const stats = typeof r.stats === "string" ? JSON.parse(String(r.stats)) : r.stats ?? {};
    const reviewNote = r.review_note ? String(r.review_note) : null;
    const note = r.decision_note ? String(r.decision_note) : null;
    const reviewStatus = String(r.review_status ?? "pending");
    if (!compact) {
      const stored = typeof r.changes === "string" ? JSON.parse(String(r.changes)) : r.changes ?? {};
      return {
        previewId: String(r.id),
        // The approved copy, readable for any status and expiry (the stored html is only returned with includeHtml).
        changes: { title: stored.title ?? null, metaDescription: stored.metaDescription ?? null, h1: stored.h1 ?? null, bodyHtml: stored.bodyHtml ?? null, bodyMode: stored.bodyHtml ? stored.bodyMode ?? "before" : null, linkEdits: stored.linkEdits ?? null },
        ...(includeHtml ? { html: String(r.html ?? "") } : {}),
        url: previewLink(String(r.page_url), String(r.id)),
        taskId: r.task_id ? String(r.task_id) : null,
        pageUrl: String(r.page_url),
        title: String(r.title),
        status: String(r.status),
        reviewStatus,
        ...(reviewNote ? { reviewNote } : {}),
        stats: { ...stats, basis: basisOf(stats) },
        ...(note ? { note } : {}),
        decidedAt: r.decided_at ? String(r.decided_at) : null,
        expiresAt: String(r.expires_at),
        ...(r.cancelled_at ? { cancelReason: r.cancel_reason ? String(r.cancel_reason) : null, cancelledAt: String(r.cancelled_at) } : {}),
        ...(checkLive ? { liveCheck: await liveCheckOf(env, String(r.page_url), stats?.liveFingerprint) } : {}),
      };
    }
    const keptPct = typeof stats?.rendered?.keptPct === "number" ? stats.rendered.keptPct : typeof stats?.keptPct === "number" ? stats.keptPct : null;
    return {
      previewId: String(r.id),
      // The client link is only for a preview the Reviewer passed; the others are held.
      ...(reviewStatus === "passed" ? { url: previewLink(String(r.page_url), String(r.id)) } : {}),
      taskId: r.task_id ? String(r.task_id) : null,
      pageUrl: String(r.page_url),
      title: cut(String(r.title), 100),
      status: String(r.status),
      reviewStatus,
      ...(reviewNote ? { reviewNote: cut(reviewNote, PREVIEW_NOTE_COMPACT), ...(reviewNote.length > PREVIEW_NOTE_COMPACT ? { reviewNoteCut: true } : {}) } : {}),
      ...(note ? { note: cut(note, PREVIEW_NOTE_COMPACT), ...(note.length > PREVIEW_NOTE_COMPACT ? { noteCut: true } : {}) } : {}),
      ...(keptPct != null ? { keptPct } : {}),
      basis: basisOf(stats),
      decidedAt: r.decided_at ? String(r.decided_at) : null,
      expiresAt: String(r.expires_at),
    };
  }));
  const cutAny = compact && previews.some((p) => "reviewNoteCut" in p || "noteCut" in p);
  return {
    previews,
    returned: previews.length,
    total,
    compact,
    ...(total > previews.length ? { more: `${total - previews.length} older previews not shown: raise limit (at most 100) or narrow with taskId, status or reviewStatus.` } : {}),
    ...(cutAny ? { detail: "Notes marked cut are shortened: pass previewId for one preview with its whole notes, figures and review link." } : {}),
  };
}

/** Tells the task's issue what the client answered (once per answer). Runs from the 5-minute job. */
export async function deliverPreviewAnswers(env: Env): Promise<number> {
  const rows = await env.ctx.db.query(
    `SELECT id, company_id, sprint_id, task_id, issue_id, page_url, title, status, decision_note, draft_key FROM ${t("previews")}
      WHERE decided_at IS NOT NULL AND notified_at IS NULL AND status IN ('approved', 'changes_requested')
        AND (decision_source = 'email' OR decision_source IS NULL) ORDER BY decided_at LIMIT 25`,
  );
  let sent = 0;
  for (const row of rows) {
    const id = String(row.id);
    const companyId = String(row.company_id);
    const issueId = row.issue_id ? String(row.issue_id) : null;
    const approved = row.status === "approved";
    try {
      // A sprint on automatic sign-off: the plugin takes the answer from here (service/client-signoff.ts).
      const sprint = await db.getSprint(env.ctx.db, companyId, String(row.sprint_id));
      if (sprint && isAutoSignoff(sprint)) {
        if (issueId) {
          const note = row.decision_note ? `\n\n> ${String(row.decision_note).replace(/\n/g, "\n> ")}` : "";
          await commentOn(env, companyId, issueId, `The client ${approved ? "**approved**" : "**asked for changes** on"} the preview of ${String(row.page_url)} (${String(row.title)}).${note}`);
        }
        const handled = await handleClientAnswer(env, sprint, {
          id,
          companyId,
          sprintId: sprint.id,
          taskId: row.task_id ? String(row.task_id) : null,
          issueId,
          pageUrl: String(row.page_url),
          title: String(row.title),
          status: String(row.status),
          note: row.decision_note ? String(row.decision_note) : null,
          draftKey: row.draft_key ? String(row.draft_key) : null,
        });
        if (handled) {
          await env.ctx.db.execute(`UPDATE ${t("previews")} SET notified_at = now() WHERE id = $1`, [id]);
          sent += 1;
          continue;
        }
      }
      if (issueId) {
        const verdict = approved ? "**approved**" : "**asked for changes** on";
        const note = row.decision_note ? `\n\n> ${String(row.decision_note).replace(/\n/g, "\n> ")}` : "";
        const next = approved
          ? "Nothing is applied yet: the owner confirms first (Apply approved changes on the sprint's Site section), then the agent applies it."
          : "The task is back with the SEO Specialist: revise the copy and make a new preview (it is checked by the Reviewer again); do not apply anything.";
        // A client who asks for changes reopens the task; an approval waits for the owner.
        if (!approved) await resumeTaskAfterClient(env, companyId, row.task_id ? String(row.task_id) : null);
        const ok = await commentOn(env, companyId, issueId, `The client ${verdict} the preview of ${String(row.page_url)} (${String(row.title)}).${note}\n\n${next}`);
        if (!ok) continue;
        if (!approved) await wakeIssue(env.ctx, issueId, companyId, "The client asked for changes to a preview");
      }
      // Asked for changes: the task went back to its agent here, so the hand-over sweep (T1b) must never repeat it.
      await env.ctx.db.execute(
        approved
          ? `UPDATE ${t("previews")} SET notified_at = now() WHERE id = $1`
          : `UPDATE ${t("previews")} SET notified_at = now(), handed_at = COALESCE(handed_at, now()), handover_done_at = COALESCE(handover_done_at, now()) WHERE id = $1`,
        [id],
      );
      sent += 1;
    } catch (error) {
      env.ctx.logger.info("SEO preview answer not delivered", { previewId: id, error: errorMessage(error) });
    }
  }
  return sent;
}

/** A Reviewer's note as it reads in an issue comment: the full text stays on the preview record (previews.review_note). */
const REVIEW_NOTE_COMMENT_MAX = 800;

export function reviewNoteExcerpt(notes: string, sprintId: string, previewId: string): string {
  return capComment(notes, { max: REVIEW_NOTE_COMMENT_MAX, pointer: `the full note is on the preview: partnersinbiz.seo:list-previews with sprintId ${sprintId} and previewId ${previewId}` });
}

/** The client asked for changes: a task parked on the sign-off goes back to its agent. */
async function resumeTaskAfterClient(env: Env, companyId: string, taskId: string | null): Promise<void> {
  if (!taskId) return;
  const task = await db.getTask(env.ctx.db, companyId, taskId);
  if (!task || !task.issueId) return;
  await closeSignoffItems(env, companyId, task.sprintId, task.id, "The client asked for changes.");
  if (task.status !== "blocked") return;
  if (!(await patchIssue(env, companyId, task.issueId, { status: "todo" }))) return;
  await db.updateTask(env.ctx.db, companyId, task.id, { status: "in_progress", issue_status: "todo", assignee_kind: "agent", blocker_reason: null });
}

const REVIEW_CHECKS = [
  "Open the review page (side-by-side screenshots of the live page and the proposal) and read the figures.",
  "Nothing the live page shows has disappeared: its sections, listings, menu, images, prices and calls to action are all still there (the figures say how much text is kept).",
  "The proposed copy reads well, is accurate for this client, invents no facts, prices, reviews or ratings, and its links go to real pages.",
  "Title (about 50-60 characters), description (about 150-160) and H1 are right and match the page.",
  "The page would look like a normal page of the site if this were published: no broken layout, no stray code.",
  "It LOOKS like it belongs on this site: colours, fonts, spacing and tone match the live page; new copy is set in the site's own styling, not dropped in as a plain box; the hierarchy is clear and the first screen still shows what visitors come for.",
];

const REDESIGN_CHECKS = [
  "This is a REDESIGN: judge the design, not only whether anything is missing. Is it clearly better than the live page, and does it keep the brand?",
  "Look at the phone screenshots too (the review page shows live and proposal at phone width): nothing overflows, text is readable, buttons are tappable.",
  "Everything that makes the page work is still there: listings, menu, forms, prices, calls to action, links.",
  "Say in your notes what you would improve; use fixBy developer or senior for design and build problems.",
];

/** Opens a review issue for the Reviewer (else the owner) and returns its id. Never throws. */
async function routePreviewReview(
  env: Env,
  sprint: db.Sprint,
  p: { rubric?: PreviewRubric | null; id: string; key: string; pageUrl: string; title: string; stats: StoredPreviewStats; applied: string[]; notes: string[]; taskIssueId: string | null; redesign?: boolean; linkEdits?: LinkEdit[] },
): Promise<string | null> {
  if (isRehearsalSprint(sprint)) return null;
  try {
    const reviewer = await reviewerAgentId(env.ctx, sprint.companyId);
    const owner = assignableUser(sprint.ownerUserId);
    const reviewUrl = `${previewLink(p.pageUrl, p.id)}/review?key=${p.key}`;
    const sheet = await loadFacts(env, sprint.companyId, sprint.id);
    const lines = [
      `A client preview for **${sprint.siteName}** (${sprint.siteUrl}) must be checked before the client sees it. The client's link shows "being checked" until you pass it.`,
      "",
      `Page: ${p.pageUrl}`,
      `Proposed: ${p.title} (changed: ${p.applied.join(", ")})`,
      `Review page (screenshots + figures): ${reviewUrl}`,
      p.stats.basis === "rendered"
        ? `Text kept from the live page: ${p.stats.rendered.keptPct}% (${p.stats.rendered.liveWords} words live, +${p.stats.rendered.addedWords} added, -${p.stats.rendered.removedWords} removed).`
        : "Kept-text figure: measured when the review page is first opened (made from the page source).",
      ...(p.notes.length ? ["", ...p.notes.map((n) => `Note: ${n}`)] : []),
      ...(p.linkEdits?.length ? ["", ...p.linkEdits.map((l) => `Link added: "${l.text}" -> ${l.href}`)] : []),
      ...(p.rubric ? ["", ...rubricLines(p.rubric)] : []),
      "",
      "## The client fact sheet (what the copy may claim)",
      sheet.facts.length > 0
        ? `${sheet.status === "confirmed" ? "Confirmed by the owner" : "Drafted from the client's own pages, not yet confirmed"}. Copy may describe how the business works only with these wordings:\n${sheet.facts.filter((f) => f.kind === "say").map((f) => `- ${f.text}`).join("\n")}\nNever say:\n${sheet.facts.filter((f) => f.kind === "avoid").map((f) => `- ${f.text}`).join("\n") || "- (nothing listed)"}`
        : "There is no fact sheet for this client yet: any claim about how the business works is unapproved.",
      "Still check every claim against the client's own pages (terms, lot pages, FAQ): the fact sheet is a floor, not proof the copy is right.",
      "",
      "## Check",
      ...[...REVIEW_CHECKS, ...(p.redesign ? REDESIGN_CHECKS : [])].map((c) => `- ${c}`),
      "",
      `Open the two screenshots for yourself (the review page links the PNG files: fetch them and look at them). Then record your verdict with \`partnersinbiz.seo:review-preview\` (sprintId ${sprint.id}, previewId ${p.id}, verdict pass or changes, notes with one line per problem) and set this issue to done. For verdict changes say WHO fixes it with fixBy: seo when the problem is the wording, keyword choice or facts; developer when it is how the page is built (markup, styling, colours, layout, links that do not look like links, an invisible heading); senior for theme or template changes, many pages or ecommerce. A developer then fixes it and makes the corrected preview, which you check again. Do not approve anything for the client and do not change the site.`,
    ];
    const created = await openIssue(env, {
      companyId: sprint.companyId,
      sprint,
      title: `Check client preview: ${p.title}`.slice(0, 240),
      description: lines.join("\n"),
      originKind: ORIGIN.previewReview,
      originId: `preview-review:${p.id}`,
      projectId: sprint.projectId,
      parentId: p.taskIssueId ?? sprint.rootIssueId ?? undefined,
      assigneeAgentId: reviewer,
      assigneeUserId: reviewer ? null : owner,
      priority: "medium",
      wakeReason: "Client preview needs a check",
    });
    await env.ctx.db.execute(`UPDATE ${t("previews")} SET review_issue_id = $2 WHERE id = $1`, [p.id, created.id]);
    return created.id;
  } catch (error) {
    env.ctx.logger.info("SEO preview review routing failed", { previewId: p.id, error: errorMessage(error) });
    return null;
  }
}

/** The Reviewer (or the owner) records what they saw. Pass releases the link to the client; changes goes back to the SEO agent. */
export async function reviewPreview(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprintId = reqStr(params, "sprintId");
  const previewId = reqStr(params, "previewId", { max: 80 });
  const verdict = oneOf(params, "verdict", ["pass", "changes"] as const);
  if (!verdict) throw new SeoError("verdict must be pass or changes.");
  const notes = str(params, "notes", { max: 4000 });
  let fixBy = oneOf(params, "fixBy", ["seo", "developer", "senior"] as const) ?? "seo";
  if (verdict === "changes" && !notes) throw new SeoError("Say what is wrong: notes are required with verdict changes.");
  const rows = await env.ctx.db.query(
    `SELECT id, task_id, issue_id, page_url, title, created_by, changes, review_key, status FROM ${t("previews")} WHERE id = $1 AND company_id = $2 AND sprint_id = $3 LIMIT 1`,
    [previewId, companyId, sprintId],
  );
  const row = rows[0];
  if (!row) throw new SeoError("No such preview on this sprint.");
  if (String(row.status) === "cancelled") throw new SeoError("This preview was cancelled (replaced by a newer version), so there is nothing to review. Review the current preview of the page instead (list-previews shows it).");
  if (actor.kind === "agent" && actorId(actor) === String(row.created_by)) throw new SeoError("You made this preview, so someone else has to check it: the Reviewer or the owner.");
  if (verdict === "pass" && actor.kind === "agent") {
    const stat = await env.ctx.db.query(`SELECT stats FROM ${t("previews")} WHERE id = $1 LIMIT 1`, [previewId]);
    const raw = stat[0]?.stats;
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, any>) : ((raw ?? {}) as Record<string, any>);
    const rendered = parsed.rendered as { keptPct?: number; liveWords?: number } | undefined;
    if (!rendered || typeof rendered.keptPct !== "number") throw new SeoError("Open the review page first (the link in your review issue): it measures the proposal against the live page as a visitor sees it, and a preview cannot be passed before that check has run.");
    if (!(typeof rendered.liveWords === "number" && rendered.liveWords > 0)) throw new SeoError("The rendered check saw 0 words on the live page, so its figures mean nothing. Reload the review page until the check shows the live words, or say verdict changes.");
    if (rendered.keptPct < MIN_KEPT_PCT) throw new SeoError(`The rendered check shows the proposal keeps only ${rendered.keptPct}% of what the live page shows. Send it back with verdict changes and say what is missing; only the owner can pass a preview like this.`);
  }
  await env.ctx.db.execute(
    `UPDATE ${t("previews")} SET review_status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`,
    [previewId, verdict === "pass" ? "passed" : "changes_needed", notes ?? null, actorId(actor)],
  );
  const issueId = row.issue_id ? String(row.issue_id) : null;
  const taskId = row.task_id ? String(row.task_id) : null;
  const pageUrl = String(row.page_url);
  // A page that keeps failing the check: the Senior Developer gets one go (the developer's own fix was the last try so far), then the owner is asked instead of going round and round.
  let forcedSenior = false;
  const escalateToOwner = async () => {
    const rounds = await env.ctx.db.query(`SELECT count(*)::int AS n FROM ${t("previews")} WHERE company_id = $1 AND task_id = $2 AND page_url = $3 AND review_status = 'changes_needed' AND status <> 'cancelled'`, [companyId, taskId, pageUrl]);
    const escalated = await escalateStuckPreview(env, companyId, sprintId, taskId!, pageUrl, String(row.title), notes!, Number(rounds[0]?.n), previewId);
    if (!escalated) return null;
    const owning = await db.getSprint(env.ctx.db, companyId, sprintId);
    if (owning && isAutoSignoff(owning)) return { previewId, reviewStatus: "changes_needed", clientCanOpen: false, pageDropped: true, next: "Set your review issue to done. The page failed the check repeatedly and was dropped from the task; the SEO agent carries on with the task's other pages." };
    // Once per page: the Reviewer's last reason is on the owner's Needs you item and in previews.review_note, not repeated here every round.
    if (issueId) {
      await commentOn(
        env,
        companyId,
        issueId,
        `The preview of ${pageUrl} has now been sent back ${rounds[0]?.n} times by the Reviewer, the Senior Developer's fix included. It is on the owner's Needs you list; do not make another preview for this page until it is answered. The Reviewer's last reason is on that item.`,
        { dedupeKey: `escalated:${taskId}:${commentFingerprint(pageUrl)}` },
      );
    }
    return { previewId, reviewStatus: "changes_needed", clientCanOpen: false, escalatedToOwner: true, next: "Set your review issue to done. The owner decides what happens with this page." };
  };
  if (verdict === "changes" && taskId) {
    const rounds = await env.ctx.db.query(`SELECT count(*)::int AS n FROM ${t("previews")} WHERE company_id = $1 AND task_id = $2 AND page_url = $3 AND review_status = 'changes_needed' AND status <> 'cancelled'`, [companyId, taskId, pageUrl]);
    if (Number(rounds[0]?.n ?? 0) >= MAX_REVIEW_ROUNDS) {
      const task = await db.getTask(env.ctx.db, companyId, taskId);
      if (task && !seniorTried(task, pageUrl)) {
        fixBy = "senior";
        forcedSenior = true;
      } else {
        const escalated = await escalateToOwner();
        if (escalated) return escalated;
      }
    }
  }
  // A build problem (markup, styling, layout, theme) is fixed by a developer, not by the SEO Specialist.
  let fix: Awaited<ReturnType<typeof startPreviewFix>> | null = null;
  if (verdict === "changes" && fixBy !== "seo" && taskId) {
    const changes = typeof row.changes === "string" ? (JSON.parse(String(row.changes)) as Record<string, unknown>) : ((row.changes ?? {}) as Record<string, unknown>);
    fix = await startPreviewFix(env, companyId, {
      previewId,
      taskId,
      pageUrl,
      notes: notes!,
      level: fixBy,
      reviewUrl: row.review_key ? `${previewLink(pageUrl, previewId)}/review?key=${String(row.review_key)}` : null,
      changes,
    });
  }
  if (forcedSenior && fix && "fallback" in fix) {
    // Nobody could take the Senior Developer's go: the owner decides.
    const escalated = await escalateToOwner();
    if (escalated) return escalated;
  }
  const handedToDeveloper = fix !== null && "issueId" in fix;
  // On automatic client sign-off a passed preview parks the task on the client instead of handing it back to the agent.
  const sprintForSignoff = verdict === "pass" ? await db.getSprint(env.ctx.db, companyId, sprintId) : null;
  const autoSignoff = Boolean(sprintForSignoff && isAutoSignoff(sprintForSignoff));
  if (autoSignoff) {
    const outcome = await afterPreviewPassed(env, sprintForSignoff!, taskId, issueId);
    return { previewId, reviewStatus: "passed", clientCanOpen: true, signoff: "automatic", taskParked: outcome === "parked", next: "Set your review issue to done. The plugin drafts the approval email for the client and applies what they approve; nobody else needs to be woken." };
  }
  if (!handedToDeveloper) await resumeTaskAfterReview(env, companyId, taskId);
  if (issueId) {
    const text =
      verdict === "pass"
        ? `The Reviewer passed the preview of ${pageUrl} (${String(row.title)}).${notes ? ` Notes: ${reviewNoteExcerpt(notes, sprintId, previewId)}` : ""} It is now open to the client. Put the link on Needs you for the owner.`
        : handedToDeveloper
          ? `The Reviewer sent the preview of ${pageUrl} (${String(row.title)}) back for a BUILD problem:\n\n${reviewNoteExcerpt(notes!, sprintId, previewId)}\n\n${(fix as { builder: string }).builder} is fixing it (issue ${(fix as { issueId: string }).issueId}) and makes the corrected preview. This task stays parked; you are woken when the corrected preview passes the Reviewer. Do not make another preview meanwhile.`
          : `The Reviewer asked for changes to the preview of ${pageUrl} (${String(row.title)}):\n\n${reviewNoteExcerpt(notes!, sprintId, previewId)}\n\n${fix && "fallback" in fix ? `(It was meant for a developer but ${fix.fallback}.) ` : ""}Fix this and make a new preview; the client has not seen the old one.`;
    const woke = !handedToDeveloper;
    if ((await commentOn(env, companyId, issueId, text)) && woke) await wakeIssue(env.ctx, issueId, companyId, `Preview ${verdict === "pass" ? "passed" : "needs changes"}`);
  }
  return { previewId, reviewStatus: verdict === "pass" ? "passed" : "changes_needed", clientCanOpen: verdict === "pass", next: verdict === "pass" ? "Set your review issue to done." : handedToDeveloper ? "Set your review issue to done; a developer fixes the build problems and makes a new preview for you to check." : "Set your review issue to done; the SEO Specialist revises.", ...(handedToDeveloper ? { fixIssueId: (fix as { issueId: string }).issueId, fixedBy: (fix as { builder: string }).builder } : {}) };
}

export interface PreviewRow {
  id: string;
  pageUrl: string;
  title: string;
  status: string;
  reviewStatus: string;
  reviewNote: string | null;
  decisionNote: string | null;
  keptPct: number | null;
  addedWords: number | null;
  /** The check on the page as a visitor sees it has run. */
  renderedChecked: boolean;
  /** What the copy was built from: the rendered live page, or its source (old rows without a basis are source). */
  basis: "rendered" | "source";
  createdAt: string;
  expiresAt: string;
  url: string;
  reviewUrl: string | null;
  superseded: boolean;
  /** The sprint task and its issue (the Previews tab groups by task). */
  taskId: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  /** Which fields the proposal changes, in words the tab shows. */
  changedFields: string[];
  /** The proposed copy the drawer shows (no html: the proposal link shows the page). */
  changes: { title: string | null; metaDescription: string | null; h1: string | null; bodyMode: string | null };
  /** Why the SEO agent proposes it. */
  why: string | null;
  decidedBy: string | null;
  decisionSource: string | null;
  decidedAt: string | null;
  confirmedAt: string | null;
  appliedAt: string | null;
  /** Pending and past its expiry: nobody decided in time. */
  expired: boolean;
  /** Other pending previews of the same page (read-only note, no gating). */
  overlapIds: string[];
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

const CHANGE_FIELDS: Array<[string, string]> = [["title", "Title"], ["metaDescription", "Meta description"], ["h1", "Heading"], ["bodyHtml", "Body copy"], ["css", "Styles"], ["linkEdits", "Links"]];

/** The sprint's previews for the SEO page (staff only: includes the review link). A newer preview of the same page supersedes older ones. */
export async function previewRows(env: Env, companyId: string, sprintId: string): Promise<PreviewRow[]> {
  const rows = await env.ctx.db.query(
    `SELECT p.id, p.page_url, p.title, p.status, p.review_status, p.review_note, p.decision_note, p.review_key, p.stats, p.created_at, p.expires_at,
        p.task_id, COALESCE(p.issue_id, st.issue_id) AS issue_id, st.issue_identifier, p.changes, p.decided_by, p.decision_source, p.decided_at,
        p.confirmed_at, p.applied_at, (p.status = 'pending' AND p.expires_at <= now()) AS expired
      FROM ${t("previews")} p LEFT JOIN ${t("sprint_tasks")} st ON st.id = p.task_id
      WHERE p.company_id = $1 AND p.sprint_id = $2 AND p.status <> 'cancelled' ORDER BY p.created_at DESC LIMIT 200`,
    [companyId, sprintId],
  );
  const seen = new Set<string>();
  const iso = (v: unknown): string | null => (v == null ? null : (v instanceof Date ? v : new Date(String(v))).toISOString());
  const livePending = rows.filter((r) => r.status === "pending" && !r.expired);
  return rows.map((r) => {
    const changes = (typeof r.changes === "string" ? JSON.parse(String(r.changes)) : (r.changes ?? {})) as Record<string, unknown>;
    const overlapIds = livePending.filter((o) => o.page_url === r.page_url && o.id !== r.id).map((o) => String(o.id));
    const stats = typeof r.stats === "string" ? (JSON.parse(String(r.stats)) as Record<string, number>) : ((r.stats ?? {}) as Record<string, number>);
    const rendered = (stats as unknown as { rendered?: { keptPct?: number; addedWords?: number } }).rendered;
    const page = String(r.page_url);
    const superseded = seen.has(page);
    seen.add(page);
    return {
      id: String(r.id),
      pageUrl: page,
      title: String(r.title),
      status: String(r.status),
      reviewStatus: String(r.review_status ?? "pending"),
      reviewNote: r.review_note ? String(r.review_note) : null,
      decisionNote: r.decision_note ? String(r.decision_note) : null,
      keptPct: typeof rendered?.keptPct === "number" ? rendered.keptPct : typeof stats.keptPct === "number" ? stats.keptPct : null,
      addedWords: typeof rendered?.addedWords === "number" ? rendered.addedWords : typeof stats.addedWords === "number" ? stats.addedWords : null,
      renderedChecked: Boolean(rendered),
      basis: basisOf(stats as { basis?: unknown }),
      createdAt: String(r.created_at),
      expiresAt: String(r.expires_at),
      url: previewLink(page, String(r.id)),
      reviewUrl: r.review_key ? `${previewLink(page, String(r.id))}/review?key=${String(r.review_key)}` : null,
      superseded,
      taskId: r.task_id ? String(r.task_id) : null,
      issueId: r.issue_id ? String(r.issue_id) : null,
      issueIdentifier: r.issue_identifier ? String(r.issue_identifier) : null,
      changedFields: CHANGE_FIELDS.filter(([key]) => Boolean(changes[key])).map(([, label]) => label),
      changes: { title: strOrNull(changes.title), metaDescription: strOrNull(changes.metaDescription), h1: strOrNull(changes.h1), bodyMode: changes.bodyHtml ? strOrNull(changes.bodyMode) ?? "before" : null },
      why: strOrNull(changes.why),
      decidedBy: r.decided_by ? String(r.decided_by) : null,
      decisionSource: r.decision_source ? String(r.decision_source) : null,
      decidedAt: iso(r.decided_at),
      confirmedAt: iso(r.confirmed_at),
      appliedAt: iso(r.applied_at),
      expired: Boolean(r.expired),
      overlapIds,
    };
  });
}

const LINK_RE = /preview\.partnersinbiz\.online\/p\/(?:[a-z0-9-]{1,30}\/)?([A-Za-z0-9_-]{20,64})/g;

/**
 * Nobody is asked to look at a preview that the Reviewer has not passed: a person or the client would be shown a
 * page nobody has compared with the live one. Scans everything the caller sent (reason, ask, copy, links).
 */
export async function assertPreviewLinksChecked(env: Env, companyId: string, params: Params): Promise<void> {
  const text = JSON.stringify(params);
  const ids = [...new Set([...text.matchAll(LINK_RE)].map((m) => m[1]!))];
  if (ids.length === 0) return;
  const rows = await env.ctx.db.query(`SELECT id, review_status, page_url FROM ${t("previews")} WHERE company_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`, [companyId, JSON.stringify(ids)]);
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const bad = ids.filter((id) => byId.get(id)?.review_status !== "passed");
  if (bad.length === 0) return;
  const lines = bad.map((id) => {
    const r = byId.get(id);
    return r ? `${String(r.page_url)} is ${String(r.review_status).replace(/_/g, " ")}` : `a link that is not one of this company's previews`;
  });
  throw new SeoError(`You linked a preview that has not been checked (${lines.join("; ")}). Nobody is asked to review a preview until the Reviewer has passed it. Make a new preview with create-preview if needed (list-previews shows the status), end your turn, and use only links of previews with reviewStatus passed.`);
}

/** The task waits for the Reviewer: parked (not the agent's to work) until the verdict arrives. */
async function parkTaskForReview(env: Env, companyId: string, taskId: string | null, title: string): Promise<void> {
  if (!taskId) return;
  const task = await db.getTask(env.ctx.db, companyId, taskId);
  if (!task || !task.issueId || (task.status !== "in_progress" && task.status !== "not_started")) return;
  if (!(await patchIssue(env, companyId, task.issueId, { status: "blocked" }))) return;
  await db.updateTask(env.ctx.db, companyId, task.id, { status: "blocked", issue_status: "blocked", assignee_kind: "reviewer", blocker_reason: `Waiting for the Reviewer to check the preview: ${title}` });
}

/** The Reviewer answered: the task goes back to the SEO agent. */
async function resumeTaskAfterReview(env: Env, companyId: string, taskId: string | null): Promise<void> {
  if (!taskId) return;
  const task = await db.getTask(env.ctx.db, companyId, taskId);
  if (!task || !task.issueId || task.status !== "blocked" || task.assigneeKind !== "reviewer") return;
  if (!(await patchIssue(env, companyId, task.issueId, { status: "todo" }))) return;
  await db.updateTask(env.ctx.db, companyId, task.id, { status: "in_progress", issue_status: "todo", assignee_kind: "agent", blocker_reason: null });
}

/** Rounds of Reviewer changes on one page before the owner is asked instead. */
export const MAX_REVIEW_ROUNDS = 2;

async function escalateStuckPreview(env: Env, companyId: string, sprintId: string, taskId: string, pageUrl: string, title: string, notes: string, rounds: number, reviewedPreviewId?: string): Promise<boolean> {
  try {
    const { sprint } = await loadSprintContext(env, companyId, sprintId);
    // Automatic client sign-off: the plugin decides. A page that has failed the Senior Developer's go too is dropped from the task, and the
    // task finishes with the other pages (one quiet line for the owner to revisit), instead of stopping everything for a person.
    if (isAutoSignoff(sprint)) return await dropFailingPage(env, sprint, taskId, pageUrl, title, notes, rounds, reviewedPreviewId);
    const info = await companyInfo(env, companyId);
    await addNeedsYou(env, info, sprint, {
      key: `preview-stuck:${taskId}:${pageUrl}`.slice(0, 120),
      kind: "task",
      title: `Preview of ${pageUrl} keeps failing the check`,
      why: `The Reviewer has sent the preview "${title}" back ${rounds} times. Last reason: ${notes}`.slice(0, 1500),
      steps: ["Read the Reviewer's notes on the preview (SEO page, Content tab, Client previews).", "Decide: tell the SEO Specialist what to do differently, fix the underlying problem (for example a fact the client must confirm), or skip this page.", "Mark this item done to send the task back to the SEO Specialist."],
      links: [],
      after: "Sends the task back to the SEO Specialist.",
      check: "manual",
      taskIds: [taskId],
    });
    return true;
  } catch (error) {
    env.ctx.logger.info("SEO stuck preview escalation failed", { taskId, error: errorMessage(error) });
    return false;
  }
}

/**
 * A page that kept failing the Reviewer, the Senior Developer's go included, on a sprint with automatic client sign-off: its previews are
 * withdrawn (expired, so the client never sees them), the task carries on with its other pages and the agent is told not to try the page
 * again. The owner gets one quiet, optional line to revisit it later; nothing waits for a person.
 */
export async function dropFailingPage(env: Env, sprint: db.Sprint, taskId: string, pageUrl: string, title: string, notes: string, rounds: number, reviewedPreviewId?: string): Promise<boolean> {
  const companyId = sprint.companyId;
  const task = await db.getTask(env.ctx.db, companyId, taskId);
  if (!task || !task.issueId) return false;
  // A newer preview of the page (a revision made while this one was being reviewed) is not part of this failure: it is left alone and the page is
  // not dropped. Dropping expired every pending preview of the page and killed the fresh one, which then failed as "expired before review"
  // and dropped the page again (found on Agri Auctions SA, 2026-10-05/06).
  if (reviewedPreviewId) {
    const newer = await env.ctx.db.query(
      `SELECT 1 FROM ${t("previews")} n WHERE n.company_id = $1 AND n.sprint_id = $2 AND n.page_url = $3 AND n.expires_at > now() AND n.status = 'pending' AND n.review_status IN ('pending', 'passed')
         AND n.created_at > (SELECT created_at FROM ${t("previews")} WHERE id = $4) LIMIT 1`,
      [companyId, sprint.id, pageUrl, reviewedPreviewId],
    );
    if (newer.length > 0) return true;
  }
  await env.ctx.db.execute(
    `UPDATE ${t("previews")} SET expires_at = now() WHERE company_id = $1 AND sprint_id = $2 AND page_url = $3 AND status = 'pending' AND expires_at > now()
       ${reviewedPreviewId ? `AND created_at <= (SELECT created_at FROM ${t("previews")} WHERE id = $4)` : ""}`,
    reviewedPreviewId ? [companyId, sprint.id, pageUrl, reviewedPreviewId] : [companyId, sprint.id, pageUrl],
  );
  const dropped = [...(((task.evidence ?? {}) as { droppedPages?: Array<Record<string, string>> }).droppedPages ?? []), { pageUrl, at: env.now().toISOString(), reason: notes.slice(0, 500) }];
  await db.updateTask(env.ctx.db, companyId, task.id, { evidence: { ...(task.evidence ?? {}), droppedPages: dropped } });
  const info = await companyInfo(env, companyId);
  await closeNeedsYouItems(env, info, sprint, [`preview-stuck:${taskId}:${pageUrl}`.slice(0, 120)], "plugin", "The page was dropped from the task after repeated failed previews.").catch(() => 0);
  await addNeedsYou(env, info, sprint, {
    key: `page-skipped:${taskId}:${pageUrl}`.slice(0, 120),
    kind: "task",
    title: `Skipped after ${rounds} failed previews: ${pageUrl}`,
    why: `"${title}" kept failing the Reviewer's check, the Senior Developer's go included, so it was dropped from "${task.title}" and the task carried on without it. Last reason: ${notes}`.slice(0, 1500),
    steps: ["Nothing is waiting on this. Revisit the page later: it may need copy the client has not provided yet, or a different approach (metadata only, or leave as is)."],
    links: [],
    after: "Nothing: the line is informational.",
    check: "manual",
    taskIds: [],
    optional: true,
    quiet: true,
  }).catch(() => undefined);
  await commentOn(env, companyId, task.issueId, `The page ${pageUrl} failed the Reviewer's check ${rounds} times, the Senior Developer's fix included, so it is DROPPED from this task: its previews are withdrawn and the client never sees them. Do not make another preview for it. Carry on with the task's other pages and complete the task when every other page is applied or dropped. Reason: ${notes.replace(/\s+/g, " ").slice(0, 400)}`, { dedupeKey: `dropped:${task.id}:${commentFingerprint(pageUrl)}` });
  // If everything else of the task is looked at and waiting for the client, park it there; otherwise the agent carries on.
  const outcome = await afterPreviewPassed(env, sprint, taskId, task.issueId);
  if (outcome !== "parked" && outcome !== "waiting") {
    await resumeTaskAfterReview(env, companyId, taskId);
    await wakeIssue(env.ctx, task.issueId, companyId, "A page was dropped from the task: carry on");
  }
  return true;
}

/**
 * A page that was put on the owner's list ("keeps failing the check") before the Senior Developer had a go: hand it to the Senior
 * Developer now and close the owner's line. Runs from the 5-minute job; a page the Senior Developer already tried stays with the
 * owner. Returns how many pages it handed over.
 */
export async function handStuckPreviewsToSenior(env: Env): Promise<number> {
  let handed = 0;
  const companies = await env.ctx.db.query(`SELECT DISTINCT company_id FROM ${t("sprints")} WHERE status = 'active'`);
  for (const c of companies) {
    const companyId = String(c.company_id);
    for (const digest of await db.openNeedsYouDigests(env.ctx.db, companyId)) {
      for (const item of digest.items) {
        if (item.status !== "open" || !item.key.startsWith("preview-stuck:")) continue;
        const taskId = (item.taskIds ?? [])[0];
        if (!taskId) continue;
        try {
          const task = await db.getTask(env.ctx.db, companyId, taskId);
          if (!task || !task.issueId) continue;
          const keyed = item.key.slice(`preview-stuck:${taskId}:`.length);
          const rows = await env.ctx.db.query(
            `SELECT id, page_url, changes, review_note, review_key FROM ${t("previews")} WHERE company_id = $1 AND task_id = $2 AND page_url LIKE $3 AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1`,
            [companyId, taskId, `${keyed}%`],
          );
          const row = rows[0];
          if (!row) continue;
          const pageUrl = String(row.page_url);
          if (seniorTried(task, pageUrl)) {
            // The Senior Developer already had its go: on a sprint with automatic sign-off the page is dropped instead of waiting for a person.
            const { sprint: owning } = await loadSprintContext(env, companyId, digest.sprintId);
            if (isAutoSignoff(owning) && (await dropFailingPage(env, owning, taskId, pageUrl, item.title, item.why, MAX_REVIEW_ROUNDS, String(row.id)))) handed += 1;
            continue;
          }
          const changes = typeof row.changes === "string" ? (JSON.parse(String(row.changes)) as Record<string, unknown>) : ((row.changes ?? {}) as Record<string, unknown>);
          const fix = await startPreviewFix(env, companyId, {
            previewId: String(row.id),
            taskId,
            pageUrl,
            notes: String(row.review_note ?? item.why),
            level: "senior",
            reviewUrl: row.review_key ? `${previewLink(pageUrl, String(row.id))}/review?key=${String(row.review_key)}` : null,
            changes,
          });
          if (!("issueId" in fix)) continue;
          const { sprint } = await loadSprintContext(env, companyId, digest.sprintId);
          const info = await companyInfo(env, companyId);
          await closeNeedsYouItems(env, info, sprint, [item.key], "plugin", `Handed to ${fix.builder}: the Senior Developer gets one go before the owner decides.`);
          await commentOn(env, companyId, task.issueId, `The preview of ${pageUrl} kept failing the Reviewer's check. ${fix.builder} (Senior Developer) is fixing it (issue ${fix.issueId}) and makes the corrected preview; this task stays parked. You are woken when it passes the Reviewer.`);
          handed += 1;
        } catch (error) {
          env.ctx.logger.info("SEO stuck preview not handed to the Senior Developer", { key: item.key, error: errorMessage(error) });
        }
      }
    }
  }
  return handed;
}

/** A review that nobody has answered for this long is nudged (the Reviewer's run may have lost its tools to a worker reload, or crashed). */
export const REVIEW_STALL_MINUTES = 30;
export const REVIEW_MAX_NUDGES = 3;

/**
 * Previews still waiting for a verdict after REVIEW_STALL_MINUTES: the review issue is reopened for the Reviewer and the Reviewer is
 * woken again (a review that was handed to another agent, set to in_review or closed without recording a verdict comes back). At most
 * REVIEW_MAX_NUDGES nudges, REVIEW_STALL_MINUTES apart; after that the owner is asked once. Runs from the 5-minute job.
 */
export async function nudgeStalledReviews(env: Env): Promise<number> {
  const rows = await env.ctx.db.query(
    `SELECT id, company_id, sprint_id, task_id, page_url, title, review_issue_id, stats FROM ${t("previews")}
      WHERE review_status = 'pending' AND review_issue_id IS NOT NULL AND status = 'pending' AND expires_at > now()
        AND created_at < now() - ($1::int * interval '1 minute')
        AND NOT EXISTS (SELECT 1 FROM ${t("previews")} n WHERE n.sprint_id = ${t("previews")}.sprint_id AND n.page_url = ${t("previews")}.page_url AND n.status <> 'cancelled' AND n.created_at > ${t("previews")}.created_at)
      ORDER BY created_at LIMIT 20`,
    [REVIEW_STALL_MINUTES],
  );
  let nudged = 0;
  for (const row of rows) {
    const companyId = String(row.company_id);
    const previewId = String(row.id);
    try {
      const stats = typeof row.stats === "string" ? (JSON.parse(String(row.stats)) as Record<string, any>) : ((row.stats ?? {}) as Record<string, any>);
      const nudges = Number(stats.reviewNudges ?? 0);
      const last = stats.reviewNudgedAt ? new Date(String(stats.reviewNudgedAt)).getTime() : 0;
      if (nudges >= REVIEW_MAX_NUDGES || env.now().getTime() - last < REVIEW_STALL_MINUTES * 60_000) continue;
      const reviewIssueId = String(row.review_issue_id);
      const issue = await getIssue(env, companyId, reviewIssueId);
      if (!issue) continue;
      const reviewer = await reviewerAgentId(env.ctx, companyId);
      const sprint = await db.getSprint(env.ctx.db, companyId, String(row.sprint_id));
      if (!sprint || sprint.status !== "active" || isRehearsalSprint(sprint)) continue;
      await patchIssue(env, companyId, reviewIssueId, { status: "todo", ...(reviewer ? { assigneeAgentId: reviewer, assigneeUserId: null } : {}) } as Parameters<typeof patchIssue>[3]);
      await commentOn(
        env,
        companyId,
        reviewIssueId,
        `Nobody has recorded a verdict on this preview for ${REVIEW_STALL_MINUTES}+ minutes (attempt ${nudges + 1} of ${REVIEW_MAX_NUDGES}). Check it again and record the verdict with partnersinbiz.seo:review-preview (sprintId ${String(row.sprint_id)}, previewId ${previewId}); the tool may have been unavailable to the earlier run while the SEO plugin reloaded. If the tool is still missing, say so in a comment and end your turn: the plugin tries again. The review page link is in this issue's description.`,
        { dedupeKey: `review-nudge:${previewId}:${nudges}` },
      );
      await wakeIssue(env.ctx, reviewIssueId, companyId, "A client preview is still waiting for a verdict");
      await env.ctx.db.execute(`UPDATE ${t("previews")} SET stats = stats || $2::jsonb WHERE id = $1`, [previewId, JSON.stringify({ reviewNudges: nudges + 1, reviewNudgedAt: env.now().toISOString() })]);
      nudged += 1;
      if (nudges + 1 >= REVIEW_MAX_NUDGES) {
        const info = await companyInfo(env, companyId);
        await addNeedsYou(env, info, sprint, {
          key: `review-stalled:${previewId}`.slice(0, 120),
          kind: "task",
          title: `A preview has waited for the Reviewer through ${REVIEW_MAX_NUDGES} tries: ${String(row.page_url)}`,
          why: `The Reviewer was asked ${REVIEW_MAX_NUDGES} times to check "${String(row.title)}" and has not recorded a verdict. The review issue is ${reviewIssueId}.`,
          steps: ["Open the review issue and see what the Reviewer said (a tool missing, a crashed run).", "Fix the cause, or record the verdict yourself on the preview (SEO page, Content tab)."],
          links: [],
          after: "The preview is checked and the client is asked as usual.",
          check: "manual",
          taskIds: [],
        }).catch(() => undefined);
      }
    } catch (error) {
      env.ctx.logger.info("SEO stalled review not nudged", { previewId, error: errorMessage(error) });
    }
  }
  return nudged;
}

/** A page the Reviewer sent back with nobody working on it this long is handed back to the SEO agent. */
export const CHANGES_ORPHAN_MINUTES = 30;
export const CHANGES_MAX_REVIVALS = 3;

/**
 * Pages whose newest preview the Reviewer sent back (changes needed) and that nobody is working on: no developer fix open for the
 * page, and the task is parked (on the Reviewer or the client) instead of with the agent. The task goes back to the SEO agent with
 * the list of pages and the Reviewer's reasons, and the agent is woken once per task. A task covering many pages is parked on the
 * client for the pages that passed while other pages were sent back: this is what keeps those pages from being forgotten.
 * Runs from the 5-minute job; returns how many tasks it handed back.
 */
export async function reviveOrphanedChanges(env: Env): Promise<number> {
  const rows = await env.ctx.db.query(
    `SELECT id, company_id, sprint_id, task_id, page_url, review_note, stats FROM (
        SELECT DISTINCT ON (sprint_id, page_url) id, company_id, sprint_id, task_id, page_url, review_note, review_status, status, reviewed_at, expires_at, stats
          FROM ${t("previews")} WHERE status <> 'cancelled' ORDER BY sprint_id, page_url, created_at DESC
      ) latest
      WHERE review_status = 'changes_needed' AND status = 'pending' AND task_id IS NOT NULL AND expires_at > now()
        AND reviewed_at < now() - ($1::int * interval '1 minute') ORDER BY reviewed_at LIMIT 40`,
    [CHANGES_ORPHAN_MINUTES],
  );
  const byTask = new Map<string, Array<Record<string, any>>>();
  for (const r of rows) {
    const list = byTask.get(String(r.task_id)) ?? [];
    list.push(r);
    byTask.set(String(r.task_id), list);
  }
  let handed = 0;
  for (const [taskId, previews] of byTask) {
    const first = previews[0]!;
    const companyId = String(first.company_id);
    try {
      const task = await db.getTask(env.ctx.db, companyId, taskId);
      if (!task || !task.issueId || (task.status !== "blocked" && task.status !== "in_progress" && task.status !== "not_started")) continue;
      const sprint = await db.getSprint(env.ctx.db, companyId, task.sprintId);
      if (!sprint || sprint.status !== "active" || isRehearsalSprint(sprint)) continue;
      // The agent already has the task, or a developer is on one of its fixes (the fix issue is still open).
      if (task.status === "in_progress" && task.assigneeKind === "agent") continue;
      const open: string[] = [];
      for (const p of previews) {
        const stats = typeof p.stats === "string" ? (JSON.parse(String(p.stats)) as Record<string, any>) : ((p.stats ?? {}) as Record<string, any>);
        const revivals = Number(stats.revivals ?? 0);
        const last = stats.revivedAt ? new Date(String(stats.revivedAt)).getTime() : 0;
        if (revivals >= CHANGES_MAX_REVIVALS || env.now().getTime() - last < CHANGES_ORPHAN_MINUTES * 60_000) continue;
        const fixes = (typeof task.evidence === "object" && task.evidence ? ((task.evidence as { builds?: Array<{ issueId: string; pageUrl?: string; kind?: string }> }).builds ?? []) : []).filter((b) => b.kind === "preview-fix" && b.pageUrl === String(p.page_url));
        let fixOpen = false;
        for (const f of fixes) {
          const issue = await getIssue(env, companyId, f.issueId);
          if (issue && !["done", "cancelled"].includes(String(issue.status))) fixOpen = true;
        }
        if (!fixOpen) open.push(String(p.id));
      }
      if (open.length === 0) continue;
      const chosen = previews.filter((p) => open.includes(String(p.id)));
      if (task.status === "blocked" && !(await patchIssue(env, companyId, task.issueId, { status: "todo" }))) continue;
      await db.updateTask(env.ctx.db, companyId, task.id, { status: "in_progress", issue_status: "todo", assignee_kind: "agent", blocker_reason: null });
      const lines = chosen.map((p) => `- ${String(p.page_url)}: ${String(p.review_note ?? "see the Reviewer's note on the preview (list-previews)").replace(/\s+/g, " ").slice(0, 280)}`);
      await commentOn(
        env,
        companyId,
        task.issueId,
        `The Reviewer sent ${chosen.length === 1 ? "this page" : "these pages"} back and nobody has revised ${chosen.length === 1 ? "it" : "them"} (${CHANGES_ORPHAN_MINUTES}+ minutes). Revise ${chosen.length === 1 ? "it" : "each"} and make a new preview (the Reviewer checks it; the pages that already passed stay as they are):\n${lines.join("\n")}\nUse partnersinbiz.seo:get-client-facts and propose-client-facts for any claim; keep the client's own wording.`,
        { dedupeKey: `revive:${task.id}:${commentFingerprint(lines.join("|"))}` },
      );
      await wakeIssue(env.ctx, task.issueId, companyId, "Pages the Reviewer sent back need revising");
      for (const p of chosen) {
        await env.ctx.db.execute(`UPDATE ${t("previews")} SET stats = stats || $2::jsonb WHERE id = $1`, [String(p.id), JSON.stringify({ revivals: Number((typeof p.stats === "string" ? JSON.parse(String(p.stats)) : p.stats ?? {}).revivals ?? 0) + 1, revivedAt: env.now().toISOString() })]);
      }
      handed += 1;
    } catch (error) {
      env.ctx.logger.info("SEO orphaned changes not handed back", { taskId, error: errorMessage(error) });
    }
  }
  return handed;
}

/** A passed preview that was never put in front of the client this long is stale: the live page may have changed since it was built. */
export const PREVIEW_STALE_HOURS = 48;

/**
 * On a sprint with automatic client sign-off, previews that passed the Reviewer but were never put in a draft (so never in front of the
 * client) within PREVIEW_STALE_HOURS are withdrawn, and their task goes back to the SEO agent to rebuild them from the current live page.
 * Found when Hunt and Gun was restarted: two previews from 2 October, built before the live site was changed on 4 October, would otherwise
 * have been sent for approval. Previews already in a draft keep their 30 days (the client has them). Runs from the 5-minute job.
 */
export async function refreshStalePreviews(env: Env): Promise<number> {
  const rows = await env.ctx.db.query(
    `SELECT id, company_id, sprint_id, task_id, page_url FROM (
        SELECT DISTINCT ON (sprint_id, page_url) id, company_id, sprint_id, task_id, page_url, review_status, status, draft_key, created_at, expires_at
          FROM ${t("previews")} WHERE status <> 'cancelled' ORDER BY sprint_id, page_url, created_at DESC
      ) latest
      WHERE review_status = 'passed' AND status = 'pending' AND draft_key IS NULL AND task_id IS NOT NULL AND expires_at > now()
        AND created_at < now() - ($1::int * interval '1 hour') LIMIT 40`,
    [PREVIEW_STALE_HOURS],
  );
  const byTask = new Map<string, Array<Record<string, any>>>();
  for (const r of rows) {
    const list = byTask.get(String(r.task_id)) ?? [];
    list.push(r);
    byTask.set(String(r.task_id), list);
  }
  let refreshed = 0;
  for (const [taskId, previews] of byTask) {
    const companyId = String(previews[0]!.company_id);
    try {
      const task = await db.getTask(env.ctx.db, companyId, taskId);
      if (!task || !task.issueId || !["blocked", "in_progress", "not_started"].includes(task.status)) continue;
      const sprint = await db.getSprint(env.ctx.db, companyId, task.sprintId);
      if (!sprint || sprint.status !== "active" || !isAutoSignoff(sprint)) continue;
      for (const p of previews) {
        await env.ctx.db.execute(`UPDATE ${t("previews")} SET expires_at = now() WHERE id = $1 AND status = 'pending'`, [String(p.id)]);
      }
      const needsAgent = !(task.status === "in_progress" && task.assigneeKind === "agent");
      if (needsAgent) {
        if (task.status === "blocked" && !(await patchIssue(env, companyId, task.issueId, { status: "todo" }))) continue;
        await db.updateTask(env.ctx.db, companyId, task.id, { status: "in_progress", issue_status: "todo", assignee_kind: "agent", blocker_reason: null });
      }
      await commentOn(
        env,
        companyId,
        task.issueId,
        `${previews.length === 1 ? "A preview" : `${previews.length} previews`} passed the Reviewer more than ${PREVIEW_STALE_HOURS} hours ago but never reached the client, so ${previews.length === 1 ? "it is" : "they are"} withdrawn: the live page may have changed since. Make a fresh preview from the CURRENT live page for ${previews.length === 1 ? "this page" : "each page"} (the Reviewer checks it again):\n${previews.map((p) => `- ${String(p.page_url)}`).join("\n")}`,
        { dedupeKey: `stale:${task.id}:${commentFingerprint(previews.map((p) => String(p.id)).join("|"))}` },
      );
      if (needsAgent) await wakeIssue(env.ctx, task.issueId, companyId, "Stale previews were withdrawn: rebuild them");
      refreshed += previews.length;
    } catch (error) {
      env.ctx.logger.info("SEO stale previews not refreshed", { taskId, error: errorMessage(error) });
    }
  }
  return refreshed;
}

/** unchanged | changed (with the fields) | unknown (no stored fingerprint, or the live page could not be read) (PAR-9006). */
async function liveCheckOf(env: Env, pageUrl: string, stored: LiveFingerprint | undefined): Promise<{ result: "unchanged" | "changed" | "unknown"; fields?: string[]; reason?: string }> {
  if (!stored || typeof stored.title !== "string") return { result: "unknown", reason: "This preview has no stored copy of the live page (made before the check existed)." };
  let res: Awaited<ReturnType<Env["site"]>>;
  try {
    res = await env.site(pageUrl, { maxChars: MAX_HTML });
  } catch (error) {
    return { result: "unknown", reason: `The live page could not be read: ${errorMessage(error)}` };
  }
  if (res.status >= 400 || !res.text) return { result: "unknown", reason: `The live page answered ${res.status}.` };
  const fields = fingerprintChanges(stored, liveFingerprint(res.text));
  return fields.length ? { result: "changed", fields } : { result: "unchanged" };
}
