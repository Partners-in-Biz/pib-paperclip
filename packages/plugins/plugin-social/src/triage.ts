/**
 * Social inbox triage: built-in keyword rules, improved by Jev (kit
 * decisions.ts) when a key is set.
 *
 * With Jev, each new item goes out with only the platform, the kind, the text
 * (600 characters at most) and a snippet of the post it is on (200 at most),
 * and Jev answers four typed questions. Without a key (or when Jev keeps
 * failing) the rules in `ruleTriage` answer the same four questions from
 * keywords and patterns. Either way the plugin then acts:
 * - spam (Jev at ≥ update, 0.7, or a strong spam pattern) → marked read;
 * - escalate (legal, safety or PR risk) → an issue for a person (the post
 *   owner), and nothing is queued for the agent;
 * - needs a reply, not spam → queued for the Social agent in one digest issue
 *   per account per day;
 * - intent lead → `lead.captured` to the CRM (through the kit outbox).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  ASK_OWNER_TOOL,
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
import { sendLead } from "./handoff.js";
import { createIssueSafely, ORIGIN_KIND, personAssignee, scopeLine, socialAssignee, socialProjectId } from "./issues.js";
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
  /** The Jev model, or `rules` for the built-in keyword rules. */
  model: string;
  needsReply: { p: number; yes: boolean };
  intent: { value: string; confidence: number };
  sentiment: { value: string; score: number; confidence: number };
  escalate: { p: number; yes: boolean };
  action: TriageAction;
  decisionIds: Record<string, string>;
  /** Rules only: what matched, in plain words ("mentions a lawyer"). */
  reasons?: string[];
  corrected?: Record<string, string>;
  issueId?: string | null;
}

/** `Triage.model` for the built-in rules. */
export const RULES_MODEL = "rules";

type Rule = { re: RegExp; why: string };

