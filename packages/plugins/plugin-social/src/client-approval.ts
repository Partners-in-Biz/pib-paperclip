/**
 * The client's approval of a post (Q1a-2), following the SEO preview-service pattern.
 *
 * 1. `request-client-approval` (an agent, or a person from the page) freezes what the
 *    client will see into a row (`client_approvals.snapshot`), mints a random token and
 *    returns a link: `<approvalBaseUrl>/<token>`. Only the token's SHA-256 is stored, so
 *    reading the table never yields a live link. The link is HELD until the Reviewer
 *    passed the post when the policy asks for that, and it only ever approves the exact
 *    version it was made from (`content_hash`).
 * 2. The link goes to the client in an email DRAFT in the Mailbox (a person sends it;
 *    nothing here sends mail).
 * 3. The client opens the page (ops/approval-server, its own small service with its own
 *    database role that can read the snapshot and write only the answer columns) and
 *    approves or asks for changes.
 * 4. The `client-answers` job (every 5 minutes) applies each answer once: it records the
 *    client's verdict, comments on the post's review issue and wakes the Social agent,
 *    and approves the post when the policy's other sign-offs are in. An answer for a
 *    version that has since changed is not applied (it says so on the issue).
 */
import { randomBytes } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getCrmContact, listCrmContactsAtCompany, routeWork, type WorkRoute } from "@partnersinbiz/pib-plugin-kit";
import { afterSignoff, recordSignoff, sendBackForChanges, signoffState, withSignoff } from "./approval-flow.js";
import { scopeOfRow } from "./clients.js";
import { DEFAULT_APPROVAL_BASE, loadSocialConfig, type SocialConfig } from "./config.js";
import { postFingerprint, sha256Hex } from "./content-hash.js";
import { getAccountsByIds, getPost, iso, postMedia, table, type PostRow } from "./db.js";
import { clip, SocialError } from "./domain.js";
import { createIssueSafely, ORIGIN_KIND, projectIdForRow, SOCIAL_ORIGINS, scopeLine } from "./issues.js";
import { socialOn } from "./modules.js";
import { handToSocialAgent, issueOpen, reviewIssueOf, type ReviewActor } from "./review.js";
import { isSocialPlatform, PLATFORM_LABELS } from "./platforms.js";
import { buildPublishRequest } from "./publish.js";
import { validatePostRow } from "./validate.js";

export { DEFAULT_APPROVAL_BASE };
export const APPROVAL_TOKEN_BYTES = 32;
const SNAPSHOT_VERSION = 1;

/** A fresh link token: 32 random bytes, URL-safe. */
export function newToken(): string {
  return randomBytes(APPROVAL_TOKEN_BYTES).toString("base64url");
}

/** What is stored and looked up: the token's SHA-256 (hex). The service hashes the token in the URL the same way. */
export function hashToken(token: string): string {
  return sha256Hex(token);
}

export function approvalBase(config: Pick<SocialConfig, "approvalBaseUrl">): string {
  const base = config.approvalBaseUrl.replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base)) throw new SocialError("The client approval page address (Social settings → Client approval page) must start with https://");
  return base;
}

/**
 * `approvalBase` as a result instead of an exception: a typo in an OPTIONAL setting must show up as a fact on the Setup checklist and
 * in the Cockpit, never as an error that takes the whole page down. `base` is the address as saved either way. Pure.
 */
export function checkedApprovalBase(config: Pick<SocialConfig, "approvalBaseUrl">): { ok: true; base: string } | { ok: false; base: string; error: string } {
  try {
    return { ok: true, base: approvalBase(config) };
  } catch {
    return { ok: false, base: config.approvalBaseUrl.replace(/\/+$/, ""), error: "the address must start with https://" };
  }
}

