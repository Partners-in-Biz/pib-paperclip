import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildKeyring, sealJson } from "@partnersinbiz/pib-plugin-kit";
import { publishPost } from "../src/publish.js";
import { NAMESPACE } from "../src/namespace.js";
import { fakeCtx, fastNetwork, json, mockFetch } from "./helpers.js";

const REF = (id: string) => ({ type: "secret_ref", secretId: id });
const CONFIG = {
  publicBaseUrl: "https://paperclip.example.com",
  encryptionKey: REF("enc"),
  platforms: { facebook: { clientId: "fb-id", clientSecret: REF("fb") } },
};
const SECRETS: Record<string, string> = { enc: "a-very-long-encryption-key-123", fb: "fb-secret" };
const keyring = buildKeyring({ purpose: "social", companyId: "co", secret: SECRETS.enc! });

function hostServices(extra: Record<string, unknown> = {}) {
  return {
    services: {
      config: { get: vi.fn(async (companyId: string) => (companyId === "co" ? CONFIG : {})) },
      secrets: { resolve: vi.fn(async (ref: { secretId: string }) => SECRETS[ref.secretId] ?? "") },
      issues: { create: vi.fn(async () => ({ id: "issue-1" })), requestWakeup: vi.fn(async () => ({})), createComment: vi.fn(async () => ({})) },
      agents: { managed: { get: vi.fn(async () => { throw new Error("no agent"); }) } },
      projects: { managed: { get: vi.fn(async () => ({ projectId: "proj-social" })) } },
      companies: { get: vi.fn(async () => ({ id: "co", issuePrefix: "PIB" })) },
      ...extra,
    },
  };
}

// Mock saveToDrive to never resolve
let saveToDriveCalls: any[] = [];
vi.mock("../src/drive.js", () => ({
  saveToDrive: vi.fn(async () => {
    saveToDriveCalls.push(1);
    return new Promise(() => {});
  }),
}));

beforeEach(() => {
  fastNetwork();
  saveToDriveCalls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  saveToDriveCalls = [];
});

describe("publishPost fire-and-forget behavior", () => {
  it("returns immediately even when saveToDrive never resolves", { timeout: 2000 }, async () => {
    const post = {
      id: "p1", company_id: "co", body: "Hello", overrides: {}, media: [], status: "scheduled", scheduled_at: new Date(Date.now() - 60_000),
      scope: "org", owner_user_id: "user-1", client_ref: null, client_name: "Acme", first_comment: null, source: "manual", source_ref: null,
      failure_issue_id: null as string | null, published_at: null, error: null, created_by_agent_id: null, created_at: new Date(), updated_at: new Date(),
    };

    const dest = {
      id: "d1", company_id: "co", post_id: "p1", account_id: "a1", status: "pending", result: {}, attempts: 0, next_attempt_at: null as string | null,
      external_id: null as string | null, external_url: null as string | null, last_error: null as string | null, published_at: null, issue_id: null as string | null,
      metric_windows: [], created_at: new Date(), updated_at: new Date(),
    };

    const account = {
      id: "a1", company_id: "co", platform: "facebook", scope: "org", owner_user_id: null, status: "connected", secret_ref: null, display_name: "Acme Page",
      external_id: "page-1", handle: null, avatar_url: null, token_enc: sealJson({ accessToken: "page-token" }, keyring), refresh_token_enc: null,
      token_expires_at: null, scopes: [], client_kind: null, client_ref: null, client_name: null, last_error: null, meta: { pageId: "page-1" }, key_version: 1,
      created_by_user_id: "user-1", reconnect_issue_id: null, last_refreshed_at: null, created_at: new Date(), updated_at: new Date(),
    };

    const ctx = fakeCtx(hostServices().services, {
      queryResult: (sql) => {
        if (sql.includes(`FROM ${NAMESPACE}.posts WHERE id = $1`)) return [post];
        if (sql.includes("WHERE claim_token = $1")) return dest.status === "publishing" ? [dest] : [];
        if (sql.includes(`FROM ${NAMESPACE}.accounts WHERE id = $1`)) return [account];
        if (sql.includes(`FROM ${NAMESPACE}.destinations WHERE post_id = $1`)) return [dest];
        return [];
      },
      executeResult: (sql, params) => {
        if (sql.includes("SET status = 'publishing', claim_token")) {
          dest.status = "publishing";
          dest.attempts += 1;
          return 1;
        }
        if (sql.includes(`UPDATE ${NAMESPACE}.posts`) && sql.includes("status = ANY(")) {
          post.status = String(params[2]);
          return 1;
        }
        if (sql.includes("SET status = $2, next_attempt_at")) {
          dest.status = String(params[1]);
          dest.next_attempt_at = params[2] as string | null;
          dest.external_id = (params[3] as string | null) ?? dest.external_id;
          dest.external_url = (params[4] as string | null) ?? dest.external_url;
          dest.last_error = params[5] as string | null;
          return 1;
        }
        return 0;
      },
    });

    mockFetch([["POST https://graph.facebook.com/v21.0/page-1/feed", () => json({ id: "page-1_55" })]]);

    const start = Date.now();
    const result = await publishPost(ctx, {
      companyId: "co",
      saved: true,
      raw: {},
      publicBaseUrl: "https://paperclip.example.com",
      publicBaseUrlError: null,
      timezone: "UTC",
      allowAgentReplies: false,
      approvalBaseUrl: "https://paperclip.example.com",
      approvalBaseUrlSet: false,
      blueskyDefaultPds: "",
      mastodonDefaultInstance: null,
      r2Configured: false,
      encryptionKeyConfigured: true,
      redirectUri: () => "https://paperclip.example.com/redirect",
      platform: () => ({ configured: true }),
      linkedinPages: async () => ({ clientId: "", clientSecret: "" }),
      app: async () => ({ clientId: "", clientSecret: "" }),
      keyring: async () => keyring,
      r2: async () => ({ bucket: "", region: "", accessKeyId: "", secretAccessKey: "" }),
    } as any, "p1");
    const elapsed = Date.now() - start;

    // The publish should return immediately, not wait for Drive save
    expect(elapsed).toBeLessThan(500);
    // Verify the publish succeeded
    expect(result).toMatchObject({ attempted: 1, published: 1 });
    expect(dest.status).toBe("published");
    expect(dest.external_id).toBe("page-1_55");
    // Verify saveToDrive was called (fire-and-forget in the background)
    expect(saveToDriveCalls.length).toBeGreaterThan(0);
  });
});
