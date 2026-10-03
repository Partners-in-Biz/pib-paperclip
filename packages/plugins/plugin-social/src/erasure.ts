/**
 * Erasing one person from Social's data (Q10-13, POPIA): the receiver side of the kit's
 * `contact.erase.requested` (the CRM sends it after a person approved the erasure).
 *
 * What Social holds about a person is what they wrote to a client's or PiB's accounts:
 * inbox items (comments, mentions, direct messages, our reply drafts, the triage of each)
 * and the lead hand-off to the CRM that quotes them. Erasing means:
 *
 * - inbox items that are THEIRS become tombstones: author and text replaced, reply text, link
 *   and triage cleared. The row stays so the next poll does not bring the same comment back
 *   (the unique key is the platform's own comment id, which says nothing about the person);
 * - the Jev decisions logged for those items are deleted;
 * - the queued or settled `lead.captured` hand-offs for those items are deleted (a lead still
 *   waiting for the CRM stops being re-sent);
 * - the issues that quote them are cleaned, each by what it is: an escalation issue (one item, `inbox-escalate:<itemId>`) has its
 *   whole text replaced; a daily reply-queue digest (`inbox:<accountId>:<day>`, many people's comments plus the agent's steps)
 *   only loses the lines for the erased items, so everyone else's lines and the steps stay;
 * - the client approval records that name them (the email a link was meant for, the name they
 *   typed on the approval page, their note) are cleared; the approval itself stays, anonymously.
 *
 * Which items are theirs: the lead hand-offs the CRM answered with their contact id, and any
 * item whose text or author contains their email address or phone number. Social cannot tell a
 * person by their handle alone, and does not guess. What it cannot or may not erase is reported
 * in `retained`, never silently skipped: the comment still sits on the platform, digests and
 * issue comments in Paperclip may quote it, and published posts that mention the person are
 * content the client decides about.
 *
 * Idempotent: a second run finds nothing left (the kit remembers a finished request anyway).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { textArrayParam, type ContactEraseRequested, type EraseOutcome } from "@partnersinbiz/pib-plugin-kit";
import { table } from "./db.js";
import { SOCIAL_ORIGINS } from "./issues.js";

export const ERASED_TEXT = "[erased]";
const ERASED_ISSUE_TEXT = "[Removed: this text quoted a person who asked for their data to be erased.]";
/** What a digest line of an erased item becomes (the line keeps its place, the item id and everything else go). */
export const ERASED_LINE = `- ${ERASED_TEXT}`;
const LEAD_KEY_PREFIX = "social:inbox:";

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
}

/** How many trailing digits of a phone number identify it: a number is written "+27 82 555 0100" and "082 555 0100", which share their last nine digits. */
const PHONE_TAIL = 9;

/**
 * The identifiers an erasure can match on, normalised: a lower-cased email, and the last nine digits of a phone number
 * (so the international and the local way of writing it both match; fewer than eight digits never match, so a short number
 * is not matched by accident). Pure.
 */
export function matchKeys(subject: ContactEraseRequested["subject"]): { email: string | null; phone: string | null; contactId: string | null } {
  const email = subject.email?.trim().toLowerCase();
  const digits = subject.phone?.replace(/[^0-9]/g, "") ?? "";
  return {
    email: email && email.includes("@") ? email : null,
    phone: digits.length >= 8 ? digits.slice(-PHONE_TAIL) : null,
    contactId: subject.contactId?.trim() || null,
  };
}

interface ItemRef {
  id: string;
  triage_issue_id: string | null;
}

/** Inbox items that are the subject's: answered leads with their contact id, and text or author containing their email or phone. */
async function findItems(ctx: PluginContext, companyId: string, keys: ReturnType<typeof matchKeys>): Promise<ItemRef[]> {
  const found = new Map<string, ItemRef>();
  if (keys.contactId) {
    const leads = await ctx.db.query<{ key: string }>(
      `SELECT key FROM ${table(ctx, "outbox")} WHERE company_id = $1 AND key LIKE 'social:inbox:%' AND result->>'contactId' = $2 LIMIT 500`,
      [companyId, keys.contactId],
    );
    const ids = leads.map((row) => row.key.slice(LEAD_KEY_PREFIX.length)).filter(Boolean);
    if (ids.length) {
      for (const row of await ctx.db.query<ItemRef>(
        `SELECT id, triage_issue_id FROM ${table(ctx, "inbox_items")} WHERE company_id = $1 AND id = ANY(${textArrayParam(2)})`,
        [companyId, JSON.stringify(ids)],
      )) found.set(row.id, row);
    }
  }
  if (keys.email) {
    for (const row of await ctx.db.query<ItemRef>(
      `SELECT id, triage_issue_id FROM ${table(ctx, "inbox_items")}
        WHERE company_id = $1 AND (position($2 in lower(body)) > 0 OR position($2 in lower(author)) > 0 OR position($2 in lower(COALESCE(reply_body, ''))) > 0)
        LIMIT 500`,
      [companyId, keys.email],
    )) found.set(row.id, row);
  }
  if (keys.phone) {
    for (const row of await ctx.db.query<ItemRef>(
      `SELECT id, triage_issue_id FROM ${table(ctx, "inbox_items")}
        WHERE company_id = $1 AND (position($2 in regexp_replace(body, '[^0-9]', '', 'g')) > 0 OR position($2 in regexp_replace(author, '[^0-9]', '', 'g')) > 0)
        LIMIT 500`,
      [companyId, keys.phone],
    )) found.set(row.id, row);
  }
  return [...found.values()];
}