export function approvalUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/${token}`;
}

// ── what the client sees ────────────────────────────────────────────────────

export interface ApprovalSnapshot {
  version: number;
  /** The company sending the post (shown on the page). */
  poster: string;
  clientName: string | null;
  timezone: string;
  scheduledAt: string | null;
  firstComment: string | null;
  media: Array<{ url: string; kind: "image" | "video"; altText: string | null }>;
  destinations: Array<{ platform: string; label: string; account: string; text: string; title: string | null; link: string | null }>;
}

/** The post as it will publish, frozen for the approval page. Only https media is shown. Pure over its inputs. */
export function snapshotOf(input: {
  post: Pick<PostRow, "body" | "first_comment" | "overrides" | "media" | "scheduled_at">;
  accounts: Array<{ platform: string; display_name: string }>;
  poster: string;
  clientName: string | null;
  timezone: string;
}): ApprovalSnapshot {
  const destinations = input.accounts
    .filter((a) => isSocialPlatform(a.platform))
    .map((a) => {
      const request = buildPublishRequest(input.post, a.platform as never);
      return {
        platform: a.platform,
        label: PLATFORM_LABELS[a.platform as keyof typeof PLATFORM_LABELS] ?? a.platform,
        account: a.display_name,
        text: request.text,
        title: request.title ?? null,
        link: request.link ?? null,
      };
    });
  return {
    version: SNAPSHOT_VERSION,
    poster: input.poster,
    clientName: input.clientName,
    timezone: input.timezone,
    scheduledAt: iso(input.post.scheduled_at),
    firstComment: input.post.first_comment?.trim() || null,
    media: postMedia(input.post).filter((m) => /^https:\/\//i.test(m.url)).map((m) => ({ url: m.url, kind: m.kind, altText: m.altText })),
    destinations,
  };
}

// ── the email draft ─────────────────────────────────────────────────────────

export interface EmailDraft {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The email that goes with the link (a Mailbox draft a person sends). Plain, no tracking, no marketing. Pure. */
export function approvalEmailDraft(input: { poster: string; clientName: string | null; recipientName: string | null; url: string; expiresAt: string; snippet: string; timezone: string }): EmailDraft {
  const first = input.recipientName?.trim().split(/\s+/)[0] || "there";
  const until = (() => {
    try {
      return new Intl.DateTimeFormat("en-ZA", { timeZone: input.timezone, day: "numeric", month: "long", year: "numeric" }).format(new Date(input.expiresAt));
    } catch {
      return input.expiresAt.slice(0, 10);
    }
  })();
  const subject = `Please approve your social media post${input.clientName ? ` for ${input.clientName}` : ""}`;
  const lines = [
    `Hi ${first},`,
    "",
    `We have prepared a social media post${input.clientName ? ` for ${input.clientName}` : ""}: "${input.snippet}"`,
    "",
    "Please open the link below to see exactly how it will look. You can approve it, or ask us for changes. Nothing is posted until you approve.",
    "",
    input.url,
    "",
    `The link works until ${until}. If you would rather reply to this email with your changes, that works too.`,
    "",
    "Thank you,",
    input.poster,
  ];
  const text = lines.join("\n");
  const html = `<p>Hi ${escapeHtml(first)},</p><p>We have prepared a social media post${input.clientName ? ` for ${escapeHtml(input.clientName)}` : ""}: &ldquo;${escapeHtml(input.snippet)}&rdquo;</p><p>Please open the link below to see exactly how it will look. You can approve it, or ask us for changes. Nothing is posted until you approve.</p><p><a href="${escapeHtml(input.url)}">${escapeHtml(input.url)}</a></p><p>The link works until ${escapeHtml(until)}. If you would rather reply to this email with your changes, that works too.</p><p>Thank you,<br>${escapeHtml(input.poster)}</p>`;
  return { subject, text, html };
}

// ── is the page there? ──────────────────────────────────────────────────────

const healthCache = new Map<string, { at: number; ok: boolean; error?: string }>();

/** Whether the client approval page answers (`<base>/health` says ok). Cached for a minute; a failure is cached shorter. */
export async function approvalServiceHealth(ctx: PluginContext, base: string, now: number = Date.now()): Promise<{ ok: boolean; error?: string }> {
  const hit = healthCache.get(base);
  if (hit && now - hit.at < (hit.ok ? 60_000 : 20_000)) return { ok: hit.ok, ...(hit.error ? { error: hit.error } : {}) };
  let result: { ok: boolean; error?: string };
  try {
    const response = await ctx.http.fetch(`${base}/health`, { method: "GET" });
    const body = typeof response.text === "function" ? await response.text() : "";
    result = response.ok && body.trim() === "ok" ? { ok: true } : { ok: false, error: `the page answered ${response.status}` };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160) };
  }
  healthCache.set(base, { at: now, ...result });
  return result;
}

/** Forgets cached health answers (tests). */
export function clearApprovalHealthCache(): void {
  healthCache.clear();
}

// ── who to send it to ───────────────────────────────────────────────────────

export interface Recipient {
  name: string;
  email: string;
}

/** The people at the client with an email address (CRM projection): a company's contacts, or the contact itself. */
export async function clientRecipients(ctx: PluginContext, companyId: string, post: Pick<PostRow, "client_kind" | "client_ref">): Promise<Recipient[]> {
  const scope = scopeOfRow(post);
  if (!scope) return [];
  try {
    if (scope.kind === "contact") {
      const row = await getCrmContact(ctx, ctx.db.namespace, companyId, scope.id);
      return row?.emails[0] ? [{ name: row.name, email: row.emails[0] }] : [];
    }
    const rows = await listCrmContactsAtCompany(ctx, ctx.db.namespace, companyId, scope.id);
    return rows.filter((row) => row.emails[0]).slice(0, 8).map((row) => ({ name: row.name, email: row.emails[0]! }));
  } catch (error) {
    ctx.logger.info("Client contacts unavailable", { companyId, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

// ── making a link ───────────────────────────────────────────────────────────

export interface RequestInput {
  /** The calling agent's id, or the person's user id: who made the link. */
  createdBy: string | null;
  /** The email address the link is meant for (kept on the record). */
  recipientEmail?: string | null;
  /**
   * Who drafts the Mailbox email. `account-manager`: the plugin opens a drafting task for the Account Manager (who holds a mailbox
   * delegation); `me`: the calling agent drafts it. Left out, an agent gets `account-manager` when the company has an Account
   * Manager (the Social agent usually has no mailbox delegation, so drafting itself would fail), else `me`.
   */
  draft?: "me" | "account-manager";
  /** True for an agent: the answer comes back to its review issue and it is told how to send the link. */
  byAgent: boolean;
}

export interface RequestedApproval {
  approvalId: string;
  postId: string;
  client: string | null;
  url: string;
  expiresAt: string;
  recipients: Recipient[];
  email: EmailDraft;
  draftIssueId: string | null;
  next: string;
}

function stampPlus(days: number, now: Date): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

/** Who drafts the client's email: the Account Manager (or whoever the kit routes to), or nobody. */
async function draftRoute(ctx: PluginContext, companyId: string): Promise<WorkRoute | null> {
  const route = await routeWork(ctx, companyId, ["account-manager"]).catch(() => null);
  return route && (route.assigneeAgentId || route.assigneeUserId) ? route : null;
}

async function openDraftTask(
  ctx: PluginContext,
  companyId: string,
  post: PostRow,
  route: WorkRoute,
  info: { url: string; expiresAt: string; recipients: Recipient[]; email: EmailDraft },
): Promise<string | null> {
  const parent = await reviewIssueOf(ctx, companyId, post.id);
  const issue = await createIssueSafely(ctx, {
    companyId,
    projectId: await projectIdForRow(ctx, companyId, post),
    ...(parent ? { parentId: parent } : {}),
    title: `${post.client_name ? `[${post.client_name}] ` : ""}Draft the approval email for a social post`,
    description: [
      "The client has to approve a social post. Create a Mailbox DRAFT (never send it: a person sends it) with `partnersinbiz.mailbox:create-draft`:",
      "",
      `- To: ${info.recipients.length ? info.recipients.map((r) => `${r.name} <${r.email}>`).join(" or ") : "the client's contact (look it up in the CRM)"}`,
      `- Subject: ${info.email.subject}`,
      "- Body:",
      "",
      ...info.email.text.split("\n").map((line) => `> ${line}`),
      "",
      `The link works until ${info.expiresAt.slice(0, 10)}. Close this issue when the draft exists, then tell the owner once with \`partnersinbiz.cockpit:ask-owner\` (kind decision, link \`/mailbox\`) that it is ready to send.`,
      "",
      scopeLine(post),
    ].join("\n"),
    priority: "medium",
    originKind: ORIGIN_KIND,
    originId: `${SOCIAL_ORIGINS.clientLinkEmail}${post.id}`,
    ...(route.assigneeAgentId ? { assigneeAgentId: route.assigneeAgentId } : { assigneeUserId: route.assigneeUserId! }),
    wakeReason: "Draft the client's approval email",
  });
  return issue.id;
}

