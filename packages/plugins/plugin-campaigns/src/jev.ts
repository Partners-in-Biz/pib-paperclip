/**
 * Jev for campaign replies: only the subject and snippet (≤500 chars) are
 * sent. Without a key `decide` returns null and a person decides.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { decisionConfig, readConfig, SecretResolver, type DecisionClientConfig, type JevQuestions } from "@partnersinbiz/pib-plugin-kit";

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: DecisionClientConfig | null }>();

/** Jev settings for a company (null without a key), cached for five minutes to respect the secret-resolve limit. */
export async function jevConfigFor(ctx: PluginContext, companyId: string): Promise<DecisionClientConfig | null> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value: DecisionClientConfig | null = null;
  try {
    const config = await readConfig(ctx, companyId);
    value = await decisionConfig(new SecretResolver(ctx, companyId, config), config);
  } catch (error) {
    ctx.logger.info("Jev settings could not be read; replies go to a person", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
  cache.set(companyId, { at: Date.now(), value });
  return value;
}

export function clearJevCache(): void {
  cache.clear();
}

export const REPLY_QUESTIONS: JevQuestions = {
  reply_kind: {
    type: "choice",
    instructions:
      "The state is an email a contact sent back after we emailed them from a marketing campaign. Which kind of reply is it?",
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

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function replyState(mail: { subject: string; snippet: string }): string {
  const head = `Subject: ${clip(mail.subject || "(no subject)", 150)}\n\n`;
  return `${head}${clip(mail.snippet || "", 500 - head.length)}`;
}
