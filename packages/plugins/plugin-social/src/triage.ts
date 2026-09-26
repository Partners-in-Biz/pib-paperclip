/**
 * Social inbox triage with Jev (kit decisions.ts).
 *
 * For each new inbox item Jev gets only the platform, the kind, the text
 * (600 characters at most) and a snippet of the post it is on (200 at most)
 * and answers four typed questions. The plugin then acts:
 * - spam, confidence ≥ update (0.7) → marked read;
 * - escalate (legal, safety or PR risk), yes at ≥ read → an issue for a
 *   person (the post owner), and nothing is queued for the agent;
 * - needs a reply, yes at ≥ read, not spam → queued for the Social agent in
 *   one digest issue per account per day.
 * Without a Jev key nothing changes: items stay new, as before.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  confidenceOf,
  correctDecision,
  decide,
  decideMany,
  decisionConfig,
  isYes,
  SecretResolver,
  shouldAct,
  wakeIssue,
  type DecisionClientConfig,
  type DecisionResult,
  type JevAnswer,
  type JevQuestions,
} from "@partnersinbiz/pib-plugin-kit";
import { clientPrefix } from "./clients.js";
import type { SocialConfig } from "./config.js";
import {
  getAccount,
  getInboxItem,
  getPost,
  iso,
  markDecisionsActed,
  saveInboxTriage,
  setInboxItemStatus,
  untriagedInboxItems,
  type AccountRow,
  type InboxItemRow,
} from "./db.js";
import { clip, SocialError } from "./domain.js";
import { localDate } from "./growth/engine.js";
import { createIssueSafely, ORIGIN_KIND, scopeLine, socialAgent, socialProjectId } from "./issues.js";
import { isSocialPlatform, PLATFORM_LABELS } from "./platforms.js";

export const TRIAGE_PURPOSE = "social-inbox-triage";
export const TRIAGE_TEXT_LIMIT = 600;
export const TRIAGE_POST_LIMIT = 200;
export const MAX_TRIAGE_ATTEMPTS = 3;

export const INTENT_OPTIONS: Record<string, string> = {
  question: "Asks something about the brand, a product, a service, prices or opening hours",
  complaint: "Unhappy about a product, service, delivery or experience",
  praise: "Thanks, compliments or positive feedback",
  lead: "Wants to buy, book, get a quote or work together",
  spam: "Spam, scams, bots, unrelated promotion or gibberish",
  other: "Anything else (jokes, tags of friends, general chat)",
};
export const SENTIMENT_LEVELS = ["negative", "neutral", "positive"];

export const TRIAGE_QUESTIONS: JevQuestions = {
  needs_reply: {
    type: "noul",
    instructions: "Should the brand reply to this comment or message?",
    criteria: { true: "A question, request, complaint or lead the brand should answer", false: "Nothing to answer (a like, a tag, spam or chat)" },
  },
  intent: { type: "choice", instructions: "What does the writer want?", criteria: { ...INTENT_OPTIONS } },
  sentiment: { type: "score", instructions: "How does the writer feel about the brand?", criteria: ["Negative", "Neutral", "Positive"] },
  escalate: {
    type: "noul",
    instructions: "Does this carry legal, safety or public-relations risk that a person should handle (legal threats, injury or safety issues, harassment, discrimination, private data, press or viral complaints)?",
    criteria: { true: "A person must look at it before anyone replies", false: "Ordinary comment" },
  },
};

/** What Jev sees: named fields only, clipped. */
export function triageState(item: Pick<InboxItemRow, "platform" | "kind" | "body">, postBody: string | null): Record<string, string> {
  const state: Record<string, string> = {
    platform: item.platform && isSocialPlatform(item.platform) ? PLATFORM_LABELS[item.platform] : item.platform ?? "unknown",
    kind: item.kind,
    text: clip(item.body.trim(), TRIAGE_TEXT_LIMIT),
  };
  if (postBody && postBody.trim()) state.post = clip(postBody.trim(), TRIAGE_POST_LIMIT);
  return state;
}

export type TriageAction = "spam_read" | "escalated" | "queued" | "none";

export interface Triage {
  model: string;
  needsReply: { p: number; yes: boolean };
  intent: { value: string; confidence: number };
  sentiment: { value: string; score: number; confidence: number };
  escalate: { p: number; yes: boolean };
  action: TriageAction;
  decisionIds: Record<string, string>;
  corrected?: Record<string, string>;
  issueId?: string | null;
}

function noulP(answer: JevAnswer | undefined): number {
  return answer?.type === "noul" ? answer.noul : 0;
}

