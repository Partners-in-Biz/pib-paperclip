/**
 * The client care tools and page actions in one table, and the care card the
 * client page shows. The worker sends any tool name it does not know here first.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientContacts, clientInfo, primaryEmail } from "./care-clients.js";
import { consentSummary } from "./consent.js";
import type { ClientKey } from "./care-store.js";
import { clientActionViews, createClientAction, listClientActionsTool, updateClientAction } from "./client-actions.js";
import { recordClientSignalTool } from "./client-signals.js";
import type { Viewer } from "./domain.js";
import { clientHealthTool, clientHealthView } from "./health-score.js";
import { monitorViews, setSiteMonitoringTool } from "./monitor.js";
import { exportPersonDataTool, recordConsentTool, requestErasureTool } from "./privacy.js";
import { listDataProcessingTool, sensitivityOf, setClientSensitivityTool } from "./register.js";
import { buildClientReportTool, listClientReportsTool, reportViews, sendClientReportTool, setReportNarrativeTool, skipClientReportTool } from "./report.js";
import { caseViews, feedbackViews, listSupportCasesTool, openSupportCaseTool, recordFeedbackTool, requestFeedbackTool, updateSupportCaseTool } from "./support.js";
import { parseClientRef, requireClient } from "./lookup.js";

type Source = "agent" | "human";
type Handler = (ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: Source) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  "build-client-report": (ctx, viewer, params) => buildClientReportTool(ctx, viewer, params),
  "record-client-signal": (ctx, viewer, params) => recordClientSignalTool(ctx, viewer, params),
  "set-report-narrative": (ctx, viewer, params) => setReportNarrativeTool(ctx, viewer, params),
  "send-client-report": (ctx, viewer, params) => sendClientReportTool(ctx, viewer, params),
  "skip-client-report": (ctx, viewer, params) => skipClientReportTool(ctx, viewer, params),
  "list-client-reports": (ctx, viewer, params) => listClientReportsTool(ctx, viewer, params),
  "open-support-case": (ctx, viewer, params) => openSupportCaseTool(ctx, viewer, params),
  "update-support-case": (ctx, viewer, params) => updateSupportCaseTool(ctx, viewer, params),
  "list-support-cases": (ctx, viewer, params) => listSupportCasesTool(ctx, viewer, params),
  "request-feedback": (ctx, viewer, params) => requestFeedbackTool(ctx, viewer, params),
  "record-feedback": (ctx, viewer, params) => recordFeedbackTool(ctx, viewer, params),
  "client-health": (ctx, viewer, params) => clientHealthTool(ctx, viewer, params),
  "create-client-action": (ctx, viewer, params, source) => createClientAction(ctx, viewer, params, source),
  "update-client-action": (ctx, viewer, params) => updateClientAction(ctx, viewer, params),
  "list-client-actions": (ctx, viewer, params) => listClientActionsTool(ctx, viewer, params),
  "site-monitoring": async (ctx, viewer, params) => {
    const client = parseClientRef(params.client);
    await requireClient(ctx, viewer, client);
    return { client: `${client.kind}:${client.id}`, sites: await monitorViews(ctx, viewer.companyId, client) };
  },
  "set-site-monitoring": (ctx, viewer, params) => setSiteMonitoringTool(ctx, viewer, params),
  "record-consent": (ctx, viewer, params) => recordConsentTool(ctx, viewer, params),
  "export-person-data": (ctx, viewer, params) => exportPersonDataTool(ctx, viewer, params),
  "request-erasure": (ctx, viewer, params) => requestErasureTool(ctx, viewer, params),
  "list-data-processing": (ctx, viewer, params) => listDataProcessingTool(ctx, viewer, params),
  "set-client-sensitivity": (ctx, viewer, params, source) => setClientSensitivityTool(ctx, viewer, params, source),
};

export const CARE_TOOL_NAMES: readonly string[] = Object.keys(HANDLERS);

export function isCareTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(HANDLERS, name);
}

/** Runs a care tool for a viewer. */
export async function runCareTool(ctx: PluginContext, viewer: Viewer, name: string, params: Record<string, unknown>, source: Source): Promise<unknown> {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown care tool ${name}`);
  return handler(ctx, viewer, params, source);
}

/** Why the client's people may be contacted: the consent and basis on file for each, newest first (no address, no hash). */
async function consentViews(ctx: PluginContext, companyId: string, client: ClientKey) {
  const out: Array<{ person: string; purpose: string; basis: string; granted: boolean; source: string; recordedAt: string; expiresAt: string | null }> = [];
  for (const person of (await clientContacts(ctx, companyId, client)).slice(0, 10)) {
    const email = primaryEmail(person);
    if (!email) continue;
    for (const row of await consentSummary(ctx, companyId, email)) out.push({ person: person.name, purpose: row.purpose, basis: row.basis, granted: row.granted, source: row.source, recordedAt: row.recordedAt, expiresAt: row.expiresAt });
  }
  return out.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1)).slice(0, 20);
}

/** What the client page's care card shows for one client. Each part is read on its own: one failing never hides the rest. */
export async function clientCareView(ctx: PluginContext, companyId: string, client: ClientKey) {
  const part = async <T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      ctx.logger.info("CRM care card part failed", { part: label, error: error instanceof Error ? error.message : String(error) });
      return fallback;
    }
  };
  const info = await clientInfo(ctx, companyId, client);
  const [health, cases, actions, reports, sites, feedback, sensitivity, consent] = await Promise.all([
    part("health", () => clientHealthView(ctx, companyId, client), null),
    part("cases", () => caseViews(ctx, companyId, client), []),
    part("actions", () => clientActionViews(ctx, companyId, client), []),
    part("reports", () => reportViews(ctx, companyId, client), []),
    part("sites", () => monitorViews(ctx, companyId, client), []),
    part("feedback", () => feedbackViews(ctx, companyId, client), { items: [], nps: null }),
    part("sensitivity", () => sensitivityOf(ctx, companyId, client), { level: "standard" as const, reason: null, updatedAt: null, keepOffSystems: [] }),
    part("consent", () => consentViews(ctx, companyId, client), []),
  ]);
  return { customer: info?.lifecycle === "customer", health, cases, actions, reports, sites, feedback, sensitivity, consent };
}
