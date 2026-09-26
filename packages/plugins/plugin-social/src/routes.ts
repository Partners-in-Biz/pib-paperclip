/**
 * Cross-plugin API routes.
 *
 * `GET /client-summary?companyId=&kind=&id=` feeds the Social tile of the CRM
 * client workspace (`ClientSummary`: a headline and a few stats). The host
 * resolved `companyId` from the query and checked the board user's access to
 * it; only that company's rows are read.
 */
import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import { isClientKind, parseClientParam } from "@partnersinbiz/pib-plugin-kit";
import { clientSummaryRecord } from "./service.js";

function queryValue(query: Record<string, string | string[]> | undefined, key: string): string {
  const value = query?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export async function handleClientSummary(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  if (!input.companyId) return { status: 400, body: { error: "companyId is required" } };
  const kind = queryValue(input.query, "kind");
  const id = queryValue(input.query, "id");
  if (!isClientKind(kind)) return { status: 400, body: { error: 'kind must be "company" or "contact"' } };
  const scope = parseClientParam(`${kind}:${id}`);
  if (!scope) return { status: 400, body: { error: "id is missing or not a valid CRM id" } };
  try {
    return { status: 200, body: await clientSummaryRecord(ctx, input.companyId, scope) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.info("Social client summary failed", { error: message });
    return { status: 500, body: { error: message } };
  }
}
