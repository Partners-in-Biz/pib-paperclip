import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildKeyring, sealJson } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "../src/namespace.js";
import { completeOAuth, confirmPicker, pendingOptions } from "../src/oauth/flow.js";
import { publishDueJob } from "../src/publish.js";
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
  const issuesCreate = vi.fn(async () => ({ id: "issue-1" }));
  return {
    issuesCreate,
    services: {
      config: { get: vi.fn(async (companyId: string) => (companyId === "co" ? CONFIG : {})) },
      secrets: { resolve: vi.fn(async (ref: { secretId: string }) => SECRETS[ref.secretId] ?? "") },
      issues: { create: issuesCreate, requestWakeup: vi.fn(async () => ({})), createComment: vi.fn(async () => ({})) },
      agents: { managed: { get: vi.fn(async () => { throw new Error("no agent"); }) } },
      projects: { managed: { get: vi.fn(async () => ({ projectId: "proj-social" })) } },
      companies: { get: vi.fn(async () => ({ id: "co", issuePrefix: "PIB" })) },
      ...extra,
    },
  };
}

beforeEach(() => fastNetwork());
afterEach(() => vi.unstubAllGlobals());

describe("publish-due engine", () => {
  function world(fbStatus: number, fbBody: unknown) {
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
      token_expires_at: null, scopes: [], client_ref: null, client_name: null, last_error: null, meta: { pageId: "page-1" }, key_version: 1,
      created_by_user_id: "user-1", reconnect_issue_id: null, last_refreshed_at: null, created_at: new Date(), updated_at: new Date(),
    };
    let dueServed = false;
    const ctx = fakeCtx(hostServices().services, {
      queryResult: (sql) => {
        if (sql.includes("p.status IN ('scheduled', 'publishing')") && sql.includes("EXISTS (")) {
          if (sql.includes("NOT EXISTS")) return [];
          if (dueServed) return [];
          dueServed = true;
          return [{ id: "p1", company_id: "co" }];
        }
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
        if (sql.includes("SET status = $2, error = $3")) {
          post.status = String(params[1]);
          return 1;
        }
        if (sql.includes("SET failure_issue_id")) {
          post.failure_issue_id = String(params[1]);
          return 1;
        }
        if (sql.includes("SET issue_id")) {
          dest.issue_id = String(params[1]);
          return 1;
        }
        return 0;
      },
    });
    mockFetch([["POST https://graph.facebook.com/v21.0/page-1/feed", () => json(fbBody, fbStatus)]]);
    return { ctx, post, dest };
  }

  it("publishes a due destination and records the external id", async () => {
    const { ctx, post, dest } = world(200, { id: "page-1_55" });
    const summary = await publishDueJob(ctx, async () => undefined);
    expect(summary).toMatchObject({ companies: 1, posts: 1, attempted: 1, published: 1 });
    expect(dest).toMatchObject({ status: "published", external_id: "page-1_55", external_url: "https://www.facebook.com/page-1_55", attempts: 1 });
    expect(post.status).toBe("published");
  });

  it("schedules a retry after a transient error and opens no issue", async () => {
    const { ctx, post, dest } = world(503, { error: { message: "Service unavailable", code: 2 } });
    await publishDueJob(ctx, async () => undefined);
    expect(dest.status).toBe("retrying");
    const wait = new Date(dest.next_attempt_at!).getTime() - Date.now();
    expect(wait).toBeGreaterThan(50_000);
    expect(wait).toBeLessThan(70_000);
    expect(post.status).toBe("publishing");
    expect(post.failure_issue_id).toBeNull();
  });

  it("fails a permanent error at once and opens one issue for the post owner", async () => {
    const { ctx, post, dest } = world(400, { error: { message: "(#100) Invalid parameter", code: 100 } });
    const { issuesCreate } = { issuesCreate: (ctx as unknown as { issues: { create: ReturnType<typeof vi.fn> } }).issues.create };
    await publishDueJob(ctx, async () => undefined);
    expect(dest.status).toBe("failed");
    expect(post.status).toBe("failed");
    expect(issuesCreate).toHaveBeenCalledTimes(1);
    expect(issuesCreate.mock.calls[0]![0]).toMatchObject({
      companyId: "co",
      status: "todo",
      originKind: "plugin:partnersinbiz.social",
      originId: "p1",
      assigneeUserId: "user-1",
      projectId: "proj-social",
    });
    expect(post.failure_issue_id).toBe("issue-1");
    expect(dest.issue_id).toBe("issue-1");
  });

  it("skips companies whose settings are not saved", async () => {
    const { ctx } = world(200, { id: "x" });
    (ctx as unknown as { config: { get: () => Promise<unknown> } }).config.get = async () => ({});
    const summary = await publishDueJob(ctx, async () => undefined);
    expect(summary.skipped[0]).toMatch(/not saved/);
    expect(summary.attempted).toBe(0);
  });
});

