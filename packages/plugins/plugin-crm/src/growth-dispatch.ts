/**
 * The attribution and site events tools and page actions in one table. The worker sends any tool name it does not know here
 * after the care and e-sign tools.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { attributionReportTool, listClientLeadsTool, recordChannelCostTool, recordLeadOutcomeTool } from "./attribution.js";
import type { Viewer } from "./domain.js";
import { createEventKey, listEventKeysTool, rotateEventKey, siteEventsReportTool, updateEventKey } from "./site-events.js";

type Source = "agent" | "human";
type Handler = (ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: Source) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  "attribution-report": (ctx, viewer, params) => attributionReportTool(ctx, viewer, params),
  "record-channel-cost": (ctx, viewer, params) => recordChannelCostTool(ctx, viewer, params),
  "list-client-leads": (ctx, viewer, params) => listClientLeadsTool(ctx, viewer, params),
  "record-lead-outcome": (ctx, viewer, params) => recordLeadOutcomeTool(ctx, viewer, params),
  "create-event-key": (ctx, viewer, params) => createEventKey(ctx, viewer, params),
  "list-event-keys": (ctx, viewer, params) => listEventKeysTool(ctx, viewer, params),
  "update-event-key": (ctx, viewer, params, source) => updateEventKey(ctx, viewer, params, source),
  "rotate-event-key": (ctx, viewer, params) => rotateEventKey(ctx, viewer, params),
  "site-events-report": (ctx, viewer, params) => siteEventsReportTool(ctx, viewer, params),
};

export const GROWTH_TOOL_NAMES: readonly string[] = Object.keys(HANDLERS);

export function isGrowthTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(HANDLERS, name);
}

export async function runGrowthTool(ctx: PluginContext, viewer: Viewer, name: string, params: Record<string, unknown>, source: Source): Promise<unknown> {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown growth tool ${name}`);
  return handler(ctx, viewer, params, source);
}