/** True for a digest line that is about this item: the digest writes `... · itemId \`<id>\`` at the end of each item's line. Pure. */
function lineIsFor(line: string, itemIds: ReadonlySet<string>): boolean {
  const m = /itemId `([^`]+)`\s*$/.exec(line);
  return Boolean(m && itemIds.has(m[1]!));
}

/**
 * A reply-queue digest's text with the lines of the erased items replaced by `ERASED_LINE`. Everything else (the header, the other
 * people's lines, the scope line and the agent's steps) is kept as it is. Pure.
 */
export function scrubDigestText(description: string, erasedItemIds: Iterable<string>): { text: string; lines: number } {
  const ids = new Set(erasedItemIds);
  let lines = 0;
  const text = description
    .split("\n")
    .map((line) => {
      if (!lineIsFor(line, ids)) return line;
      lines += 1;
      return ERASED_LINE;
    })
    .join("\n");
  return { text, lines };
}

type IssueScrub = { state: "unchanged" } | { state: "text" } | { state: "lines"; lines: number } | { state: "error"; error: string };

/**
 * Cleans one triage issue of the erased items. An escalation issue is about one item, so the whole description goes; anything else
 * (the reply-queue digest, which lists many people) loses only the lines of the erased items. An issue that is gone, or whose text
 * has nothing of theirs left, is left alone.
 */
async function scrubIssue(ctx: PluginContext, companyId: string, issueId: string, itemIds: string[]): Promise<IssueScrub> {
  try {
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue) return { state: "unchanged" };
    const description = issue.description ?? "";
    if ((issue.originId ?? "").startsWith(SOCIAL_ORIGINS.escalation)) {
      if (description === ERASED_ISSUE_TEXT) return { state: "unchanged" };
      await ctx.issues.update(issueId, { description: ERASED_ISSUE_TEXT }, companyId);
      return { state: "text" };
    }
    const scrubbed = scrubDigestText(description, itemIds);
    if (scrubbed.lines === 0) return { state: "unchanged" };
    // A shortened description cannot be written back: it would cut the rest of the issue off.
    if (issue.descriptionTruncated) return { state: "error", error: "its text is shortened by the host, so lines cannot be removed safely" };
    await ctx.issues.update(issueId, { description: scrubbed.text }, companyId);
    return { state: "lines", lines: scrubbed.lines };
  } catch (error) {
    return { state: "error", error: errorText(error) };
  }
}

/** Erases the subject from Social. Throws on a database failure (the kit reports it and the sender retries). */
export async function eraseSubject(ctx: PluginContext, request: ContactEraseRequested, companyId: string): Promise<EraseOutcome> {
  const counts: Record<string, number> = {};
  const retained: Array<{ what: string; why: string }> = [];
  const errors: string[] = [];
  // Social holds no marketing email data: a marketing-only erasure has nothing here.
  if (request.scope === "marketing_only") return { counts, retained };
  const keys = matchKeys(request.subject);
  if (!keys.email && !keys.phone && !keys.contactId) return { counts, retained };

  const found = await findItems(ctx, companyId, keys);
  // The issues that quote them are cleaned first. An item whose issue could not be cleaned is held back: its text is how the
  // next run finds it again (the kit retries a request that reports errors), so nothing is left quoting the person for good.
  const byIssue = new Map<string, string[]>();
  for (const item of found) if (item.triage_issue_id) byIssue.set(item.triage_issue_id, [...(byIssue.get(item.triage_issue_id) ?? []), item.id]);
  const held = new Set<string>();
  let rewritten = 0;
  let lines = 0;
  for (const [issueId, itemIds] of byIssue) {
    const result = await scrubIssue(ctx, companyId, issueId, itemIds);
    if (result.state === "text") rewritten += 1;
    else if (result.state === "lines") {
      rewritten += 1;
      lines += result.lines;
    } else if (result.state === "error") {
      for (const id of itemIds) held.add(id);
      errors.push(`issue ${issueId} could not be cleaned (${result.error}); its items are kept until the next run`);
    }
  }
  if (rewritten) counts.issue_texts = rewritten;
  if (lines) counts.digest_lines = lines;
  const items = found.filter((item) => !held.has(item.id));
  if (items.length > 0) {
    const ids = JSON.stringify(items.map((item) => item.id));
    const itemTable = table(ctx, "inbox_items");
    const done = await ctx.db.execute(
      `UPDATE ${itemTable}
          SET author = '${ERASED_TEXT}', body = '${ERASED_TEXT}', reply_draft = NULL, reply_body = NULL, permalink = NULL, triage = NULL, status = 'read'
        WHERE company_id = $1 AND id = ANY(${textArrayParam(2)}) AND (body <> '${ERASED_TEXT}' OR author <> '${ERASED_TEXT}' OR triage IS NOT NULL OR reply_body IS NOT NULL OR reply_draft IS NOT NULL OR permalink IS NOT NULL)`,
      [companyId, ids],
    );
    counts.inbox_items = done.rowCount ?? 0;
    const decisions = await ctx.db.execute(
      `DELETE FROM ${table(ctx, "decisions")} WHERE company_id = $1 AND subject_kind = 'inbox_item' AND subject_id = ANY(${textArrayParam(2)})`,
      [companyId, ids],
    );
    if (decisions.rowCount) counts.decisions = decisions.rowCount;
    const leads = await ctx.db.execute(
      `DELETE FROM ${table(ctx, "outbox")} WHERE company_id = $1 AND key = ANY(${textArrayParam(2)})`,
      [companyId, JSON.stringify(items.map((item) => `${LEAD_KEY_PREFIX}${item.id}`))],
    );
    if (leads.rowCount) counts.lead_handoffs = leads.rowCount;
    if ((counts.inbox_items ?? 0) > 0 || (counts.lead_handoffs ?? 0) > 0) {
      retained.push(
        { what: "The original comments and messages on the social platforms", why: "They live on the platform, not in Paperclip. The person can delete them there; Social cannot." },
        { what: "Comments on the reply-queue and escalation issues that quoted the comments", why: "The host keeps issue history and a plugin cannot edit a comment, including the \"N more to reply to\" comments Social added to a day's digest. Redact them in the issues if they quote the person." },
      );
    }
  }

  if (keys.email) {
    const approvals = table(ctx, "client_approvals");
    const linked = await ctx.db.query<{ id: string; post_id: string }>(
      `SELECT id, post_id FROM ${approvals} WHERE company_id = $1 AND lower(recipient_email) = $2 LIMIT 200`,
      [companyId, keys.email],
    );
    if (linked.length > 0) {
      const ids = JSON.stringify(linked.map((row) => row.id));
      const cleared = await ctx.db.execute(
        `UPDATE ${approvals}
            SET recipient_email = NULL, answered_by_name = CASE WHEN answered_by_name IS NULL THEN NULL ELSE '${ERASED_TEXT}' END, answer_note = NULL
          WHERE company_id = $1 AND id = ANY(${textArrayParam(2)})`,
        [companyId, ids],
      );
      counts.client_approvals = cleared.rowCount ?? 0;
      const names = await ctx.db.execute(
        `UPDATE ${table(ctx, "review_outcomes")} SET actor_name = NULL, note = NULL WHERE company_id = $1 AND via = 'link' AND post_id = ANY(${textArrayParam(2)})`,
        [companyId, JSON.stringify(Array.from(new Set(linked.map((row) => row.post_id))))],
      );
      if (names.rowCount) counts.review_outcomes = names.rowCount;
    }
  }

  // Published posts that quote the person are the client's content: reported, not rewritten.
  const mentions = await postsMentioning(ctx, companyId, keys);
  if (mentions > 0) {
    retained.push({ what: `${mentions} post${mentions === 1 ? "" : "s"} whose text mentions the person's email or phone`, why: "Posts are the client's published content. Edit or delete them on the Social page if they must go." });
  }
  return { counts, ...(retained.length ? { retained } : {}), ...(errors.length ? { errors } : {}) };
}

async function postsMentioning(ctx: PluginContext, companyId: string, keys: ReturnType<typeof matchKeys>): Promise<number> {
  if (!keys.email && !keys.phone) return 0;
  try {
    let total = 0;
    if (keys.email) {
      const rows = await ctx.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table(ctx, "posts")} WHERE company_id = $1 AND (position($2 in lower(body)) > 0 OR position($2 in lower(COALESCE(first_comment, ''))) > 0 OR position($2 in lower(overrides::text)) > 0)`,
        [companyId, keys.email],
      );
      total += Number(rows[0]?.n ?? 0);
    }
    if (keys.phone) {
      const rows = await ctx.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table(ctx, "posts")} WHERE company_id = $1 AND position($2 in regexp_replace(body, '[^0-9]', '', 'g')) > 0`,
        [companyId, keys.phone],
      );
      total += Number(rows[0]?.n ?? 0);
    }
    return total;
  } catch (error) {
    ctx.logger.info("Social erasure: post check skipped", { companyId, error: errorText(error) });
    return 0;
  }
}
