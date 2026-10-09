/**
 * Whether the SNS topic of a company's SES setup is confirmed, recorded per topic ARN in company state. T2's SNS webhook writes it (a verified
 * SubscriptionConfirmation, or the first verified Notification from the topic); readiness reads it. Changing the saved ARN starts over: the
 * record names the ARN it was made for, and a different ARN reads as not confirmed. Kept free of other Mailbox imports so config.ts can use it.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface SesTopicRecord {
  topicArn: string;
  confirmedAt: string;
}

const stateKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "mailbox-esp", stateKey: "ses-topic" });

/** True when the company's state says `topicArn` was confirmed. A read that fails is "not confirmed" (nothing is sent on a guess). */
export async function readSesTopicConfirmed(ctx: Pick<PluginContext, "state">, companyId: string, topicArn: string | null): Promise<boolean> {
  if (!topicArn) return false;
  try {
    const value = (await ctx.state.get(stateKey(companyId))) as Partial<SesTopicRecord> | null;
    return value?.topicArn === topicArn && typeof value.confirmedAt === "string";
  } catch {
    return false;
  }
}

export async function markSesTopicConfirmed(ctx: Pick<PluginContext, "state">, companyId: string, topicArn: string, nowMs: number): Promise<void> {
  await ctx.state.set(stateKey(companyId), { topicArn, confirmedAt: new Date(nowMs).toISOString() } satisfies SesTopicRecord);
}