describe("OAuth completion through the bridge", () => {
  function sessionWorld() {
    const session = {
      state: "st-1", company_id: "co", platform: "facebook", account_label: "Facebook", extra: { clientRef: null }, pending_options: null as string | null,
      created_by_user_id: "user-1", picker_id: null as string | null, status: "started", expires_at: new Date(Date.now() + 600_000),
    };
    const inserted: unknown[][] = [];
    const ctx = fakeCtx(hostServices().services, {
      queryResult: (sql, params) => {
        if (sql.includes(`FROM ${NAMESPACE}.oauth_sessions`) && sql.includes("WHERE state = $1")) return params[0] === session.state ? [session] : [];
        if (sql.includes("WHERE picker_id = $1")) return params[0] === session.picker_id && session.status === "pending_selection" ? [session] : [];
        return [];
      },
      executeResult: (sql, params) => {
        if (sql.includes("SET status = 'exchanging'")) {
          if (session.status !== "started") return 0;
          session.status = "exchanging";
          return 1;
        }
        if (sql.includes("SET status = 'pending_selection'")) {
          session.status = "pending_selection";
          session.picker_id = String(params[1]);
          session.pending_options = String(params[2]);
          return 1;
        }
        if (sql.startsWith(`INSERT INTO ${NAMESPACE}.accounts`)) inserted.push(params);
        return 1;
      },
    });
    mockFetch([
      ["GET https://graph.facebook.com/v21.0/oauth/access_token", (url) =>
        json(url.searchParams.get("grant_type") ? { access_token: "long", expires_in: 5_184_000 } : { access_token: "short" })],
      ["GET https://graph.facebook.com/v21.0/me/accounts", () => json({ data: [
        { id: "p1", name: "PiB", access_token: "pt1", instagram_business_account: { id: "ig1", username: "pib" } },
        { id: "p2", name: "Client", access_token: "pt2" },
      ] })],
    ]);
    return { ctx, session, inserted };
  }

  it("rejects a completion for another company or user", async () => {
    const { ctx } = sessionWorld();
    await expect(completeOAuth(ctx, { companyId: "other", userId: "user-1", state: "st-1", params: { code: "c" } })).rejects.toThrow(/another company/);
    await expect(completeOAuth(ctx, { companyId: "co", userId: "user-2", state: "st-1", params: { code: "c" } })).rejects.toThrow(/another user/);
    await expect(completeOAuth(ctx, { companyId: "co", userId: "user-1", state: "nope", params: { code: "c" } })).rejects.toThrow(/expired/);
  });

  it("sends the person to a picker, then creates one account per choice", async () => {
    const { ctx, session, inserted } = sessionWorld();
    const result = await completeOAuth(ctx, { companyId: "co", userId: "user-1", state: "st-1", params: { code: "c", state: "st-1" } });
    expect(result.pickerId).toBeTruthy();
    expect(result.redirectTo).toBe(`/PIB/social?tab=accounts&picker=${result.pickerId}`);
    expect(session.pending_options).toMatch(/^v1\./);
    expect(session.pending_options).not.toContain("pt1");

    const options = await pendingOptions(ctx, "co", "user-1", result.pickerId!);
    expect(options.options.map((o) => o.key)).toEqual(["page:p1", "ig:ig1", "page:p2"]);
    expect(JSON.stringify(options)).not.toContain("pt1");

    const confirmed = await confirmPicker(ctx, "co", "user-1", { pickerId: result.pickerId!, selections: ["page:p1", "ig:ig1"] });
    expect(confirmed.connected).toBe(2);
    expect(inserted).toHaveLength(2);
    expect(inserted.map((p) => p[2])).toEqual(["facebook", "instagram"]);
    expect(String(inserted[0]![7])).toMatch(/^v1\./);
  });

  it("returns the provider's error when access was denied", async () => {
    const { ctx } = sessionWorld();
    await expect(completeOAuth(ctx, { companyId: "co", userId: "user-1", state: "st-1", params: { error: "access_denied", error_description: "User cancelled" } }))
      .rejects.toThrow("User cancelled");
  });
});