/**
 * Makes the client's link for a post in review. Checks, in order: the post is in review and
 * validates; the scope is a client whose policy asks for the client's approval; the Reviewer
 * passed this version when the policy asks for that; the approval page answers. An earlier
 * pending link for the post is superseded: only the newest counts.
 */
export async function requestClientApproval(ctx: PluginContext, companyId: string, post: PostRow, config: SocialConfig, input: RequestInput, now: Date = new Date()): Promise<RequestedApproval> {
  const scope = scopeOfRow(post);
  if (!scope) throw new SocialError("This is PiB's own post: it has no client to approve it.");
  if (post.status !== "review") throw new SocialError(`The post is ${post.status.replace("_", " ")}. Send it for review first (request-review); the client approves a post in review.`);
  const state = await signoffState(ctx, companyId, post);
  if (!state.policy.requireClient) throw new SocialError(`This client's policy does not ask for their approval (${state.policy.custom ? "set on Social → Posts → Who approves" : "the default: a team member approves"}). A person sets it; you cannot.`);
  if (state.policy.requireReviewer && state.signoffs.reviewer !== "approved") throw new SocialError("The Reviewer has not passed this version yet. The client's link is made after its pass; you are woken on the review issue.");
  const check = await validatePostRow(ctx, companyId, post);
  if (!check.ok) throw new SocialError(`Fix these before the client sees the post: ${check.problems.slice(0, 4).join("; ")}`);
  const base = approvalBase(config);
  const health = await approvalServiceHealth(ctx, base, now.getTime());
  if (!health.ok) {
    throw new SocialError(`The client approval page is not reachable (${health.error ?? "no answer"}), so a link would not open. This is a one-time setup for the owner: Setup → Social → "Client approval page". Do not send the client anything yet; ask once with partnersinbiz.cockpit:ask-owner.`);
  }
  // Who drafts the email is settled BEFORE the link exists, so a refusal here never leaves a wasted link behind.
  let draftBy: WorkRoute | null = null;
  if (input.byAgent && input.draft !== "me") {
    const route = await draftRoute(ctx, companyId);
    // Left out: the Account Manager when the company has one. Asked for by name: whoever the kit routes to (the Operator, the owner).
    if (input.draft === "account-manager" ? route : route?.via === "account-manager") draftBy = route;
    if (input.draft === "account-manager" && !route) {
      throw new SocialError("There is no Account Manager (or Operator, or owner) to draft the email. Draft it yourself with partnersinbiz.mailbox:create-draft (draft: \"me\"), or ask the owner to staff the role in Setup → Team.");
    }
  }
  const accounts = await getAccountsByIds(ctx, companyId, state.accountIds);
  const poster = ((await ctx.companies.get(companyId).catch(() => null)) as { name?: string } | null)?.name ?? "Your social media team";
  const snapshot = snapshotOf({ post, accounts, poster, clientName: post.client_name, timezone: config.timezone });
  const token = newToken();
  const id = newToken().slice(0, 24);
  const expiresAt = stampPlus(state.policy.linkExpiryDays, now);
  const approvals = table(ctx, "client_approvals");
  await ctx.db.execute(`UPDATE ${approvals} SET status = 'superseded' WHERE post_id = $1 AND company_id = $2 AND status = 'pending'`, [post.id, companyId]);
  await ctx.db.execute(
    `INSERT INTO ${approvals} (id, company_id, post_id, token_hash, client_kind, client_ref, client_name, recipient_email, content_hash, snapshot, expires_at, created_by, issue_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz, $12, $13)`,
    [
      id, companyId, post.id, hashToken(token), scope.kind, scope.id, post.client_name, input.recipientEmail?.trim().toLowerCase().slice(0, 200) || null, state.hash,
      JSON.stringify(snapshot), expiresAt, input.createdBy, await reviewIssueOf(ctx, companyId, post.id),
    ],
  );
  const url = approvalUrl(base, token);
  const recipients = await clientRecipients(ctx, companyId, post);
  const email = approvalEmailDraft({ poster, clientName: post.client_name, recipientName: recipients[0]?.name ?? null, url, expiresAt, snippet: clip(post.body.replace(/\s+/g, " ").trim(), 140), timezone: config.timezone });
  let draftIssueId: string | null = null;
  if (draftBy) draftIssueId = await openDraftTask(ctx, companyId, post, draftBy, { url, expiresAt, recipients, email });
  return {
    approvalId: id,
    postId: post.id,
    client: post.client_name,
    url,
    expiresAt,
    recipients,
    email,
    draftIssueId,
    next: input.byAgent
      ? draftIssueId
        ? "A drafting task was opened for the Account Manager, who holds the mailbox delegation. Do not email the link yourself and do not draft it too. End your turn: the review issue gets a comment when the client answers, and you are woken."
        : "Create a Mailbox DRAFT with partnersinbiz.mailbox:create-draft (to one of the recipients, this subject and text). NEVER send it: a person sends the draft. Then ask the owner once with partnersinbiz.cockpit:ask-owner (kind decision, link /mailbox) to send it, and end your turn. The review issue gets a comment when the client answers, and you are woken."
      : "Send the link to the client with the email text. Nothing is posted until they approve.",
  };
}

