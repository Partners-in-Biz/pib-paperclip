/**
 * A client's brand kit from the CRM, for producer plugins (Studio first, PAR-8134).
 * The producer asks with `requestBrandKit`; the CRM answers once on its own reply events, from the client profile of
 * that client in the event's company (the host sets it; never one from the payload). The reply names the client it is
 * for, and a reply for another client or company is never taken. Nothing here adds the kit to a prompt: a person or
 * agent does that with `brandKitPrompt`, so what was sent is the text they saw.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { CRM_PLUGIN_ID } from "./crm-projection.js";

export const BRAND_KIT_EVENTS = {
  requested: "brand-kit.requested",
  read: "brand-kit.read",
  failed: "brand-kit.failed",
} as const;

/** The plugins that may read a client's brand kit from the CRM. Add a producer here before it calls `requestBrandKit`. */
export const BRAND_KIT_PRODUCER_PLUGINS = ["partnersinbiz.studio"] as const;

export interface BrandKit {
  brandVoice: string | null;
  audience: string | null;
  toneNotes: string | null;
  bannedWords: string[];
  primaryColor: string | null;
  secondaryColor: string | null;
  accentColor: string | null;
  fonts: string[];
  toneExamples: string[];
  /** True when the CRM has a logo key for this client. The logo itself is not sent yet. */
  hasLogo: boolean;
}

export type BrandKitResult =
  | { status: "read"; requestId: string; client: { kind: string; ref: string }; kit: BrandKit; empty: boolean }
  | { status: "failed"; requestId: string; reason: string; hint?: string }
  | { status: "no_ack"; requestId: string };

export interface BrandKitTarget {
  companyId: string;
  client: { kind: string; ref: string };
  requestId?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const REF = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TEXT = 2000;
const MAX_LIST = 40;
const COLOR = /^#[0-9a-fA-F]{3,8}$/;

type Pending = Map<string, { companyId: string; client: { kind: string; ref: string }; resolve: (ok: boolean, payload: Record<string, unknown>) => void }>;
const pendingByCtx = new WeakMap<Pick<PluginContext, "events">, Pending>();

function pendingFor(ctx: Pick<PluginContext, "events">): Pending {
  const known = pendingByCtx.get(ctx);
  if (known) return known;
  const pending: Pending = new Map();
  pendingByCtx.set(ctx, pending);
  const on = (event: string, ok: boolean) =>
    ctx.events.on(`plugin.${CRM_PLUGIN_ID}.${event}` as never, async (e: PluginEvent) => {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      if (typeof payload.requestId !== "string") return;
      const entry = pending.get(payload.requestId);
      // A reply for another company is never taken for this one.
      if (!entry || entry.companyId !== e.companyId) return;
      pending.delete(payload.requestId);
      entry.resolve(ok, payload);
    });
  on(BRAND_KIT_EVENTS.read, true);
  on(BRAND_KIT_EVENTS.failed, false);
  return pending;
}

/** Subscribe to the CRM's brand kit replies at setup, so the first request doesn't subscribe mid-action. Idempotent. */
export function registerBrandKitReplies(ctx: Pick<PluginContext, "events">): void {
  pendingFor(ctx);
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_TEXT) : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 200)).slice(0, MAX_LIST) : []);
const color = (v: unknown): string | null => (typeof v === "string" && COLOR.test(v.trim()) ? v.trim() : null);

/** The kit from a reply or a profile record, with only known fields, trimmed and capped. */
export function brandKitOf(value: unknown): BrandKit {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    brandVoice: text(v.brandVoice),
    audience: text(v.audience),
    toneNotes: text(v.toneNotes),
    bannedWords: list(v.bannedWords),
    primaryColor: color(v.primaryColor),
    secondaryColor: color(v.secondaryColor),
    accentColor: color(v.accentColor),
    fonts: list(v.fonts),
    toneExamples: list(v.toneExamples),
    hasLogo: v.hasLogo === true || (typeof v.logoKey === "string" && v.logoKey.trim() !== ""),
  };
}

export function brandKitIsEmpty(kit: BrandKit): boolean {
  return !brandKitPrompt(kit);
}

/**
 * The prompt text for a kit: the exact words a card or agent adds to its prompt. Empty when the kit has nothing
 * a model can use. Colours and fonts are named; banned words are listed as words to keep out of any text in the image.
 */
export function brandKitPrompt(kit: BrandKit): string {
  const lines: string[] = [];
  const colors = [
    kit.primaryColor && `primary ${kit.primaryColor}`,
    kit.secondaryColor && `secondary ${kit.secondaryColor}`,
    kit.accentColor && `accent ${kit.accentColor}`,
  ].filter(Boolean);
  if (colors.length) lines.push(`Brand colours: ${colors.join(", ")}.`);
  if (kit.fonts.length) lines.push(`Brand fonts: ${kit.fonts.join(", ")}.`);
  if (kit.brandVoice) lines.push(`Brand voice: ${kit.brandVoice}`);
  if (kit.audience) lines.push(`Audience: ${kit.audience}`);
  if (kit.toneNotes) lines.push(`Tone: ${kit.toneNotes}`);
  if (kit.bannedWords.length) lines.push(`Never use these words in any text: ${kit.bannedWords.join(", ")}.`);
  return lines.length ? `Brand kit:\n${lines.join("\n")}` : "";
}

/** One client's brand kit from the CRM. Only `company:` and `contact:` clients have one; own work has none. */
export async function requestBrandKit(ctx: Pick<PluginContext, "events">, t: BrandKitTarget): Promise<BrandKitResult> {
  const requestId = t.requestId ?? randomUUID().replace(/-/g, "");
  if (!t.companyId || !t.client || (t.client.kind !== "company" && t.client.kind !== "contact") || typeof t.client.ref !== "string" || !REF.test(t.client.ref)) {
    return { status: "failed", requestId, reason: "invalid_input" };
  }
  if (!/^[a-z0-9]+$/i.test(requestId)) return { status: "failed", requestId, reason: "invalid_request_id" };
  const pending = pendingFor(ctx);
  if (pending.has(requestId)) return { status: "failed", requestId, reason: "duplicate_request_id" };
  const client = { kind: t.client.kind, ref: t.client.ref };
  return await new Promise<BrandKitResult>((resolve) => {
    let settled = false;
    const settle = (result: BrandKitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(requestId);
      resolve(result);
    };
    const timer = setTimeout(() => settle({ status: "no_ack", requestId }), t.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    pending.set(requestId, {
      companyId: t.companyId,
      client,
      resolve: (ok, p) => {
        if (!ok) return settle({ status: "failed", requestId, reason: typeof p.reason === "string" ? p.reason : "failed", hint: typeof p.hint === "string" ? p.hint : undefined });
        // The CRM names the client it read; anything else is never shown as this client's kit.
        if (p.clientKind !== client.kind || p.clientRef !== client.ref) return settle({ status: "failed", requestId, reason: "wrong_client" });
        const kit = brandKitOf(p.kit);
        settle({ status: "read", requestId, client, kit, empty: brandKitIsEmpty(kit) });
      },
    });
    Promise.resolve()
      .then(() => ctx.events.emit(BRAND_KIT_EVENTS.requested as never, t.companyId, { requestId, clientKind: client.kind, clientRef: client.ref }))
      .catch((error) => settle({ status: "failed", requestId, reason: "emit_failed", hint: error instanceof Error ? error.message : String(error) }));
  });
}
