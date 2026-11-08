/**
 * The worker side of the Text and Layout cards. A finished page is saved like any other library file, under the board's
 * client. An agent's words wait in plugin state until the open board takes them in, because an agent saving the board
 * itself would clash with whoever has it open.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import { storeAsset } from "./assets.js";
import { MAX_TEXT } from "./canvas-rules.js";
import { getCanvas } from "./canvas.js";
import { StudioConfig } from "./config.js";
import { StudioError } from "./errors.js";
import { assertReachable } from "./scope.js";
import { sniffMime } from "./storage.js";

/** The server takes 10 MB of JSON at a time, and base64 adds a third. A 300 dpi page as a JPEG is far smaller. */
const MAX_PAGE_BYTES = 7 * 1024 * 1024;

const scopeOf = (client: { kind: string | null; id: string } | null) => (client ? ({ kind: client.kind, id: client.id } as never) : null);

export async function saveLayoutPage(ctx: PluginContext, companyId: string, params: Record<string, unknown>, userId: string | null): Promise<{ assetId: string }> {
  const canvasId = String(params.canvasId ?? "").trim();
  const cardId = String(params.cardId ?? "").trim();
  const board = await getCanvas(ctx, companyId, canvasId);
  if (!board.doc.nodes.some((n) => n.id === cardId && n.type === "layout")) throw new StudioError("That Layout card isn't saved on this board yet. Wait a moment and try again.", "unknown_card");
  const base64 = typeof params.base64 === "string" ? params.base64 : "";
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.length === 0) throw new StudioError("The page came through empty. Try again.", "bad_page");
  if (bytes.length > MAX_PAGE_BYTES) throw new StudioError("That page is too large to save. Try a smaller size, or download it instead.", "bad_page");
  const mime = sniffMime(bytes);
  if (mime !== "image/jpeg" && mime !== "image/png") throw new StudioError("Only a finished picture can be saved here.", "bad_page");
  const name = (typeof params.name === "string" && params.name.trim() ? params.name.trim() : "Page").slice(0, 200);
  const assetId = await storeAsset(ctx, new StudioConfig(ctx, companyId), {
    id: randomUUID(),
    companyId,
    scope: scopeOf(board.client),
    clientName: board.client?.name ?? null,
    projectId: board.projectId ?? null,
    issueId: null,
    name,
    source: "layout",
    sourceRef: `canvas:${canvasId}:${cardId}`,
    userId,
    bytes,
    mime,
  });
  return { assetId };
}

export interface TextDraft {
  text: string;
  agentId: string | null;
  at: string;
}

const draftKey = (companyId: string, canvasId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "studio", stateKey: `canvas-text:${canvasId}` });

export async function textDrafts(ctx: PluginContext, companyId: string, canvasId: string): Promise<Record<string, TextDraft>> {
  const value = await ctx.state.get(draftKey(companyId, canvasId));
  return value && typeof value === "object" ? (value as Record<string, TextDraft>) : {};
}

export async function takeTextDraft(ctx: PluginContext, companyId: string, canvasId: string, cardId: string): Promise<void> {
  const current = await textDrafts(ctx, companyId, canvasId);
  if (!(cardId in current)) return;
  const { [cardId]: _taken, ...rest } = current;
  await ctx.state.set(draftKey(companyId, canvasId), rest);
}

/** An agent delivers words for a Text card. Reachable only through the board's own client, like its files. */
export async function writeCardText(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: { agentId: string | null; projectId: string | null }) {
  const canvasId = String(params.canvasId ?? "").trim();
  const cardId = String(params.cardId ?? "").trim();
  const text = typeof params.text === "string" ? params.text.trim() : "";
  if (!text) throw new StudioError("text is required: the words for the card.", "bad_text");
  if (text.length > MAX_TEXT) throw new StudioError(`That is ${text.length} characters, and a card holds ${MAX_TEXT}. Shorten it.`, "bad_text");
  const board = await getCanvas(ctx, companyId, canvasId);
  await assertReachable(ctx, companyId, scopeOf(board.client), actor.projectId);
  const card = board.doc.nodes.find((n) => n.id === cardId);
  if (!card) throw new StudioError(`No card ${cardId} on this board. Use the cardId from the task.`, "unknown_card");
  if (card.type !== "text") throw new StudioError(`Card ${cardId} is a ${card.type} card, not a Text card.`, "unknown_card");
  const current = await textDrafts(ctx, companyId, canvasId);
  await ctx.state.set(draftKey(companyId, canvasId), { ...current, [cardId]: { text, agentId: actor.agentId, at: new Date().toISOString() } });
  return { delivered: true, card: card.data.label ?? cardId, next: "The words are on their way to the card. A person checks them there. Nothing was published." };
}
