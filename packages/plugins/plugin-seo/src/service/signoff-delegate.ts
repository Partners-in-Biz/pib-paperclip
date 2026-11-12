/**
 * PAR-10548 T6: tell the sign-off delegate. A one-task sign-off (review or pr) that the delegate's own grant gate would let
 * it approve (cockpit `delegateWaitsOn`, the same check as the Cockpit's `waitsOn`) is hidden from the owner's list, so
 * somebody has to be told. One issue per sprint, assigned to the delegate, lists those sign-offs and the call to make.
 * Growing set: a comment and a wake. Shrinking set: the description only. Empty set: the issue is cancelled.
 * Nothing here decides who may approve: the gate still runs on approve-page-apply, and a person can still decide.
 */
import { wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import { delegateWaitsOn, SIGNOFF_KINDS } from "../cockpit.js";
import { ORIGIN } from "../constants.js";
import * as db from "../db.js";
import { sprintLabel } from "../engine/copy.js";
import { openItems } from "../engine/needs-you.js";
import { isRehearsalSprint } from "../engine/rehearsal.js";
import { companyInfo, errorMessage, type Env } from "./common.js";
import { commentOn, getIssue, OPEN_ISSUE_STATUSES, openIssue, patchIssue } from "./issues.js";
import { currentDigest } from "./needs-you.js";
import { delegateAgentIds } from "./signoff.js";

export interface DelegateSignoff {
  key: string;
  title: string;
  taskId: string;
}

const originId = (sprintId: string) => `signoff-delegate:${sprintId}`;
const KEY_LINE = /Needs you key: `([^`]+)`/g;

function describe(sprint: db.Sprint, items: DelegateSignoff[]): string {
  return [
    `Client: ${sprintLabel(sprint)}. Sprint: ${sprint.id}.`,
    "",
    "These sign-offs are yours to decide. Each page change has passed the Reviewer, and you may approve it under the SEO setting for sign-off delegates.",
    "",
    ...items.flatMap((i) => [`- ${i.title}`, `  Task: ${i.taskId}`, `  Needs you key: \`${i.key}\``]),
    "",
    `Call \`partnersinbiz.seo:approve-page-apply\` with sprintId \`${sprint.id}\`, the task id, the task's pages, a note, and needsYouKey set to the key above. The item then closes.`,
    "",
    "A person can still decide any of these too. If a call is refused, leave the item: it stays with the owner.",
  ].join("\n");
}

/** The sign-offs this sprint's delegate may act on now: open, one task, and the grant gate says yes. */
async function grantable(env: Env, sprint: db.Sprint, delegate: string): Promise<DelegateSignoff[]> {
  const info = await companyInfo(env, sprint.companyId);
  const digest = await currentDigest(env, info, sprint, "read");
  const out: DelegateSignoff[] = [];
  for (const item of digest ? openItems(digest.items) : []) {
    const taskId = item.taskIds?.length === 1 ? item.taskIds[0]! : null;
    if (!taskId || !SIGNOFF_KINDS.has(item.kind)) continue;
    if (await delegateWaitsOn(env, sprint.companyId, sprint.id, taskId, delegate)) out.push({ key: item.key, title: item.title, taskId });
  }
  return out;
}

type IssueRow = { id: string; status?: unknown; description?: string | null; createdAt?: unknown };

export async function syncSignoffDelegateIssue(env: Env, companyId: string, sprintId: string): Promise<void> {
  const sprint = await db.getSprint(env.ctx.db, companyId, sprintId);
  if (!sprint || isRehearsalSprint(sprint)) return;
  const delegate = (await delegateAgentIds(env, companyId))[0] ?? null;
  const items = delegate ? await grantable(env, sprint, delegate) : [];
  const found = (await env.ctx.issues.list({ companyId, originKind: ORIGIN.signoffDelegate, originId: originId(sprintId), limit: 20 })) as IssueRow[];
  const open = found
    .filter((i) => OPEN_ISSUE_STATUSES.has(String(i.status)))
    .sort((a, b) => (Date.parse(String(a.createdAt)) || 0) - (Date.parse(String(b.createdAt)) || 0) || a.id.localeCompare(b.id));
  // Two open issues for one sprint (two syncs raced): keep the oldest, cancel the newer.
  for (const extra of open.slice(1)) await patchIssue(env, companyId, extra.id, { status: "cancelled" });
  const current = open[0] ?? null;

  if (items.length === 0) {
    if (!current) return;
    await commentOn(env, companyId, current.id, "No sign-off is left for the delegate (decided, or no longer yours to approve). Closing this issue.");
    await patchIssue(env, companyId, current.id, { status: "cancelled" });
    return;
  }
  if (!current) {
    await openIssue(env, {
      companyId,
      sprint,
      title: `Sign-offs for you: ${sprintLabel(sprint)} (${items.length})`.slice(0, 250),
      description: describe(sprint, items),
      originKind: ORIGIN.signoffDelegate,
      originId: originId(sprintId),
      ...((sprint.clientProjectId ?? sprint.projectId) ? { projectId: sprint.clientProjectId ?? sprint.projectId } : {}),
      assigneeAgentId: delegate,
      priority: "medium",
      wake: true,
      wakeReason: "Sign-offs are waiting for you (sign-off delegate)",
    });
    return;
  }
  const issue = (await getIssue(env, companyId, current.id)) as IssueRow | null;
  const before = new Set([...String(issue?.description ?? current.description ?? "").matchAll(KEY_LINE)].map((m) => m[1]!));
  const added = items.filter((i) => !before.has(i.key));
  const description = describe(sprint, items);
  if (description === (issue?.description ?? current.description)) return;
  await patchIssue(env, companyId, current.id, { description, title: `Sign-offs for you: ${sprintLabel(sprint)} (${items.length})`.slice(0, 250) });
  if (added.length === 0) return;
  await commentOn(env, companyId, current.id, `New sign-off${added.length === 1 ? "" : "s"} for you: ${added.map((i) => `**${i.title}** (key \`${i.key}\`)`).join("; ")}.`);
  await wakeIssue(env.ctx, current.id, companyId, "A new sign-off is waiting for you (sign-off delegate)");
}

/** After a Needs you change or the daily job: a failure here never breaks the caller. */
export async function tellSignoffDelegate(env: Env, companyId: string, sprintId: string): Promise<void> {
  try {
    await syncSignoffDelegateIssue(env, companyId, sprintId);
  } catch (error) {
    env.ctx.logger.info("SEO sign-off delegate issue not synced", { sprintId, error: errorMessage(error) });
  }
}
