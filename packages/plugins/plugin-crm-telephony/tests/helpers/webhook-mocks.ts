import { vi } from "vitest";
import { computeTwilioSignature, buildPublicWebhookUrl, parseFormParams } from "../../src/twilio-signature.js";
import { NAMESPACE, PLUGIN_ID } from "../../src/namespace.js";
import type { PluginContext, PluginDatabaseClient, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import type { PgDb } from "./pg.js";

export function createMockDbClient(pgDb: PgDb): PluginDatabaseClient {
  return {
    namespace: NAMESPACE,
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const result = await pgDb.client.query(sql, params);
      return (result.rows || []) as T[];
    },
    execute: async (sql: string, params?: unknown[]) => {
      const result = await pgDb.client.query(sql, params);
      return { rowCount: result.rowCount || 0 };
    },
  };
}

export interface CompanyAuthMap {
  [companyId: string]: string;
}

export function createMockCtx(companyAuthMap: CompanyAuthMap): Partial<PluginContext> {
  return {
    logger: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    companies: {
      list: vi.fn(async () =>
        Object.keys(companyAuthMap).map((id) => ({ id, name: `Company ${id}` } as any)),
      ),
      get: vi.fn(),
    },
    secrets: {
      resolve: vi.fn(async (secretName: string, opts: any) => {
        if (opts?.companyId && companyAuthMap[opts.companyId]) {
          return companyAuthMap[opts.companyId];
        }
        throw new Error(`Company not found: ${opts?.companyId}`);
      }),
    },
    config: {
      get: vi.fn(async () => ({ recordingRetentionDays: 30 })),
    },
  } as any;
}

export interface SignedInputParams {
  recordingSid: string;
  callSid: string;
  recordingStatus: string;
  recordingUrl?: string;
  recordingDuration?: number;
}

export interface SignedWebhookInput {
  formBody: string;
  params: Record<string, unknown>;
  signature: string;
  input: PluginWebhookInput;
}

export function buildSignedRecordingStatusInput(
  authToken: string,
  params: SignedInputParams,
  baseUrl: string = "https://example.com",
): SignedWebhookInput {
  const proto = new URL(baseUrl).protocol.slice(0, -1);
  const host = new URL(baseUrl).host;

  const webhookUrl = buildPublicWebhookUrl({
    baseUrl,
    pluginId: PLUGIN_ID,
    endpointKey: "recording-status",
  });

  // Build form body
  const formParts = [
    `RecordingSid=${params.recordingSid}`,
    `CallSid=${params.callSid}`,
    `RecordingStatus=${params.recordingStatus}`,
  ];

  if (params.recordingUrl) {
    formParts.push(`RecordingUrl=${params.recordingUrl}`);
  }

  if (params.recordingDuration !== undefined) {
    formParts.push(`RecordingDuration=${params.recordingDuration}`);
  }

  const formBody = formParts.join("&");
  const parsedParams = parseFormParams(formBody);
  const signature = computeTwilioSignature(authToken, webhookUrl, parsedParams);

  const input: PluginWebhookInput = {
    requestId: `test-req-${params.recordingSid}`,
    endpointKey: "recording-status",
    headers: {
      "x-forwarded-proto": proto,
      "x-forwarded-host": host,
      "x-twilio-signature": signature,
    },
    rawBody: formBody,
    parsedBody: parsedParams,
  };

  return { formBody, params: parsedParams, signature, input };
}

export interface CallStatusParams {
  callSid: string;
  callStatus: string;
  parentCallSid?: string;
  callDuration?: number;
  from?: string;
  to?: string;
  direction?: string;
}

/** A Twilio call status callback signed for the `call-status` endpoint. */
export function buildSignedCallStatusInput(
  authToken: string,
  params: CallStatusParams,
  baseUrl: string = "https://example.com",
): SignedWebhookInput {
  const proto = new URL(baseUrl).protocol.slice(0, -1);
  const host = new URL(baseUrl).host;
  const webhookUrl = buildPublicWebhookUrl({ baseUrl, pluginId: PLUGIN_ID, endpointKey: "call-status" });

  const search = new URLSearchParams();
  search.set("CallSid", params.callSid);
  search.set("CallStatus", params.callStatus);
  if (params.parentCallSid) search.set("ParentCallSid", params.parentCallSid);
  if (params.callDuration !== undefined) search.set("CallDuration", String(params.callDuration));
  if (params.from) search.set("From", params.from);
  if (params.to) search.set("To", params.to);
  if (params.direction) search.set("Direction", params.direction);
  const formBody = search.toString();
  const parsedParams = parseFormParams(formBody);
  const signature = computeTwilioSignature(authToken, webhookUrl, parsedParams);

  const input: PluginWebhookInput = {
    requestId: `test-req-${params.callSid}-${params.callStatus}`,
    endpointKey: "call-status",
    headers: {
      "x-forwarded-proto": proto,
      "x-forwarded-host": host,
      "x-twilio-signature": signature,
    },
    rawBody: formBody,
    parsedBody: parsedParams,
  };
  return { formBody, params: parsedParams, signature, input };
}
