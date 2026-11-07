/**
 * A client's brand kit for Studio (PAR-8134), read from the CRM over the event bus (kit's `requestBrandKit`).
 * Studio never adds it to a generation by itself: the page shows it and a person presses "Add to prompt", and an
 * agent gets the same `promptText` back and puts it in its own prompt. Either way the words sent are the words shown.
 * The client is checked first (a known CRM client, and for agents the client of the issue's project), and the CRM
 * reply must name that same client, so one client's kit never reaches another client's work.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { brandKitPrompt, formatClientParam, requestBrandKit, type BrandKit, type BrandKitResult, type BrandKitTarget } from "@partnersinbiz/pib-plugin-kit";
import { StudioError } from "./errors.js";
import type { ResolvedScope } from "./scope.js";

export const BRAND_KIT_TIMEOUT_MS = 15_000;

export type BrandKitReader = (ctx: Pick<PluginContext, "events">, t: BrandKitTarget) => Promise<BrandKitResult>;

export interface BrandKitView {
  client: string | null;
  clientName: string | null;
  /** Null for own work: it has no brand kit. */
  kit: BrandKit | null;
  /** The exact text "Add to prompt" adds. Empty when the kit has nothing a model can use. */
  promptText: string;
  note: string;
}

function failure(result: Exclude<BrandKitResult, { status: "read" }>): StudioError {
  if (result.status === "no_ack") return new StudioError("The CRM didn't answer for the brand kit. Try again in a minute.", "brand_kit_no_ack");
  if (result.reason === "no_profile") return new StudioError("This client has no CRM profile yet, so there is no brand kit. Fill it in on the client's CRM page.", "no_brand_kit");
  if (result.reason === "wrong_client") return new StudioError("The CRM answered for a different client, so Studio didn't use it.", "wrong_client");
  return new StudioError(`Couldn't read the brand kit (${result.reason}).`, "brand_kit_failed");
}

export async function brandKitFor(ctx: Pick<PluginContext, "events">, companyId: string, where: ResolvedScope, reader: BrandKitReader = requestBrandKit): Promise<BrandKitView> {
  if (!where.scope) return { client: null, clientName: null, kit: null, promptText: "", note: "Own work has no client, so there is no brand kit." };
  const result = await reader(ctx, { companyId, client: { kind: where.scope.kind, ref: where.scope.id }, timeoutMs: BRAND_KIT_TIMEOUT_MS });
  if (result.status !== "read") throw failure(result);
  const promptText = brandKitPrompt(result.kit);
  const notes = [
    promptText ? "Nothing is added to a generation until you add this text to the prompt." : "This client's brand kit is empty. Fill it in on the client's CRM page.",
    result.kit.hasLogo ? "The CRM has a logo for this client; Studio can't use it as a reference yet. Add it from Drive or the library." : "",
  ].filter(Boolean);
  return { client: formatClientParam(where.scope), clientName: where.client?.name ?? null, kit: result.kit, promptText, note: notes.join(" ") };
}
