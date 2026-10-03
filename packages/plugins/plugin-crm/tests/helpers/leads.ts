/**
 * Helpers for the public lead form specs: a webhook delivery the way the host
 * hands it to the worker, and a lead source made through the real tool.
 */
import type { PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { resetLeadCaches } from "../../src/lead-capture.js";
import { signLeadRequest } from "../../src/lead-form.js";
import { BOARD, boot, CO, tool } from "./crm.js";

export type Booted = Awaited<ReturnType<typeof boot>>;

/** A distinct visitor address per number, so one test's requests never count against another's rate limit. */
export const ip = (n: number) => `203.0.113.${n}`;

export function delivery(body: unknown, headers: Record<string, string> = {}, raw?: string): PluginWebhookInput {
  const rawBody = raw ?? JSON.stringify(body);
  return { endpointKey: "lead", headers: { "x-real-ip": ip(9), "content-type": "application/json", ...headers }, rawBody, parsedBody: body, requestId: "req-1" };
}

/** A signed delivery: the server-to-server path. */
export function signedDelivery(secret: string, body: Record<string, unknown>, options: { at?: number; headers?: Record<string, string> } = {}): PluginWebhookInput {
  const rawBody = JSON.stringify(body);
  const timestamp = String(options.at ?? Date.now());
  return delivery(body, { "x-pib-timestamp": timestamp, "x-pib-signature": signLeadRequest(secret, timestamp, rawBody), ...(options.headers ?? {}) }, rawBody);
}

/** A boot with a clean per-test salt cache. */
export async function bootLeads(options: Parameters<typeof boot>[0] = {}): Promise<Booted> {
  resetLeadCaches();
  return boot(options);
}

type SourceResult = { created: boolean; source: Record<string, any>; serverSecret?: string; serverSecretNote?: string; note?: string; next?: string };

/** A lead source through `create-lead-endpoint`, as an agent would make it. */
export async function makeSource(booted: Booted, params: Record<string, unknown> = {}): Promise<SourceResult> {
  return tool<SourceResult>(booted.harness, "create-lead-endpoint", params);
}

/** A lead source made the way a PERSON makes it on the client's Lead forms card: the only path that may be handed a signing secret. */
export async function makeSourceAsPerson(booted: Booted, params: Record<string, unknown> = {}): Promise<SourceResult> {
  return booted.harness.performAction<SourceResult>("crm.create-lead-endpoint", params, { companyId: CO, actor: BOARD });
}

/** A well-formed submission, with anything overridden. */
export function lead(key: string, extra: Record<string, unknown> = {}) {
  return { key, name: "Jane Smith", email: "jane@smith-plumbing.test", message: "I need a quote for SEO", t: 9000, ...extra };
}
