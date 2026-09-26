/**
 * Jev questions the CRM asks, and the per-company Jev settings.
 *
 * Only named fields are sent: a reply's subject and snippet (≤500 chars), and
 * for a lead score the contact's name, role, company, lifecycle, tags and the
 * last three activity snippets (≤800 chars). Without a key `decide` returns
 * null and the CRM falls back to its rules.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { decisionConfig, readConfig, SecretResolver, type DecisionClientConfig, type JevAnswer, type JevQuestions } from "@partnersinbiz/pib-plugin-kit";
import type { LeadDimension } from "./lead-levels.js";

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: DecisionClientConfig | null }>();

/**
 * Jev settings for a company, or null when no key is set. Cached for five
 * minutes so busy inboxes stay under the host's secret-resolve rate limit.
 */
export async function jevConfigFor(ctx: PluginContext, companyId: string): Promise<DecisionClientConfig | null> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value: DecisionClientConfig | null = null;
  try {
    const config = await readConfig(ctx, companyId);
    value = await decisionConfig(new SecretResolver(ctx, companyId, config), config);
  } catch (error) {
    ctx.logger.info("Jev settings could not be read; using CRM rules", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
  cache.set(companyId, { at: Date.now(), value });
  return value;
}

/** Tests and settings changes. */
export function clearJevCache(): void {
  cache.clear();
}

export const REPLY_QUESTIONS: JevQuestions = {
  reply_kind: {
    type: "choice",
    instructions:
      "The state is an email a contact sent back after we emailed them from a sales or marketing sequence. Which kind of reply is it?",
    criteria: {
      interested: "Positive: wants to talk, book a call or meeting, see a proposal, or go ahead.",
      question: "Asks about the offer, price, timing or how it works, without a clear yes or no.",
      not_now: "A polite no for now: busy, no budget, already has a provider, or asks to try again later.",
      unsubscribe: "Asks to stop emailing, to be removed from the list, or says they do not want these emails.",
      out_of_office: "An automatic out-of-office or away message, often with a return date.",
      bounce: "A delivery failure notice: address not found, mailbox full, rejected or undeliverable.",
      other: "Anything else, such as a referral to someone else, spam, or an unrelated message.",
    },
  },
};

const IDEAL_CLIENT =
  "Partners in Biz is a South African digital agency (websites, SEO, social media, paid ads, email and marketing automation) that works on monthly retainers for owner-led small and medium businesses.";

export const LEAD_QUESTIONS: Record<LeadDimension, JevQuestions[string]> = {
  fit: {
    type: "score",
    instructions: `${IDEAL_CLIENT} How well does this contact and their company fit that ideal client?`,
    criteria: [
      "Poor fit: a consumer, student, job seeker, supplier, competitor, or no business need for digital marketing.",
      "Weak fit: a very small or informal business, unclear budget or decision power, or no South African presence.",
      "Good fit: an established South African business with a clear need for a website, SEO, social media or ads.",
      "Ideal fit: a decision maker (owner, MD, marketing lead) at a South African SMB with an ongoing need that suits a monthly retainer.",
    ],
  },
  intent: {
    type: "score",
    instructions: `${IDEAL_CLIENT} How strongly has this contact shown they want to buy digital marketing services from us?`,
    criteria: [
      "No intent: only added to the CRM, or talk that has nothing to do with our services.",
      "Aware: started a conversation or asked general questions, with no stated need.",
      "Considering: described a specific need, or asked about services, pricing or timelines.",
      "Ready: asked for a proposal or quote, booked a meeting, or said they want to start.",
    ],
  },
  urgency: {
    type: "score",
    instructions: `${IDEAL_CLIENT} How soon does this contact need to act?`,
    criteria: [
      "No timeline: no deadline, launch or pain mentioned.",
      "Later: interest for next quarter or sometime this year.",
      "Soon: wants to start within about a month, or has a launch or campaign coming up.",
      "Now: an urgent problem (site down, losing leads, launch this week) or asked to start immediately.",
    ],
  },
};

export function leadQuestions(): JevQuestions {
  return { ...LEAD_QUESTIONS };
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Subject and snippet only, 500 characters at most. */
export function replyState(mail: { subject: string; snippet: string }): string {
  const subject = clip(mail.subject || "(no subject)", 150);
  const head = `Subject: ${subject}\n\n`;
  return `${head}${clip(mail.snippet || "", 500 - head.length)}`;
}

export interface LeadStateInput {
  name: string;
  role: string | null;
  company: string | null;
  lifecycle: string;
  tags: string[];
  activities: string[];
}

/** Named fields for the lead score; the last three activity snippets share 800 characters. */
export function leadScoreState(input: LeadStateInput): Record<string, unknown> {
  const recent: string[] = [];
  let left = 800;
  for (const body of input.activities.slice(0, 3)) {
    if (left <= 20) break;
    const snippet = clip(body, Math.min(left, 400));
    recent.push(snippet);
    left -= snippet.length;
  }
  return {
    name: clip(input.name, 120),
    role: input.role ? clip(input.role, 80) : null,
    company: input.company ? clip(input.company, 120) : null,
    lifecycle: input.lifecycle,
    tags: input.tags.slice(0, 12),
    recentActivity: recent,
  };
}

export function scoreValue(answer: JevAnswer | undefined): number | null {
  return answer && answer.type === "score" && Number.isFinite(answer.score) ? answer.score : null;
}
