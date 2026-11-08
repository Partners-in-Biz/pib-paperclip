/**
 * A company's saved prompt templates, kept in plugin state: a short list that needs no table and no restart to ship.
 * Every signed-in member of the company sees them; only someone who may generate can add or remove one.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import { StudioError } from "./errors.js";
import type { PromptTemplate } from "./prompt-templates.js";

const MAX_SAVED = 200;
const MAX_TITLE = 80;
const MAX_PROMPT = 4000;

const keyFor = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "studio", stateKey: "prompt-templates" });

export async function listSavedTemplates(ctx: PluginContext, companyId: string): Promise<PromptTemplate[]> {
  const value = await ctx.state.get(keyFor(companyId));
  return Array.isArray(value) ? (value as PromptTemplate[]) : [];
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Newest first. Refuses an empty title or prompt, and a list that is already full. */
export async function saveTemplate(ctx: PluginContext, companyId: string, input: Record<string, unknown>): Promise<PromptTemplate> {
  const title = text(input.title);
  const prompt = text(input.prompt);
  if (!title) throw new StudioError("Give the template a name.", "invalid");
  if (!prompt) throw new StudioError("A template needs a prompt.", "invalid");
  if (title.length > MAX_TITLE) throw new StudioError(`Keep the name under ${MAX_TITLE} characters.`, "invalid");
  if (prompt.length > MAX_PROMPT) throw new StudioError(`Keep the prompt under ${MAX_PROMPT} characters.`, "invalid");
  const current = await listSavedTemplates(ctx, companyId);
  if (current.length >= MAX_SAVED) throw new StudioError(`This company has ${MAX_SAVED} saved templates, the most it can keep. Delete one first.`, "invalid");
  const saved: PromptTemplate = {
    id: `saved-${randomUUID()}`,
    title,
    tagline: text(input.tagline).slice(0, 120),
    category: "saved",
    kind: input.kind === "video" ? "video" : "image",
    ratio: text(input.ratio),
    prompt,
    model: text(input.model) || null,
    resolution: text(input.resolution) || null,
    assetId: text(input.assetId) || null,
    createdAt: new Date().toISOString(),
  };
  await ctx.state.set(keyFor(companyId), [saved, ...current]);
  return saved;
}

export async function deleteTemplate(ctx: PluginContext, companyId: string, id: string): Promise<{ removed: boolean }> {
  const current = await listSavedTemplates(ctx, companyId);
  const next = current.filter((t) => t.id !== id);
  if (next.length === current.length) return { removed: false };
  await ctx.state.set(keyFor(companyId), next);
  return { removed: true };
}