/** Obvious spam: money-for-nothing, follower selling, scam links, fake prizes. */
const SPAM_RULES: Rule[] = [
  { re: /\b(crypto|bitcoin|btc|forex|binary options?|nft|airdrop|usdt)\b[\s\S]{0,80}\b(invest(ing|ment)?|profits?|earn(ings)?|trading|returns?|signals?|mining)\b/, why: "crypto or forex money offer" },
  { re: /\b(invest(ing|ment)?|profits?|earn(ings)?|trading)\b[\s\S]{0,80}\b(crypto|bitcoin|btc|forex|binary options?|usdt)\b/, why: "crypto or forex money offer" },
  { re: /\b(earn|make)\s+(\$|r|usd|zar)?\s?\d[\d,.]*k?\s*(\$|usd|zar)?\s*(per|a|every|\/)\s*(day|week|hour|month)\b/, why: "earn-money-fast offer" },
  { re: /\b(work|earn|make money) from home\b/, why: "earn-money-fast offer" },
  { re: /\b(follow for follow|f4f|l4l|like for like|follow back|check (out )?my (page|profile|bio)|visit my (page|profile))\b/, why: "follower or self-promotion spam" },
  { re: /\b(buy|get|boost|gain)\s+(more\s+)?(real\s+)?(followers|likes|views|subscribers)\b/, why: "follower selling" },
  { re: /\b(promote|boost|grow) your (page|account|business|profile)\b[\s\S]{0,60}\b(dm|inbox|message|whatsapp)\b/, why: "promotion service pitch" },
  { re: /\b(sugar (daddy|mommy|mummy)|onlyfans|hot singles|dating site)\b/, why: "adult or dating spam" },
  { re: /\b(you('ve| have) (been selected|won)|claim your (prize|reward|gift)|congratulations[,!]? you (won|have been))\b/, why: "fake prize" },
  { re: /\b(bit\.ly|tinyurl\.com|t\.me|wa\.me|cutt\.ly|shorturl\.at)\//, why: "short or chat link from a stranger" },
];

/** Legal, safety or PR risk: a person decides what to say. */
const ESCALATE_RULES: Rule[] = [
  { re: /\b(lawyers?|attorneys?|legal action|suing|sued|small claims|magistrate|summons|letter of demand|court (case|order)|in court|to court)\b|\b(i('ll| will)|we('ll| will)|going to|gonna) sue\b|\bsue (you|them|your|this|the)\b/, why: "mentions legal action" },
  { re: /\b(consumer (protection|commission|tribunal|goods)|ombud(sman)?|hellopeter|report(ed|ing)? (you|this|them|it) to|information regulator|popia)\b/, why: "mentions a regulator or public complaint site" },
  { re: /\b(journalists?|reporters?|news24|carte blanche|going viral|go viral|(tell|go to|contact|call) the (media|press|news))\b/, why: "mentions the press or going viral" },
  { re: /\b(injur(y|ed|ies)|hospital(ised|ized)?|allergic reaction|food poisoning|poison(ed|ing)?|unsafe|dangerous|fire hazard|electrocut\w*|burnt myself|burned myself)\b/, why: "mentions injury or safety" },
  { re: /\b(assault(ed)?|harass(ed|ing|ment)?|threat(en(ed|ing|s)?)?|stalk(ed|ing)?|abus(e|ed|ive))\b/, why: "mentions harassment, threats or abuse" },
  { re: /\b(racis[mt]|sexis[mt]|homophob\w*|discriminat(e|ed|ion|ing))\b/, why: "mentions discrimination" },
  { re: /\bfraud(ulent|sters?)?\b/, why: "accuses the business of fraud" },
  { re: /\b\d{13}\b/, why: "contains what looks like an ID number" },
  { re: /\b(?:\d[ -]?){15}\d\b/, why: "contains what looks like a card number" },
];

const COMPLAINT_RULES: Rule[] = [
  { re: /\b(terrible|awful|worst|horrible|disgusting|useless|pathetic|shocking|appalling|rubbish)\b/, why: "strong negative words" },
  { re: /\b(scam(med|mers?)?|rip[- ]?off|overcharged|charged (me )?twice|money back|refund)\b/, why: "money complaint" },
  { re: /\b(never (arrived|came|received|delivered)|still (waiting|not (received|delivered|fixed))|still haven't|haven't (received|heard)|no one (answers|responds|replied|called)|nobody (answers|responds|replied|called))\b/, why: "waiting with no answer" },
  { re: /\b(not happy|unhappy|disappointed|dissatisfied|complain(t|ing)?|fed up|poor service|bad service|bad experience|waste of (money|time)|rude)\b/, why: "unhappy customer" },
  { re: /\b(broken|doesn't work|does not work|not working|stopped working|faulty|damaged)\b/, why: "something does not work" },
];

const LEAD_RULES: Rule[] = [
  { re: /\b(how much|what('s| is| are) (the |your )?(price|prices|cost|costs|rate|rates|fee|fees)|price ?list|pricing|quotation|(a|the|your|get|send|need|want) quote)\b/, why: "asks about price or a quote" },
  { re: /\b(can i|could i|how do i|how can i|i('d| would) like to|i want to|want to) (book|reserve)\b|\b(bookings?|appointments?|reservations?|availability)\b|\bavailable (on|for|this|next|in)\b/, why: "wants to book" },
  { re: /\b(hire you|work with you|interested in (your|the|this)|i('m| am) interested|i('d| would) like (to order|to buy|to book|one|a quote)|i want (to order|to buy|to book|one|a quote)|sign me up|place an order|how (do|can) i (order|buy|book|sign up|get one)|where can i (buy|order|get))\b/, why: "wants to buy or work together" },
  { re: /\b(do|can) you (offer|do|deliver|ship|install|provide|service|cater|come to)\b/, why: "asks whether you offer a service" },
  { re: /\b(dm|inbox|message|whatsapp|email|call) me\b|\b(send|share) (me )?(the |your )?(price|prices|details|info|quote|menu|catalogue|brochure)\b/, why: "asks to be contacted" },
];

const PRAISE_RULES: Rule[] = [
  { re: /\b(thank(s| you)|love (this|it|your|the|you)|amazing|awesome|great (job|work|service|post|team)|well done|congrat(s|ulations)|best (service|team|ever)|highly recommend|recommend(ed)? (you|them)|beautiful|brilliant|fantastic|excellent|stunning)\b/, why: "praise" },
];

const QUESTION_START = /^(how|what|when|where|why|who|which|is|are|does|did|can|could|will|would)\b/;

function firstMatch(rules: Rule[], text: string): Rule | null {
  return rules.find((rule) => rule.re.test(text)) ?? null;
}

/**
 * The built-in rules: what Jev would answer, from keywords and patterns only.
 * Used when no Jev key is set, and for an item Jev failed on every try. Pure.
 */
export function ruleTriage(item: Pick<InboxItemRow, "kind" | "body">): Triage {
  const text = item.body.toLowerCase().replace(/\s+/g, " ").trim();
  const reasons: string[] = [];
  const risk = firstMatch(ESCALATE_RULES, text);
  const spam = risk ? null : firstMatch(SPAM_RULES, text);
  const complaint = firstMatch(COMPLAINT_RULES, text);
  const lead = firstMatch(LEAD_RULES, text);
  const praise = firstMatch(PRAISE_RULES, text);
  const question = text.includes("?") || QUESTION_START.test(text);
  let intent = "other";
  let confidence = 0.5;
  if (spam) {
    intent = "spam";
    confidence = 0.9;
    reasons.push(spam.why);
  } else if (complaint) {
    intent = "complaint";
    confidence = 0.75;
    reasons.push(complaint.why);
  } else if (lead) {
    intent = "lead";
    confidence = 0.75;
    reasons.push(lead.why);
  } else if (question) {
    intent = "question";
    confidence = 0.65;
    reasons.push("asks a question");
  } else if (praise) {
    intent = "praise";
    confidence = 0.7;
    reasons.push(praise.why);
  }
  if (risk) reasons.unshift(risk.why);
  const negative = Boolean(complaint || risk);
  const sentimentScore = negative ? 0 : praise || intent === "lead" ? 2 : 1;
  const needsReply = !spam && (intent === "question" || intent === "complaint" || intent === "lead");
  const action: TriageAction = risk ? "escalated" : spam ? "spam_read" : needsReply ? "queued" : "none";
  return {
    model: RULES_MODEL,
    needsReply: { p: needsReply ? 0.8 : 0.2, yes: needsReply },
    intent: { value: intent, confidence },
    sentiment: { value: SENTIMENT_LEVELS[sentimentScore]!, score: sentimentScore, confidence: negative || praise ? 0.7 : 0.5 },
    escalate: { p: risk ? 0.8 : 0.05, yes: Boolean(risk) },
    action,
    decisionIds: {},
    reasons,
  };
}

function noulP(answer: JevAnswer | undefined): number {
  return answer?.type === "noul" ? answer.noul : 0;
}

/** Intent "lead" on an item that is neither spam nor escalated. Pure. */
export function isLead(t: Pick<Triage, "intent" | "action">): boolean {
  return t.intent.value === "lead" && t.action !== "escalated" && t.action !== "spam_read";
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

/** "Jev" or "the built-in rules", for issue text. */
export function triageSource(t: Pick<Triage, "model">): string {
  return t.model === RULES_MODEL ? "the built-in rules" : "Jev";
}

function digestKey(companyId: string, accountId: string, day: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "social-inbox", stateKey: `digest:${accountId}:${day}` };
}

/** What the Social agent does with the day's reply queue. Pure. */
export function replyQueueSteps(): string[] {
  return [
    "What to do:",
    "1. `list-inbox` (same scope, status new) for the full text, then `reply-inbox` with the `itemId` for each one. Keep replies short, friendly and on brand (`get-playbook` for the scope).",
    "2. Questions: answer them. Complaints: acknowledge, offer a private channel (DM or email), never argue.",
    "3. Leads are already in the CRM. For own accounts the Account Manager follows up there; for a client's accounts the lead stays the client's and your reply is the only answer. Answer, and point them to the booking or contact link in the playbook's Constraints. No link there: ask once with `" + ASK_OWNER_TOOL + "` and add it as a constraint (`propose-playbook-change`).",
    "4. `mark-inbox-read` anything that needs no reply. Close this issue with one line on what you did.",
    "Items with legal, safety or PR risk are not in this list; a person handles those.",
  ];
}

/** One issue per account per day: create it, or comment on today's. Returns the issue id. */
async function queueForAgent(ctx: PluginContext, config: SocialConfig, account: AccountRow, items: Array<{ item: InboxItemRow; triage: Triage }>, now: Date): Promise<string | null> {
  const companyId = config.companyId;
  const day = localDate(now, config.timezone);
  const key = digestKey(companyId, account.id, day);
  const lines = items.map(({ item, triage }) => itemLine(item, triage));
  const assignee = await socialAssignee(ctx, companyId, account.created_by_user_id);
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
      if (assignee.assigneeAgentId) await wakeIssue(ctx, existing, companyId, "New social comments to reply to");
      return existing;
    } catch (error) {
      ctx.logger.info("Social inbox digest comment failed; opening a new issue", { issueId: existing, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const label = `${platformName(account.platform)} · ${account.display_name}`;
  const sources = Array.from(new Set(items.map(({ triage }) => triageSource(triage))));
  const description = [
    `These ${label} comments and messages need a reply (${day}; sorted by ${sources.join(" and ")}). More arriving today are added here as comments.`,
    "",
    ...lines,
    "",
    scopeLine(account),
    "",
    ...replyQueueSteps(),
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
      assigneeAgentId: assignee.assigneeAgentId,
      assigneeUserId: assignee.assigneeUserId,
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

/** Why an item was escalated, for the person's issue. Pure. */
export function escalationWhy(t: Pick<Triage, "model" | "escalate" | "reasons">): string {
  if (t.model === RULES_MODEL) return `The built-in rules flagged it${t.reasons?.length ? ` (${t.reasons[0]})` : ""}`;
  return `Jev thinks it may carry legal, safety or public-relations risk (${Math.round(t.escalate.p * 100)}% sure)`;
}

/** A person looks at risky items: the post's owner, else the account's creator, else the default person or the Cockpit owner. */
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
        `${escalationWhy(triage)}. It was not queued for the agent, so nobody replies until you decide.`,
        "",
        `> ${snippet(item.body, 1200).replace(/\n/g, "\n> ")}`,
        "",
        `From: ${item.author || "unknown"} · intent ${triage.intent.value} · sentiment ${triage.sentiment.value}`,
        item.permalink ? `Open it: ${item.permalink}` : null,
        "",
        "Reply from the Social inbox (or on the platform) once you know what to say, or assign this issue to the Social agent with the reply you want. If it is not risky, set the chip on the inbox item to \"ordinary\" (the correction is recorded), then reply as usual.",
        `itemId: \`${item.id}\``,
      ].filter((line) => line !== null).join("\n"),
      priority: "high",
      originKind: ORIGIN_KIND,
      originId: `inbox-escalate:${item.id}`,
      assigneeUserId: await personAssignee(ctx, companyId, postOwner ?? account?.created_by_user_id),
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
  /** Items with intent "lead" sent to the CRM (lead.captured, through the outbox). */
  leads?: number;
  /** Items the built-in rules triaged (no Jev key, or Jev failed on every try). */
  rules?: number;
}

/**
 * Triage the company's new, untriaged items (from poll-inbox and by hand).
 * With a Jev key Jev answers; an item Jev fails on is retried on the next run
 * and falls back to the built-in rules after its last try. Without a key the
 * rules answer at once, so leads, the reply queue and escalations always work.
 */
export async function triageInbox(ctx: PluginContext, config: SocialConfig, options: { now?: Date; fetchImpl?: typeof fetch; limit?: number } = {}): Promise<TriageSummary> {
  const summary: TriageSummary = { triaged: 0, spam: 0, queued: 0, escalated: 0, failed: 0 };
  const companyId = config.companyId;
  const now = options.now ?? new Date();
  const items = await untriagedInboxItems(ctx, companyId, options.limit ?? 100, MAX_TRIAGE_ATTEMPTS);
  if (items.length === 0) return summary;
  // The secret is only resolved when there is work.
  const jev = jevKeySet(config.raw) ? await jevConfigFor(ctx, config) : null;
  const posts = new Map<string, { body: string; owner: string | null }>();
  for (const id of Array.from(new Set(items.map((i) => i.post_id).filter((x): x is string => Boolean(x))))) {
    const post = await getPost(ctx, companyId, id);
    if (post) posts.set(id, { body: post.body, owner: post.owner_user_id });
  }
  const results: Array<DecisionResult | null> = jev
    ? await decideMany(items, 4, (item) =>
        decide(ctx, companyId, {
          config: jev,
          purpose: TRIAGE_PURPOSE,
          subject: { kind: "inbox_item", id: item.id },
          state: triageState(item, item.post_id ? posts.get(item.post_id)?.body ?? null : null),
          questions: TRIAGE_QUESTIONS,
          fetchImpl: options.fetchImpl,
        }),
      )
    : items.map(() => null);
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
    let triage: Triage;
    if (result) {
      triage = readTriage(result);
    } else if (jev && (item.triage_attempts ?? 0) + 1 < MAX_TRIAGE_ATTEMPTS) {
      // Jev did not answer: try again on the next run (the rules take over after the last try).
      summary.failed += 1;
      await saveInboxTriage(ctx, companyId, item.id, { triage: null, failed: true });
      continue;
    } else {
      triage = ruleTriage(item);
      summary.rules = (summary.rules ?? 0) + 1;
    }
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
    // Buying intent goes to the CRM (not spam, not a risky item a person handles).
    if (isLead(triage)) {
      summary.leads = (summary.leads ?? 0) + 1;
      await sendLead(ctx, companyId, item, triage.intent.confidence);
    }
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

/** A person corrects one answer: shown on the item, and logged against the Jev decision when Jev triaged it. */
export async function correctTriage(ctx: PluginContext, companyId: string, userId: string, params: { itemId: string; key: string; value: string }) {
  const options = CORRECTABLE[params.key];
  if (!options) throw new SocialError(`key must be one of ${Object.keys(CORRECTABLE).join(", ")}`);
  if (!options.includes(params.value)) throw new SocialError(`${params.key} must be one of ${options.join(", ")}`);
  const item = await getInboxItem(ctx, companyId, params.itemId);
  if (!item) throw new SocialError("Inbox item was not found");
  const triage = parseTriage(item.triage);
  if (!triage) throw new SocialError("This item has not been triaged yet");
  const decisionId = triage.decisionIds?.[params.key];
  if (decisionId) await correctDecision(ctx, companyId, decisionId, params.value, userId);
  const next: Triage = { ...triage, corrected: { ...(triage.corrected ?? {}), [params.key]: params.value } };
  await saveInboxTriage(ctx, companyId, item.id, { triage: next, issueId: item.triage_issue_id ?? null });
  // A person says it is a lead: the CRM gets it now (at full confidence).
  if (params.key === "intent" && params.value === "lead" && triage.intent.value !== "lead") await sendLead(ctx, companyId, item, 1);
  // "Not spam": bring an item the triage marked read back to the inbox.
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
    /** `jev` or `rules` (the built-in keyword rules). */
    source: t.model === RULES_MODEL ? "rules" : "jev",
    /** Rules only: what matched. */
    reasons: t.reasons ?? [],
    triagedAt: iso(triagedAt),
  };
}