// ── listing ─────────────────────────────────────────────────────────────────

interface ApprovalListRow {
  id: string;
  status: string;
  client_name: string | null;
  recipient_email: string | null;
  answered_by_name: string | null;
  answer_note: string | null;
  answered_at: unknown;
  applied: string | null;
  expires_at: unknown;
  created_at: unknown;
  content_hash: string;
}

/** A post's client links, newest first: status and answer, never the link itself (only its hash is kept). */
export async function listClientApprovals(ctx: PluginContext, companyId: string, post: PostRow) {
  const rows = await ctx.db.query<ApprovalListRow>(
    `SELECT id, status, client_name, recipient_email, answered_by_name, answer_note, answered_at, applied, expires_at, created_at, content_hash
       FROM ${table(ctx, "client_approvals")} WHERE post_id = $1 AND company_id = $2 ORDER BY created_at DESC LIMIT 10`,
    [post.id, companyId],
  );
  const { hash } = await postFingerprint(ctx, post);
  return rows.map((row) => ({
    approvalId: row.id,
    status: row.status,
    current: row.content_hash === hash,
    sentTo: row.recipient_email,
    answeredBy: row.answered_by_name,
    note: row.answer_note,
    answeredAt: iso(row.answered_at),
    applied: row.applied,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
  }));
}

