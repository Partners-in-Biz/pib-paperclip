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

/** True when the company's state says the topic is confirmed. A read that fails is "not confirmed" (nothing is sent on a guess). If topicArn is provided, also checks that the saved ARN matches it. */
export async function readSesTopicConfirmed(ctx: Pick<PluginContext, "state">, companyId: string, topicArn?: string | null): Promise<boolean> {
  try {
    const value = (await ctx.state.get(stateKey(companyId))) as Partial<SesTopicRecord> | null;
    if (!value || typeof value.confirmedAt !== "string") return false;
    if (topicArn !== undefined && topicArn !== null && value.topicArn !== topicArn) return false;
    return true;
  } catch {
    return false;
  }
}

export async function markSesTopicConfirmed(ctx: Pick<PluginContext, "state">, companyId: string, topicArn: string, nowMs: number): Promise<void> {
  await ctx.state.set(stateKey(companyId), { topicArn, confirmedAt: new Date(nowMs).toISOString() } satisfies SesTopicRecord);
}

/** Clear the topic confirmation state (called when the ARN changes). */
export async function clearSesTopicConfirmed(ctx: Pick<PluginContext, "state">, companyId: string): Promise<void> {
  try {
    await ctx.state.delete(stateKey(companyId));
  } catch {
    // Already deleted or state unavailable; silently ignore
  }
}
