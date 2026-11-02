/**
 * One approval card per month for every client report (PAR-7030), instead of one issue per client.
 *
 * `send-client-report` writes an approval row per client with no issue (`payload.batch`). The 15-minute care job
 * (`openReportCards`) puts every such row of a month on ONE issue, `Approve client reports: <month>`, with one
 * request_checkbox_confirmation listing the clients. The platform sends no event when an interaction is answered
 * (plugin events cover issue/approval/agent changes only), so the same job polls `listInteractions`
 * (`settleReportCards`): a ticked client is sent through the normal queueEmail path, the others are held and named in one comment.
 *
 * A person may also close the card without ticking: done sends every client still waiting, cancelled holds them all. An
 * agent that closes it has it reopened (care-approvals.ts `onCareApprovalIssue`, unchanged rule).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { approvalReviewerBrief, openApprovalIssue } from "@partnersinbiz/pib-plugin-kit";
import { createHash } from "node:crypto";
import { approvalsByIssue, approvalsByStatus, setApprovalIssue, type ApprovalRecord } from "./care-store.js";
import { PLUGIN_ID } from "./namespace.js";
import { originFor } from "./origins.js";
import { periodLabel } from "./report-render.js";

const ORIGIN = `plugin:${PLUGIN_ID}` as const;
const KEY_PREFIX = "report-batch:";
const OPTION_LIMIT = 200;
const MAX_ROUNDS = 6;

export const reportCardTitle = (period: string) => `Approve client reports: ${periodLabel(period)}`;

export function isReportBatch(approval: ApprovalRecord): boolean {
  return approval.kind === "client_report" && approval.payload.batch === true;
}

const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim() : fallback);

function detailsFor(rows: ApprovalRecord[]): string {
  return rows
    .map((a) => `- **${text(a.payload.clientName, "Client")}**: to ${text(a.payload.to, "the contact")}, subject "${text((a.payload.draft as { subject?: string } | undefined)?.subject, "report")}"${a.payload.reportIssueId ? ` (report document on issue ${String(a.payload.reportIssueId)})` : ""}`)
    .join("\n")
    .slice(0, 19_000);
}

/** The month's card issue: the open one, or a new one (a closed card is not reopened; a late client gets round 2, 3...). */
async function cardIssue(ctx: PluginContext, companyId: string, period: string): Promise<{ id: string; pending: boolean } | null> {
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const originId = originFor.reportBatch(period, round);
    const [found] = await ctx.issues.list({ companyId, originKind: ORIGIN, originId, limit: 1 });
    if (found) {
      if (found.status === "done" || found.status === "cancelled") continue;
      const pending = (await ctx.issues.listInteractions(found.id, companyId)).some((i) => i.status === "pending" && String(i.idempotencyKey ?? "").startsWith(KEY_PREFIX));
      return { id: found.id, pending };
    }
    const description = [
      `Every client report for ${periodLabel(period)} that is ready to go out. **Tick the clients whose report may be sent** and accept the card below: the Mailbox sends those, the rest are held and named in a comment.`,
      "Only a person decides; an agent that closes this issue has it reopened.",
    ].join("\n\n");
    const checks = ["Every number and claim in each report is true for that client and month.", "Nothing internal is in an email: no ticket titles, costs, agent names or other clients.", "Each recipient is the right person at the client."];
    const opened = await openApprovalIssue(ctx, {
      companyId,
      title: reportCardTitle(period),
      description,
      originKind: ORIGIN,
      originId,
      outward: true,
      actorUserId: null,
      reviewerBrief: (route) => approvalReviewerBrief(route, "client report emails before they are sent", checks),
      wakeReason: "Client reports need checking before they are sent",
    });
    return { id: opened.id, pending: false };
  }
  return null;
}

