/**
 * Billing's approvals, routed by the kit so none can end unassigned (audit Q5-6).
 *
 * Before 0.6 Billing read the owner from its own copy of the Cockpit's roles and opened an issue
 * with whatever that returned, which was nothing for five days (the copy was frozen on its first
 * broadcast), so money decisions and send approvals could sit unassigned and unseen. Every
 * approval now goes through the kit's `openApprovalIssue`: the Reviewer first for work that leaves
 * the company (an invoice, a quote, a reminder) when the company reviews it, then the person who
 * decides (the roles copy, the host's default responsible user, the person who asked, the last owner
 * seen), then the Operator, and only then nobody, which is said on the issue and logged.
 *
 * Billing's own setting "Who approves Billing" (`reviewerUserId`) wins over the owner: it names the
 * person for sends, payment checks, bank matches, payments and credit notes. The kit has no
 * per-call approver, so a configured approver with no Reviewer in the way gets the issue directly,
 * and falls back to the kit's chain if the host refuses that person.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { assignableUserId, createWorkIssue, openApprovalIssue, PIB_PLUGINS, resolveApprover, type ApprovalAssignedTo } from "@partnersinbiz/pib-plugin-kit";
import type { BillingSettings } from "./config.js";

export interface BillingApprovalInput {
  companyId: string;
  title: string;
  description: string;
  /** One of `APPROVAL_ORIGINS` plus the subject id. */
  originId: string;
  /** Work that leaves the company (an invoice, quote or reminder email): the Reviewer checks it first when the company reviews outward work. */
  outward: boolean;
  priority?: "low" | "medium" | "high" | "critical";
  /** The person who asked from a page, when there is one (a last-resort approver). */
  actorUserId?: string | null;
  /** The Reviewer's brief, given the person it hands the issue to. */
  brief?: (approverUserId: string | null) => string;
}

export interface BillingApproval {
  id: string;
  assignedTo: ApprovalAssignedTo;
  /** The Reviewer holds it first. */
  reviewer: boolean;
  approver: string | null;
}

export function configuredApprover(settings: BillingSettings): string | null {
  return assignableUserId(typeof settings.reviewerUserId === "string" ? settings.reviewerUserId : null);
}

export async function openBillingApproval(ctx: PluginContext, settings: BillingSettings, input: BillingApprovalInput): Promise<BillingApproval> {
  const configured = configuredApprover(settings);
  const route = await resolveApprover(ctx, input.companyId, { outward: input.outward, actorUserId: input.actorUserId ?? null });
  const approver = configured ?? route.approverUserId;
  const kitInput = {
    companyId: input.companyId,
    title: input.title,
    description: input.description,
    originKind: `plugin:${PIB_PLUGINS.billing}`,
    originId: input.originId,
    ...(input.priority ? { priority: input.priority } : {}),
    outward: input.outward,
    actorUserId: input.actorUserId ?? null,
    ...(input.brief ? { reviewerBrief: () => input.brief!(approver) } : {}),
  };
  if (route.reviewerAgentId || !configured) {
    const opened = await openApprovalIssue(ctx, kitInput);
    return { id: opened.id, assignedTo: opened.assignedTo, reviewer: opened.assignedTo === "reviewer", approver };
  }
  try {
    const created = await createWorkIssue(ctx, {
      companyId: input.companyId,
      title: input.title,
      description: input.description,
      originKind: `plugin:${PIB_PLUGINS.billing}` as never,
      originId: input.originId,
      ...(input.priority ? { priority: input.priority } : {}),
      assigneeUserId: configured,
      wake: false,
    } as Parameters<typeof createWorkIssue>[1]);
    return { id: created.id, assignedTo: "person", reviewer: false, approver: configured };
  } catch (error) {
    // The configured person was refused (left the company, say): the kit's chain still finds someone and says so when it cannot.
    ctx.logger.info("The configured Billing approver was refused; using the company's approver", { error: error instanceof Error ? error.message : String(error) });
    const opened = await openApprovalIssue(ctx, kitInput);
    return { id: opened.id, assignedTo: opened.assignedTo, reviewer: opened.assignedTo === "reviewer", approver: route.approverUserId };
  }
}
