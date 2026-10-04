/**
 * Done-checks (kit `checkDoneOnUpdate`): when an AGENT marks one of the plugin's work issues done, the plugin checks the outcome in its own
 * tables. If the work is not finished, the issue is reopened with what is missing and the agent is woken; the third early close goes to the
 * Operator. A person's close is never checked. Approval issues are not here: a person decides those, and an agent closing one is reopened
 * (proposals.ts `onApprovalIssue`).
 *
 * | origin id                  | done when                                                                             |
 * |----------------------------|---------------------------------------------------------------------------------------|
 * | `ads-alert:<alertId>`      | the alert is acknowledged (with a note) or resolved                                   |
 * | `ads-run:<proposalId>`     | the change ran, failed, was cancelled, refused or expired, or its approval lapsed    |
 * | `ads-client-ask:<id>`      | the CRM request that asks the client is recorded, or the proposal is no longer open   |
 * | `ads-reconnect:<id>`       | the connection works again (or was removed)                                           |
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { DoneCheckResult, DoneCheckRule } from "@partnersinbiz/pib-plugin-kit";
import { getAlert, getConnection, getProposal } from "./db.js";
import { ADS_ORIGINS, OPEN_PROPOSAL_STATUSES } from "./platforms.js";

const idOf = (originId: string | null, prefix: string): string => (originId ?? "").slice(prefix.length);

async function alertDone(ctx: PluginContext, issue: { companyId: string; originId: string | null }): Promise<DoneCheckResult> {
  const alert = await getAlert(ctx, issue.companyId, idOf(issue.originId, ADS_ORIGINS.alert));
  if (!alert || alert.status !== "open") return { done: true };
  return { done: false, missing: ["The alert is still open. Say what you found with `acknowledge-ad-alert` (a one-line note), or propose the change it needs with `propose-ad-change`, then close this issue."] };
}

async function runDone(ctx: PluginContext, issue: { companyId: string; originId: string | null }): Promise<DoneCheckResult> {
  const p = await getProposal(ctx, issue.companyId, idOf(issue.originId, ADS_ORIGINS.run));
  if (!p || p.status !== "approved") return { done: true };
  return { done: false, missing: ["The approved change has not run. Call `execute-ad-change` with the proposalId and the approvalId from `get-ad-proposal`, or comment why it cannot run (the plugin's refusal says why) and ask the owner once."] };
}

async function clientAskDone(ctx: PluginContext, issue: { companyId: string; originId: string | null }): Promise<DoneCheckResult> {
  const p = await getProposal(ctx, issue.companyId, idOf(issue.originId, ADS_ORIGINS.clientAsk));
  if (!p || !OPEN_PROPOSAL_STATUSES.includes(p.status) || p.client_action_ref) return { done: true };
  return { done: false, missing: ["The client has not been asked yet. Create the request with `partnersinbiz.crm:create-client-action` (the message is in `get-ad-proposal`), then tell the plugin with `record-client-request`."] };
}

async function reconnectDone(ctx: PluginContext, issue: { companyId: string; originId: string | null }): Promise<DoneCheckResult> {
  const conn = await getConnection(ctx, issue.companyId, idOf(issue.originId, ADS_ORIGINS.reconnect));
  if (!conn || conn.status === "connected" || conn.status === "disabled") return { done: true };
  return { done: false, missing: ["The connection still needs signing in again. Only a person can do that on the Ads page (Accounts); ask the owner once with the exact screen and steps."] };
}

export const ADS_DONE_CHECKS: DoneCheckRule[] = [
  { originPrefix: ADS_ORIGINS.alert, label: "Ads alert", check: (issue, ctx) => alertDone(ctx, issue) },
  { originPrefix: ADS_ORIGINS.run, label: "Run an approved ad change", check: (issue, ctx) => runDone(ctx, issue) },
  { originPrefix: ADS_ORIGINS.clientAsk, label: "Ask the client to approve", check: (issue, ctx) => clientAskDone(ctx, issue) },
  { originPrefix: ADS_ORIGINS.reconnect, label: "Sign in again", check: (issue, ctx) => reconnectDone(ctx, issue) },
];
