/**
 * A company's saved canvas templates, kept in plugin state like the prompt templates: a short list that needs no table
 * and no restart to ship. A template keeps the wiring and the words; files and results are taken out, so one client's
 * work never travels to another's board.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import { normalizeDoc } from "./canvas.js";
import { boardToTemplateDoc, type CanvasTemplate } from "./canvas-templates.js";
import { StudioError } from "./errors.js";

const MAX_SAVED = 50;
const MAX_CARDS = 60;
const MAX_TITLE = 80;

const keyFor = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "studio", stateKey: "canvas-templates" });

export async function listCanvasTemplates(ctx: PluginContext, companyId: string): Promise<CanvasTemplate[]> {
  const value = await ctx.state.get(keyFor(companyId));
  return Array.isArray(value) ? (value as CanvasTemplate[]) : [];
}

export async function saveCanvasTemplate(ctx: PluginContext, companyId: string, input: Record<string, unknown>): Promise<CanvasTemplate> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw new StudioError("Give the template a name.", "invalid");
  if (title.length > MAX_TITLE) throw new StudioError(`Keep the name under ${MAX_TITLE} characters.`, "invalid");
  const doc = boardToTemplateDoc(normalizeDoc(input.doc));
  if (doc.nodes.length === 0) throw new StudioError("This board has no cards to save yet.", "invalid");
  if (doc.nodes.length > MAX_CARDS) throw new StudioError(`A template holds at most ${MAX_CARDS} cards. This board has ${doc.nodes.length}.`, "invalid");
  const current = await listCanvasTemplates(ctx, companyId);
  if (current.length >= MAX_SAVED) throw new StudioError(`This company has ${MAX_SAVED} saved canvas templates, the most it can keep. Delete one first.`, "invalid");
  const saved: CanvasTemplate = { id: `saved-${randomUUID()}`, title, tagline: "Saved from a board", category: "saved", doc, examples: {}, createdAt: new Date().toISOString() };
  await ctx.state.set(keyFor(companyId), [saved, ...current]);
  return saved;
}

export async function deleteCanvasTemplate(ctx: PluginContext, companyId: string, id: string): Promise<{ removed: boolean }> {
  const current = await listCanvasTemplates(ctx, companyId);
  const next = current.filter((t) => t.id !== id);
  if (next.length === current.length) return { removed: false };
  await ctx.state.set(keyFor(companyId), next);
  return { removed: true };
}