// ── applying answers (the `client-answers` job) ─────────────────────────────

interface AnsweredRow {
  id: string;
  company_id: string;
  post_id: string;
  status: string;
  content_hash: string;
  answered_by_name: string | null;
  answer_note: string | null;
  answered_at: unknown;
}

function when(value: unknown, timezone: string): string {
  const at = iso(value);
  if (!at) return "";
  try {
    return new Intl.DateTimeFormat("en-ZA", { timeZone: timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));
  } catch {
    return at;
  }
}

/** A plain comment on the post's review issue, when there is an open one. Nobody is woken: this is for what needs no action. */
async function note(ctx: PluginContext, companyId: string, postId: string, body: string): Promise<void> {
  try {
    const issueId = await reviewIssueOf(ctx, companyId, postId);
    if (!issueId || !(await issueOpen(ctx, companyId, issueId))) return;
    await ctx.issues.createComment(issueId, body, companyId);
  } catch (error) {
    ctx.logger.info("Client answer comment skipped", { postId, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Tells the Social agent something it has to act on (an answer for an older version, a link that ran out): the review issue comes
 * back to it and it is woken, whoever held the issue (an ask can leave it with the owner), and a fresh issue opens when the old one
 * was closed. Without that the agent would never hear of it.
 */
async function tellSocialAgent(ctx: PluginContext, companyId: string, post: PostRow, body: string): Promise<void> {
  await handToSocialAgent(ctx, companyId, post, { task: "client-approval", note: body, wakeReason: "The client answered a social post" });
}

/** Applies one answered link. Returns what was done, stored on the row (`applied`). */
export async function applyClientAnswer(ctx: PluginContext, row: AnsweredRow, timezone: string): Promise<string> {
  const companyId = row.company_id;
  const post = await getPost(ctx, companyId, row.post_id);
  if (!post) return "post_removed";
  const who = row.answered_by_name?.trim() || "The client";
  const stamp = when(row.answered_at, timezone);
  const verdict = row.status === "approved" ? "approved" : "asked for changes to";
  const lead = `**${who} ${verdict} the post** on the approval page${stamp ? ` (${stamp})` : ""}.${row.answer_note ? `\n\n> ${row.answer_note.replace(/\n/g, "\n> ")}` : ""}`;
  if (post.status !== "review") {
    await note(ctx, companyId, post.id, `${lead}\n\nThe post is ${post.status.replace("_", " ")}, not in review, so the answer was not applied.`);
    return "not_in_review";
  }
  const state = await signoffState(ctx, companyId, post);
  if (state.hash !== row.content_hash) {
    await tellSocialAgent(ctx, companyId, post, `${lead}\n\nThe post was changed after the link was made, so this answer does not count for the current version. Make a new link with \`request-client-approval\` and send it.`);
    return "stale";
  }
  const actor: ReviewActor = { companyId, userId: null, isAgent: false };
  if (row.status === "changes_requested") {
    await recordSignoff(ctx, companyId, post, state.hash, "client", "changes", "link", { name: row.answered_by_name }, row.answer_note);
    await sendBackForChanges(ctx, companyId, post, who === "The client" ? who : `The client (${who})`, row.answer_note?.trim() || "(no note was written)", true);
    return "changes";
  }
  await recordSignoff(ctx, companyId, post, state.hash, "client", "approved", "link", { name: row.answered_by_name }, row.answer_note);
  const progress = await afterSignoff(ctx, actor, post, withSignoff(state, "client"), `The client (${who})`, `${lead.replace(/\*\*/g, "")}`, lead);
  return progress.completed ? "approved" : `approved_waiting_${state.missing.filter((s) => s !== "client").join("+") || "none"}`;
}

export interface DeliverySummary {
  delivered: number;
  approved: number;
  changes: number;
  stale: number;
  failed: number;
  expired: number;
}

/**
 * Applies every answered, undelivered link of a company, once each (the row is claimed
 * with `notified_at` first; a failure releases the claim so the next run retries), then
 * closes links that ran out unanswered. Never throws.
 */
export async function deliverClientAnswers(ctx: PluginContext, companyId: string, timezone: string): Promise<DeliverySummary> {
  const summary: DeliverySummary = { delivered: 0, approved: 0, changes: 0, stale: 0, failed: 0, expired: 0 };
  const approvals = table(ctx, "client_approvals");
  let rows: AnsweredRow[] = [];
  try {
    rows = await ctx.db.query<AnsweredRow>(
      `SELECT id, company_id, post_id, status, content_hash, answered_by_name, answer_note, answered_at FROM ${approvals}
        WHERE company_id = $1 AND answered_at IS NOT NULL AND notified_at IS NULL AND status IN ('approved', 'changes_requested')
        ORDER BY answered_at LIMIT 25`,
      [companyId],
    );
  } catch (error) {
    ctx.logger.info("Client answers unreadable", { companyId, error: error instanceof Error ? error.message : String(error) });
    return summary;
  }
  for (const row of rows) {
    const claim = await ctx.db.execute(`UPDATE ${approvals} SET notified_at = now() WHERE id = $1 AND company_id = $2 AND notified_at IS NULL`, [row.id, companyId]);
    if ((claim.rowCount ?? 0) !== 1) continue;
    try {
      const applied = await applyClientAnswer(ctx, row, timezone);
      await ctx.db.execute(`UPDATE ${approvals} SET applied = $3 WHERE id = $1 AND company_id = $2`, [row.id, companyId, applied.slice(0, 80)]);
      summary.delivered += 1;
      if (applied === "stale") summary.stale += 1;
      else if (applied === "changes") summary.changes += 1;
      else if (applied.startsWith("approved")) summary.approved += 1;
    } catch (error) {
      summary.failed += 1;
      ctx.logger.info("Client answer not applied; it is retried", { approvalId: row.id, error: error instanceof Error ? error.message : String(error) });
      await ctx.db.execute(`UPDATE ${approvals} SET notified_at = NULL WHERE id = $1 AND company_id = $2`, [row.id, companyId]).catch(() => undefined);
    }
  }
  summary.expired = await expireClientLinks(ctx, companyId);
  return summary;
}

/** Links whose time ran out with no answer are closed, and the Social agent is told once. */
export async function expireClientLinks(ctx: PluginContext, companyId: string): Promise<number> {
  const approvals = table(ctx, "client_approvals");
  let expired = 0;
  try {
    const rows = await ctx.db.query<{ id: string; post_id: string; client_name: string | null }>(
      `SELECT id, post_id, client_name FROM ${approvals} WHERE company_id = $1 AND status = 'pending' AND expires_at < now() ORDER BY expires_at LIMIT 25`,
      [companyId],
    );
    for (const row of rows) {
      const claim = await ctx.db.execute(`UPDATE ${approvals} SET status = 'expired' WHERE id = $1 AND company_id = $2 AND status = 'pending' AND expires_at < now()`, [row.id, companyId]);
      if ((claim.rowCount ?? 0) !== 1) continue;
      expired += 1;
      const post = await getPost(ctx, companyId, row.post_id);
      if (post?.status === "review") {
        await tellSocialAgent(ctx, companyId, post, `The client's approval link${row.client_name ? ` for ${row.client_name}` : ""} ran out with no answer. Make a new link with \`request-client-approval\` and send a short reminder (Mailbox draft; a person sends it).`);
      }
    }
  } catch (error) {
    ctx.logger.info("Client link expiry skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
  return expired;
}

/** Companies that have client links (job fan-out; the company id comes from our own rows). */
export async function companiesWithClientLinks(ctx: PluginContext): Promise<string[]> {
  const rows = await ctx.db.query<{ company_id: string }>(
    `SELECT DISTINCT company_id FROM ${table(ctx, "client_approvals")} WHERE (status = 'pending' AND expires_at < now() + interval '1 day') OR (answered_at IS NOT NULL AND notified_at IS NULL)`,
  );
  return rows.map((r) => r.company_id);
}

/** What the Cockpit and the setup status need to know about links in flight. */
export async function clientApprovalCounts(ctx: PluginContext, companyId: string): Promise<{ pending: number; unanswered7d: number; waitingDelivery: number }> {
  const rows = await ctx.db.query<{ pending: string; stale: string; waiting: string }>(
    `SELECT count(*) FILTER (WHERE status = 'pending' AND expires_at >= now())::text AS pending,
            count(*) FILTER (WHERE status = 'pending' AND expires_at >= now() AND created_at < now() - interval '7 days')::text AS stale,
            count(*) FILTER (WHERE answered_at IS NOT NULL AND notified_at IS NULL)::text AS waiting
       FROM ${table(ctx, "client_approvals")} WHERE company_id = $1`,
    [companyId],
  );
  return { pending: Number(rows[0]?.pending ?? 0), unanswered7d: Number(rows[0]?.stale ?? 0), waitingDelivery: Number(rows[0]?.waiting ?? 0) };
}

/**
 * The `client-answers` job (every 5 minutes): for each company with links in flight (company ids from our own
 * rows, explicit on every call), apply the client's answers and close expired links. A company that switched the
 * module off, or never saved its settings, is skipped.
 */
export async function clientAnswersJob(ctx: PluginContext, ensureCompany: (companyId: string) => Promise<void>): Promise<DeliverySummary & { companies: number }> {
  const total: DeliverySummary & { companies: number } = { companies: 0, delivered: 0, approved: 0, changes: 0, stale: 0, failed: 0, expired: 0 };
  for (const companyId of await companiesWithClientLinks(ctx)) {
    if (!(await socialOn(ctx, companyId))) continue;
    await ensureCompany(companyId).catch(() => undefined);
    const config = await loadSocialConfig(ctx, companyId);
    if (!config.saved) continue;
    const one = await deliverClientAnswers(ctx, companyId, config.timezone);
    total.companies += 1;
    for (const key of ["delivered", "approved", "changes", "stale", "failed", "expired"] as const) total[key] += one[key];
  }
  return total;
}
