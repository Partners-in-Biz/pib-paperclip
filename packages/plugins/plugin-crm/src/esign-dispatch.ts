/**
 * The e-sign tools and page actions in one table, and the Agreements card the client page shows. The worker sends any tool
 * name it does not know here after the care tools.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ClientKey } from "./care-store.js";
import type { Viewer } from "./domain.js";
import {
  createSignDocumentTool,
  disableEsign,
  docSummary,
  enableEsign,
  esignAccess,
  getSignDocumentTool,
  listSignDocumentsTool,
  sendForSignatureTool,
  signTemplatesTool,
  verifySignDocumentTool,
  voidSignDocumentTool,
} from "./esign.js";
import { listDocs } from "./esign-store.js";
import { TEMPLATE_VERSION } from "./esign-templates.js";

type Source = "agent" | "human";
type Handler = (ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: Source) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  "sign-templates": async (_ctx, _viewer, params) => signTemplatesTool(params),
  "create-sign-document": (ctx, viewer, params) => createSignDocumentTool(ctx, viewer, params),
  "send-for-signature": (ctx, viewer, params, source) => sendForSignatureTool(ctx, viewer, params, source),
  "list-sign-documents": (ctx, viewer, params) => listSignDocumentsTool(ctx, viewer, params),
  "get-sign-document": (ctx, viewer, params) => getSignDocumentTool(ctx, viewer, params),
  "void-sign-document": (ctx, viewer, params) => voidSignDocumentTool(ctx, viewer, params),
  "verify-sign-document": (ctx, viewer, params) => verifySignDocumentTool(ctx, viewer, params),
};

/** Page actions with no agent tool: turning e-sign on or off for a client is the owner's gate, so only a person can. */
const PERSON_ONLY: Record<string, Handler> = {
  "enable-esign": (ctx, viewer, params, source) => enableEsign(ctx, viewer, params, source),
  "disable-esign": (ctx, viewer, params, source) => disableEsign(ctx, viewer, params, source),
};

export const ESIGN_TOOL_NAMES: readonly string[] = Object.keys(HANDLERS);
export const ESIGN_PERSON_ACTIONS: readonly string[] = Object.keys(PERSON_ONLY);

export function isEsignTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(HANDLERS, name);
}

export async function runEsignTool(ctx: PluginContext, viewer: Viewer, name: string, params: Record<string, unknown>, source: Source): Promise<unknown> {
  const handler = HANDLERS[name] ?? PERSON_ONLY[name];
  if (!handler) throw new Error(`Unknown e-sign tool ${name}`);
  return handler(ctx, viewer, params, source);
}

/** What the client page's Agreements card shows: whether e-sign is on, and the client's documents (no links, no addresses beyond the recipient). */
export async function clientAgreementsView(ctx: PluginContext, companyId: string, client: ClientKey) {
  const access = await esignAccess(ctx, companyId, client);
  const docs = await listDocs(ctx, companyId, client, 30);
  return {
    allowed: access.allowed,
    canary: access.canary,
    enabledBy: access.enabled?.enabledBy ?? null,
    enabledAt: access.enabled?.enabledAt ?? null,
    templatesReviewed: access.enabled?.templatesReviewed ?? false,
    templateVersion: TEMPLATE_VERSION,
    documents: docs.map(docSummary),
  };
}
