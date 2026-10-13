import { NAMESPACE, PLUGIN_ID } from "../../src/namespace.js";
import type { PluginDatabaseClient, PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import type { PgDb } from "./pg.js";
import { computeTwilioSignature, buildPublicWebhookUrl, parseFormParams } from "../../src/twilio-signature.js";
import { vi } from "vitest";

export function createMockDbClient(pgDb: PgDb): PluginDatabaseClient {
  return {
    namespace: NAMESPACE,
    query: async (sql: string, params?: unknown[]) => {
      const result = await pgDb.client.query(sql, params);
      return (result.rows || []) as any[];
    },
    execute: async (sql: string, params?: unknown[]) => {
      const result = await pgDb.client.query(sql, params);
      return { rowCount: result.rowCount || 0 };
    },
  };
}

export async function seedContact(
  pgDb: PgDb,
  id: string,
  companyId: string,
  name: string,
  phones: string[],
  deleted = false,
): Promise<void> {
  await pgDb.client.query(
    `INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, phones, deleted, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, companyId, name, phones, deleted, new Date()],
  );
}

export function createMockContext(companyIds: string[], authTokens: Record<string, string>): Partial<PluginContext> {
  return {
    logger: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    companies: {
      list: vi.fn(async () => companyIds.map((id) => ({ id, name: `Company ${id}` } as any))),
      get: vi.fn(),
    },
    secrets: {
      resolve: vi.fn(async (secretName: string, opts: any) => {
        const token = authTokens[opts.companyId];
        if (!token) throw new Error("Company not found");
        return token;
      }),
    },
  } as any;
}

export function buildSignedWebhookInput(
  messageBody: string,
  authToken: string,
  endpointKey: "wa-inbound" | "wa-status",
  proto = "https",
  host = "example.com",
  requestId = "test-request",
): { input: PluginWebhookInput; webhookUrl: string } {
  const baseUrl = `${proto}://${host}`;
  const webhookUrl = buildPublicWebhookUrl({
    baseUrl,
    pluginId: PLUGIN_ID,
    endpointKey,
  });

  const params = parseFormParams(messageBody);
  const signature = computeTwilioSignature(authToken, webhookUrl, params);

  return {
    input: {
      requestId,
      endpointKey,
      headers: {
        "x-forwarded-proto": proto,
        "x-forwarded-host": host,
        "x-twilio-signature": signature,
      },
      rawBody: messageBody,
      parsedBody: params,
    },
    webhookUrl,
  };
}

export async function readAuditRows(
  pgDb: PgDb,
  companyId: string,
  action?: string,
): Promise<Array<{ action: string; detail: any; contact_id: string | null }>> {
  const query = action
    ? `SELECT action, detail, contact_id FROM ${NAMESPACE}.tel_audit
       WHERE company_id = $1 AND action = $2
       ORDER BY at DESC`
    : `SELECT action, detail, contact_id FROM ${NAMESPACE}.tel_audit
       WHERE company_id = $1
       ORDER BY at DESC`;
  const params = action ? [companyId, action] : [companyId];
  const result = await pgDb.client.query(query, params);
  return (result.rows || []) as any[];
}

export async function readOptOutRows(
  pgDb: PgDb,
  companyId: string,
  e164?: string,
): Promise<Array<{ company_id: string; channel: string; e164: string; opt_out_at: Date }>> {
  const query = e164
    ? `SELECT company_id, channel, e164, opt_out_at FROM ${NAMESPACE}.tel_number_optouts
       WHERE company_id = $1 AND e164 = $2`
    : `SELECT company_id, channel, e164, opt_out_at FROM ${NAMESPACE}.tel_number_optouts
       WHERE company_id = $1`;
  const params = e164 ? [companyId, e164] : [companyId];
  const result = await pgDb.client.query(query, params);
  return (result.rows || []) as any[];
}

export async function readPrefRows(
  pgDb: PgDb,
  companyId: string,
  contactId?: string,
): Promise<Array<{ company_id: string; contact_id: string; wa_opt_out_at: Date | null; erased_at: Date | null }>> {
  const query = contactId
    ? `SELECT company_id, contact_id, wa_opt_out_at, erased_at FROM ${NAMESPACE}.tel_contact_prefs
       WHERE company_id = $1 AND contact_id = $2`
    : `SELECT company_id, contact_id, wa_opt_out_at, erased_at FROM ${NAMESPACE}.tel_contact_prefs
       WHERE company_id = $1
       ORDER BY contact_id`;
  const params = contactId ? [companyId, contactId] : [companyId];
  const result = await pgDb.client.query(query, params);
  return (result.rows || []) as any[];
}

export async function readMessageRows(
  pgDb: PgDb,
  companyId: string,
  providerId?: string,
): Promise<Array<{ company_id: string; provider_msg_id: string; contact_id: string | null; ambiguous: boolean; status: string }>> {
  const query = providerId
    ? `SELECT company_id, provider_msg_id, contact_id, ambiguous, status FROM ${NAMESPACE}.tel_messages
       WHERE company_id = $1 AND provider_msg_id = $2`
    : `SELECT company_id, provider_msg_id, contact_id, ambiguous, status FROM ${NAMESPACE}.tel_messages
       WHERE company_id = $1`;
  const params = providerId ? [companyId, providerId] : [companyId];
  const result = await pgDb.client.query(query, params);
  return (result.rows || []) as any[];
}
