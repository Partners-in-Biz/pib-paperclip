/**
 * A sent campaign for the CANARY client, for QA to check the Results section against (PAR-15070).
 *
 * Nothing is sent: it writes the events a real send would have recorded, on addresses at `canary.invalid` (which can
 * never receive mail), and only for a client whose id starts with `canary-`. Asking again changes nothing (fixed ids,
 * events keyed once), so the numbers below stay what they are.
 *
 * Step 1 has versions A and B, step 2 has A only. Hand count:
 *   step 1 A: 3 sent, 3 delivered, 2 opens, 1 click, 1 reply (with text)
 *   step 1 B: 3 sent, 2 delivered, 1 open, 1 hard bounce, 1 complaint
 *   step 2 A: 2 sent, 2 delivered, 1 unsubscribe (opt-out)
 */
import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { addSuppression, getCampaign, insertCampaign, insertEnrollment, insertStep, insertStepEventOnce, listSteps, enrollmentById, stepEventStats, stepEventStatsByVersion, type StepEventType } from "./db.js";
import { createCampaign, CampaignError, type EnrollmentDraft } from "./domain.js";

const CANARY_PREFIX = "canary-";
const CANARY_DOMAIN = "canary.invalid";
export const FIXTURE_REPLY_TEXT = "Yes please, send me the details. (canary fixture reply)";

const PEOPLE = [1, 2, 3, 4, 5, 6].map((n) => ({ n, contactId: `${CANARY_PREFIX}fx-contact-${n}`, email: `fx${n}@${CANARY_DOMAIN}` }));
// contact -> its version on step 1 (1-3 see A, 4-6 see B).
const variantOf = (n: number) => (n <= 3 ? "a" : "b");

type Plan = { n: number; step: number; type: StepEventType; meta?: Record<string, unknown> };
const PLAN: Plan[] = [
  ...[1, 2, 3, 4, 5, 6].map((n): Plan => ({ n, step: 1, type: "sent" })),
  ...[1, 2, 3, 4, 5].map((n): Plan => ({ n, step: 1, type: "delivered" })),
  { n: 1, step: 1, type: "open" }, { n: 2, step: 1, type: "open" }, { n: 4, step: 1, type: "open" },
  { n: 1, step: 1, type: "click" },
  { n: 1, step: 1, type: "reply", meta: { snippet: FIXTURE_REPLY_TEXT } },
  { n: 6, step: 1, type: "bounce" },
  { n: 5, step: 1, type: "complaint" },
  { n: 1, step: 2, type: "sent" }, { n: 2, step: 2, type: "sent" },
  { n: 1, step: 2, type: "delivered" }, { n: 2, step: 2, type: "delivered" },
  { n: 2, step: 2, type: "unsubscribe" },
];

export function canaryClientId(client: string): string {
  const id = client.trim().replace(/^company:/, "");
  if (!id.startsWith(CANARY_PREFIX)) throw new CampaignError("The results fixture is for the canary client only: pass client as company:canary-<id>, as create-canary-client returned it.");
  return id;
}

export async function seedCanaryResultsFixture(ctx: PluginContext, companyId: string, params: { client: string }) {
  const clientId = canaryClientId(params.client);
  const campaignId = `${CANARY_PREFIX}fx-results-${createHash("sha256").update(`${companyId}:${clientId}`).digest("hex").slice(0, 8)}`;

  let campaign = await getCampaign(ctx, campaignId);
  const created = !campaign;
  if (!campaign) {
    campaign = {
      ...createCampaign({
        id: campaignId, companyId, name: "Canary Results fixture (sent)", description: "Seeded for the Results check. Nothing was sent; every address is at canary.invalid.",
        fromName: "PiB Canary", fromLocal: "canary", client: { kind: "company", id: clientId, name: "PiB Canary Co" }, delivery: "email",
      }),
      status: "active",
    };
    await insertCampaign(ctx, campaign);
  }
  if ((await listSteps(ctx, campaignId)).length === 0) {
    const copy = (position: number, variant: "a" | "b", subject: string) => ({ position, delayDays: position === 1 ? 0 : 3, subject, body: `${subject} (canary fixture body)`, htmlBody: null, variant });
    for (const step of [copy(1, "a", "Canary hello A"), copy(1, "b", "Canary hello B"), copy(2, "a", "Canary follow-up")]) await insertStep(ctx, { companyId, campaignId, step });
  }
  const enrollmentId = (n: number) => `${campaignId}-e${n}`;
  for (const p of PEOPLE) {
    if (await enrollmentById(ctx, enrollmentId(p.n))) continue;
    const enrollment: EnrollmentDraft = {
      id: enrollmentId(p.n), companyId, campaignId, contactId: p.contactId,
      status: p.n === 2 || p.n === 6 ? "stopped" : "running", stepPosition: p.n <= 2 ? 2 : 1, variant: variantOf(p.n), nextDueAt: null, openIssueId: null,
    };
    await insertEnrollment(ctx, enrollment);
  }
  for (const [i, e] of PLAN.entries()) {
    await insertStepEventOnce(ctx, {
      companyId, campaignId, enrollmentId: enrollmentId(e.n), stepPosition: e.step, eventType: e.type,
      variant: e.step === 1 ? variantOf(e.n) : "a", sourceKey: `${campaignId}:${i}`, meta: e.meta ?? null,
    });
  }
  // The opt-out and the hard bounce also leave the address on the suppression list, as a real one does.
  const suppress = (n: number, reason: "unsubscribe" | "bounce", scope: "marketing" | "all") =>
    addSuppression(ctx, { companyId, email: PEOPLE[n - 1]!.email, reason, scope, source: "canary-fixture", contactId: PEOPLE[n - 1]!.contactId, campaignId, senderKey: `company:${clientId}` });
  await suppress(2, "unsubscribe", "marketing");
  await suppress(6, "bounce", "all");

  return {
    campaignId,
    created,
    client: `company:${clientId}`,
    byStep: await stepEventStats(ctx, campaignId),
    byVersion: await stepEventStatsByVersion(ctx, campaignId),
    replyText: FIXTURE_REPLY_TEXT,
    expected: {
      "step 1 A": { sent: 3, delivered: 3, opens: 2, clicks: 1, replies: 1 },
      "step 1 B": { sent: 3, delivered: 2, opens: 1, bounces: 1, complaints: 1 },
      "step 2 A": { sent: 2, delivered: 2, unsubscribes: 1 },
      "step totals": { "step 1": { sent: 6, delivered: 5, opens: 3, clicks: 1, replies: 1, bounces: 1, complaints: 1 }, "step 2": { sent: 2, delivered: 2, unsubscribes: 1 } },
    },
    note: "Nothing was sent. Read the same numbers again with campaign-step-analytics (per step) or campaign-results (per step and version).",
  };
}