/** Read Jev's answers and decide what to do. Pure. */
export function readTriage(result: Pick<DecisionResult, "answers" | "ids" | "model">): Triage {
  const a = result.answers;
  const intent = a.intent?.type === "choice" ? a.intent : null;
  const sentiment = a.sentiment?.type === "score" ? a.sentiment : null;
  const sentimentLevel = sentiment ? SENTIMENT_LEVELS[Math.min(2, Math.max(0, Math.round(sentiment.score)))]! : "neutral";
  const needsReply = isYes(a.needs_reply, "read");
  const escalate = isYes(a.escalate, "read");
  const spam = Boolean(intent && intent.choice === "spam" && shouldAct(intent, "update"));
  const action: TriageAction = escalate ? "escalated" : spam ? "spam_read" : needsReply ? "queued" : "none";
  return {
    model: result.model,
    needsReply: { p: round(noulP(a.needs_reply)), yes: needsReply },
    intent: { value: intent?.choice ?? "other", confidence: round(confidenceOf(intent)) },
    sentiment: { value: sentimentLevel, score: round(sentiment?.score ?? 1), confidence: round(confidenceOf(sentiment)) },
    escalate: { p: round(noulP(a.escalate)), yes: escalate },
    action,
    decisionIds: { ...result.ids },
  };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** The decision keys an action relied on (logged as `acted`). */
export function actedKeys(action: TriageAction): string[] {
  if (action === "spam_read") return ["intent"];
  if (action === "escalated") return ["escalate"];
  if (action === "queued") return ["needs_reply"];
  return [];
}

/** True when a Jev key is saved and Jev is not switched off. Resolves no secret. */
export function jevKeySet(raw: Record<string, unknown>): boolean {
  const jev = raw.jev && typeof raw.jev === "object" ? (raw.jev as { apiKey?: unknown; enabled?: unknown }) : null;
  return Boolean(jev && jev.enabled !== false && jev.apiKey);
}

export async function jevConfigFor(ctx: PluginContext, config: Pick<SocialConfig, "companyId" | "raw">): Promise<DecisionClientConfig | null> {
  try {
    return await decisionConfig(new SecretResolver(ctx, config.companyId, config.raw), config.raw);
  } catch (error) {
    ctx.logger.info("Jev settings could not be read", { companyId: config.companyId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function platformName(platform: string | null): string {
  return platform && isSocialPlatform(platform) ? PLATFORM_LABELS[platform] : platform ?? "social";
}

function snippet(text: string, max = 280): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function itemLine(item: InboxItemRow, t: Triage): string {
  const quote = snippet(item.body.replace(/\s+/g, " ").trim());
  return `- **${item.author || "Someone"}** (${item.kind}, ${t.intent.value}, ${t.sentiment.value}): "${quote}"${item.permalink ? ` — [open](${item.permalink})` : ""} · itemId \`${item.id}\``;
}

async function defaultPerson(ctx: PluginContext, companyId: string): Promise<string | undefined> {
  try {
    return (await ctx.companies.get(companyId))?.defaultResponsibleUserId ?? undefined;
  } catch {
    return undefined;
  }
}

function digestKey(companyId: string, accountId: string, day: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "social-inbox", stateKey: `digest:${accountId}:${day}` };
}

/** One issue per account per day: create it, or comment on today's. Returns the issue id. */
async function queueForAgent(ctx: PluginContext, config: SocialConfig, account: AccountRow, items: Array<{ item: InboxItemRow; triage: Triage }>, now: Date): Promise<string | null> {
  const companyId = config.companyId;
  const day = localDate(now, config.timezone);
  const key = digestKey(companyId, account.id, day);
  const lines = items.map(({ item, triage }) => itemLine(item, triage));
  const agent = await socialAgent(ctx, companyId);
  let existing: string | null = null;
  try {
    const value = await ctx.state.get(key);
    existing = typeof value === "string" && value ? value : null;
  } catch {
    existing = null;
  }
  if (existing) {
    try {
      await ctx.issues.createComment(existing, [`${items.length} more to reply to:`, "", ...lines].join("\n"), companyId);
      if (agent.active && agent.agentId) await wakeIssue(ctx, existing, companyId, "New social comments to reply to");
      return existing;
    } catch (error) {
      ctx.logger.info("Social inbox digest comment failed; opening a new issue", { issueId: existing, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const label = `${platformName(account.platform)} · ${account.display_name}`;
  const description = [
    `Jev flagged these ${label} comments and messages as needing a reply (${day}). More arriving today are added here as comments.`,
    "",
    ...lines,
    "",
    scopeLine(account),
    "",
    "What to do:",
    "1. `list-inbox` (same scope, status new) for the full text, then `reply-inbox` with the `itemId` for each one. Keep replies short, friendly and on brand.",
    "2. Complaints: acknowledge, offer to take it to a private channel, never argue. Leads: answer and point to the booking or contact link.",
    "3. `mark-inbox-read` anything that needs no reply. Close this issue with one line on what you did.",
    "Items that carry legal, safety or PR risk are not in this list; a person handles those.",
  ].join("\n");
  try {
    const issue = await createIssueSafely(ctx, {
      companyId,
      projectId: await socialProjectId(ctx, companyId),
      title: `${clientPrefix(account)}Reply to social comments: ${label} (${day})`,
      description,
      priority: "medium",
      originKind: ORIGIN_KIND,
      originId: `inbox:${account.id}:${day}`,
      assigneeAgentId: agent.active && agent.agentId ? agent.agentId : undefined,
      assigneeUserId: agent.active ? undefined : account.created_by_user_id ?? (await defaultPerson(ctx, companyId)),
      wakeReason: "Social comments need replies",
    });
    try {
      await ctx.state.set(key, issue.id);
    } catch {
      // A second digest today is acceptable; never lose the queue.
    }
    return issue.id;
  } catch (error) {
    ctx.logger.info("Social inbox digest issue not created", { accountId: account.id, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** A person looks at risky items. Assigned to the post's owner, else the account's creator, else the company's default person. */
async function escalateToPerson(ctx: PluginContext, config: SocialConfig, item: InboxItemRow, account: AccountRow | null, postOwner: string | null, triage: Triage): Promise<string | null> {
  const companyId = config.companyId;
  const scoped = account ?? item;
  const where = `${platformName(item.platform)}${account ? ` · ${account.display_name}` : ""}`;
  try {
    const issue = await createIssueSafely(ctx, {
      companyId,
      projectId: await socialProjectId(ctx, companyId),
      title: `${clientPrefix(scoped)}Check a ${item.kind} on ${where}: possible legal, safety or PR risk`,
      description: [
        `Jev thinks this ${item.kind} may carry legal, safety or public-relations risk (${Math.round(triage.escalate.p * 100)}% sure). It was not queued for the agent.`,
        "",
        `> ${snippet(item.body, 1200).replace(/\n/g, "\n> ")}`,
        "",
        `From: ${item.author || "unknown"} · intent ${triage.intent.value} · sentiment ${triage.sentiment.value}`,
        item.permalink ? `Open it: ${item.permalink}` : null,
        "",
        "Reply from the Social inbox (or on the platform) once you know what to say, or hand it to the agent with clear instructions. If Jev got it wrong, correct the chip on the inbox item.",
        `itemId: \`${item.id}\``,
      ].filter((line) => line !== null).join("\n"),
      priority: "high",
      originKind: ORIGIN_KIND,
      originId: `inbox-escalate:${item.id}`,
      assigneeUserId: postOwner ?? account?.created_by_user_id ?? (await defaultPerson(ctx, companyId)),
      wake: false,
    });
    return issue.id;
  } catch (error) {
    ctx.logger.info("Social escalation issue not created", { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export interface TriageSummary {
  triaged: number;
  spam: number;
  queued: number;
  escalated: number;
  failed: number;
  skipped?: "no_jev";
}

/**
 * Triage the company's new, untriaged items (from poll-inbox and by hand).
 * Returns early, touching nothing, when Jev is not configured.
 */
export async function triageInbox(ctx: PluginContext, config: SocialConfig, options: { now?: Date; fetchImpl?: typeof fetch; limit?: number } = {}): Promise<TriageSummary> {
  const summary: TriageSummary = { triaged: 0, spam: 0, queued: 0, escalated: 0, failed: 0 };
  // Cheap checks first: the secret is only resolved when there is work.
  if (!jevKeySet(config.raw)) return { ...summary, skipped: "no_jev" };
  const companyId = config.companyId;
  const now = options.now ?? new Date();
  const items = await untriagedInboxItems(ctx, companyId, options.limit ?? 100, MAX_TRIAGE_ATTEMPTS);
  if (items.length === 0) return summary;
  const jev = await jevConfigFor(ctx, config);
  if (!jev) return { ...summary, skipped: "no_jev" };
  const posts = new Map<string, { body: string; owner: string | null }>();
  for (const id of Array.from(new Set(items.map((i) => i.post_id).filter((x): x is string => Boolean(x))))) {
    const post = await getPost(ctx, companyId, id);
    if (post) posts.set(id, { body: post.body, owner: post.owner_user_id });
  }
  const results = await decideMany(items, 4, (item) =>
    decide(ctx, companyId, {
      config: jev,
      purpose: TRIAGE_PURPOSE,
      subject: { kind: "inbox_item", id: item.id },
      state: triageState(item, item.post_id ? posts.get(item.post_id)?.body ?? null : null),
      questions: TRIAGE_QUESTIONS,
      fetchImpl: options.fetchImpl,
    }),
  );
  const accounts = new Map<string, AccountRow | null>();
  const account = async (id: string | null) => {
    if (!id) return null;
    if (!accounts.has(id)) accounts.set(id, await getAccount(ctx, companyId, id));
    return accounts.get(id) ?? null;
  };
  const queued = new Map<string, Array<{ item: InboxItemRow; triage: Triage }>>();
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const result = results[i];
    if (!result) {
      summary.failed += 1;
      await saveInboxTriage(ctx, companyId, item.id, { triage: null, failed: true });
      continue;
    }
    const triage = readTriage(result);
    summary.triaged += 1;
    const acc = await account(item.account_id);
    if (triage.action === "spam_read") {
      summary.spam += 1;
      await setInboxItemStatus(ctx, companyId, item.id, "read");
    } else if (triage.action === "escalated") {
      summary.escalated += 1;
      triage.issueId = await escalateToPerson(ctx, config, item, acc, item.post_id ? posts.get(item.post_id)?.owner ?? null : null, triage);
    } else if (triage.action === "queued" && acc) {
      summary.queued += 1;
      queued.set(acc.id, [...(queued.get(acc.id) ?? []), { item, triage }]);
    }
    await saveInboxTriage(ctx, companyId, item.id, { triage, issueId: triage.issueId ?? null });
    const acted = actedKeys(triage.action).map((k) => triage.decisionIds[k]).filter((x): x is string => Boolean(x));
    if (acted.length) await markDecisionsActed(ctx, companyId, acted);
  }
  for (const [accountId, list] of queued) {
    const acc = await account(accountId);
    if (!acc) continue;
    const issueId = await queueForAgent(ctx, config, acc, list, now);
    if (!issueId) continue;
    for (const { item, triage } of list) {
      triage.issueId = issueId;
      await saveInboxTriage(ctx, companyId, item.id, { triage, issueId });
    }
  }
  return summary;
}

// ── Corrections (UI) ────────────────────────────────────────────────────────

const CORRECTABLE: Record<string, string[]> = {
  intent: Object.keys(INTENT_OPTIONS),
  sentiment: SENTIMENT_LEVELS,
  needs_reply: ["yes", "no"],
  escalate: ["yes", "no"],
};

export function parseTriage(value: unknown): Triage | null {
  if (!value) return null;
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as Triage;
  return t.intent && t.sentiment ? t : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A person corrects one answer: logged against the Jev decision, shown on the item. */
export async function correctTriage(ctx: PluginContext, companyId: string, userId: string, params: { itemId: string; key: string; value: string }) {
  const options = CORRECTABLE[params.key];
  if (!options) throw new SocialError(`key must be one of ${Object.keys(CORRECTABLE).join(", ")}`);
  if (!options.includes(params.value)) throw new SocialError(`${params.key} must be one of ${options.join(", ")}`);
  const item = await getInboxItem(ctx, companyId, params.itemId);
  if (!item) throw new SocialError("Inbox item was not found");
  const triage = parseTriage(item.triage);
  if (!triage) throw new SocialError("This item was not triaged by Jev");
  const decisionId = triage.decisionIds?.[params.key];
  if (decisionId) await correctDecision(ctx, companyId, decisionId, params.value, userId);
  const next: Triage = { ...triage, corrected: { ...(triage.corrected ?? {}), [params.key]: params.value } };
  await saveInboxTriage(ctx, companyId, item.id, { triage: next, issueId: item.triage_issue_id ?? null });
  // "Not spam": bring an item Jev marked read back to the inbox.
  if (params.key === "intent" && triage.action === "spam_read" && params.value !== "spam" && item.status === "read") {
    await setInboxItemStatus(ctx, companyId, item.id, "new");
  }
  return { itemId: item.id, key: params.key, value: params.value, logged: Boolean(decisionId) };
}

/** Triage as the UI and agents see it (no decision ids). */
export function triageOut(value: unknown, triagedAt: unknown) {
  const t = parseTriage(value);
  if (!t) return null;
  const c = t.corrected ?? {};
  return {
    needsReply: c.needs_reply ? c.needs_reply === "yes" : t.needsReply.yes,
    intent: c.intent ?? t.intent.value,
    intentConfidence: t.intent.confidence,
    sentiment: c.sentiment ?? t.sentiment.value,
    escalate: c.escalate ? c.escalate === "yes" : t.escalate.yes,
    action: t.action,
    corrected: Object.keys(c),
    issueId: t.issueId ?? null,
    model: t.model,
    triagedAt: iso(triagedAt),
  };
}