/** Puts every uncarded client report approval of a month on its card. Returns how many were added. */
export async function openReportCards(ctx: PluginContext, companyId: string): Promise<number> {
  const waiting = (await approvalsByStatus(ctx, companyId, "open")).filter((a) => isReportBatch(a) && !a.issueId);
  const byPeriod = new Map<string, ApprovalRecord[]>();
  for (const a of waiting) byPeriod.set(text(a.payload.period, "unknown"), [...(byPeriod.get(text(a.payload.period, "unknown")) ?? []), a]);
  let added = 0;
  for (const [period, rows] of byPeriod) {
    const card = await cardIssue(ctx, companyId, period);
    if (!card || card.pending) continue; // the open card is still being answered: the late clients get the next one
    for (let i = 0; i < rows.length; i += OPTION_LIMIT) {
      const chunk = rows.slice(i, i + OPTION_LIMIT);
      const key = `${KEY_PREFIX}${period}:${createHash("sha1").update(chunk.map((a) => a.id).sort().join(",")).digest("hex").slice(0, 12)}`;
      await ctx.issues.requestCheckboxConfirmation(
        card.id,
        {
          idempotencyKey: key,
          title: reportCardTitle(period),
          continuationPolicy: "none",
          payload: {
            version: 1,
            prompt: `Tick the clients whose ${periodLabel(period)} report may be emailed now. Unticked clients are held.`,
            detailsMarkdown: detailsFor(chunk),
            options: chunk.map((a) => ({ id: a.id, label: text(a.payload.clientName, "Client").slice(0, 120), description: text(a.payload.to, "").slice(0, 500) || null })),
            defaultSelectedOptionIds: [],
            minSelected: 0,
            acceptLabel: "Send ticked reports",
            rejectLabel: "Hold all",
            allowDeclineReason: true,
          },
        },
        companyId,
      );
      for (const a of chunk) await setApprovalIssue(ctx, companyId, a.id, card.id);
      added += chunk.length;
    }
  }
  return added;
}

export interface BatchActions {
  send: (approval: ApprovalRecord, by: string) => Promise<void>;
  hold: (approval: ApprovalRecord, by: string) => Promise<void>;
}

/**
 * Applies a decision to the approvals still open on a card: those in `sendIds` go out (`"all"`: every one), the rest are held. One
 * comment names the held clients; the card is closed once nothing waits on it. Returns how many were sent.
 */
export async function decideReportCard(ctx: PluginContext, companyId: string, issueId: string, sendIds: ReadonlySet<string> | "all", by: string, actions: BatchActions, scope?: ReadonlySet<string>): Promise<number> {
  const open = (await approvalsByIssue(ctx, issueId)).filter((a) => a.companyId === companyId && a.status === "open" && (!scope || scope.has(a.id)));
  const sent: string[] = [];
  const held: string[] = [];
  for (const a of open) {
    const name = text(a.payload.clientName, "A client");
    if (sendIds === "all" || sendIds.has(a.id)) {
      await actions.send(a, by);
      sent.push(name);
    } else {
      await actions.hold(a, by);
      held.push(name);
    }
  }
  if (!open.length) return 0;
  await ctx.issues.createComment(issueId, [sent.length ? `Sent (queued in the Mailbox): ${sent.join(", ")}.` : "", held.length ? `Held, nothing was sent to: ${held.join(", ")}. Ask for their report again with send-client-report when it is ready.` : ""].filter(Boolean).join("\n\n"), companyId).catch(() => undefined);
  if (!(await approvalsByIssue(ctx, issueId)).some((a) => a.status === "open")) await ctx.issues.update(issueId, { status: "done" }, companyId).catch(() => undefined);
  return sent.length;
}

/** Care job: finds answered cards and applies them. Returns how many clients were decided. */
export async function settleReportCards(ctx: PluginContext, companyId: string, actions: BatchActions): Promise<number> {
  const issueIds = new Set((await approvalsByStatus(ctx, companyId, "open")).filter((a) => isReportBatch(a) && a.issueId).map((a) => a.issueId as string));
  let decided = 0;
  for (const issueId of issueIds) {
    const answered = (await ctx.issues.listInteractions(issueId, companyId)).filter((i) => i.kind === "request_checkbox_confirmation" && i.status !== "pending" && String(i.idempotencyKey ?? "").startsWith(KEY_PREFIX));
    for (const interaction of answered) {
      const payload = interaction.payload as { options?: Array<{ id: string }> };
      const scope = new Set((payload.options ?? []).map((o) => o.id));
      const result = interaction.result as { selectedOptionIds?: string[] } | null | undefined;
      const picked = interaction.status === "accepted" ? new Set(result?.selectedOptionIds ?? []) : new Set<string>();
      const by = interaction.status === "accepted" || interaction.status === "rejected" ? "user:report-card" : "system:report-card";
      const before = (await approvalsByIssue(ctx, issueId)).filter((a) => a.status === "open" && scope.has(a.id)).length;
      await decideReportCard(ctx, companyId, issueId, picked, by, actions, scope);
      decided += before;
    }
  }
  return decided;
}
