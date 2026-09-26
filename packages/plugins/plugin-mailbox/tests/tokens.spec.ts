import { describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { buildKeyring, openJson } from "@partnersinbiz/pib-plugin-kit";
import { GmailUnavailable } from "../src/domain.js";
import { getProfile } from "../src/gmail/api.js";
import { connectStart, oauthComplete } from "../src/gmail/oauth.js";
import { runSyncJob } from "../src/gmail/sync.js";
import { accessToken, withGmail, type StoredTokens } from "../src/gmail/tokens.js";
import { CO, ENCRYPTION_KEY } from "./helpers/memory.js";
import { sealedTokens, setup } from "./helpers/setup.js";

const keyring = buildKeyring({ purpose: "mailbox-gmail", companyId: CO, secret: ENCRYPTION_KEY });
const invalidGrant = () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 });

describe("Gmail tokens", () => {
  it("refreshes an expiring token, persists it sealed and caches it", async () => {
    const { env, store, account, gmail, loaded } = setup();
    account.token_sealed = sealedTokens({ expiresAt: Date.now() + 30_000 });
    store.accounts.get("acc-1")!.token_sealed = account.token_sealed;
    const token = await accessToken(env, await loaded(), account);
    expect(token).toBe("fresh-token");
    const refresh = gmail.calls.find((c) => c.url.host === "oauth2.googleapis.com")!;
    expect(new URLSearchParams(refresh.body!).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(refresh.body!).get("refresh_token")).toBe("refresh-1");
    const stored = store.accounts.get("acc-1")!;
    expect(stored.token_sealed).not.toContain("fresh-token");
    const opened = openJson<StoredTokens>(stored.token_sealed!, keyring);
    expect(opened).toMatchObject({ accessToken: "fresh-token", refreshToken: "refresh-1" });
    await accessToken(env, await loaded(), account);
    expect(gmail.calls.filter((c) => c.url.host === "oauth2.googleapis.com")).toHaveLength(1);
  });

  it("moves the account to needs_reconnect and opens one issue when the refresh is refused", async () => {
    const { env, store, account, gmail, loaded, host } = setup();
    account.token_sealed = sealedTokens({ expiresAt: Date.now() - 1000 });
    gmail.tokenResponse = invalidGrant;
    await expect(accessToken(env, await loaded(), account)).rejects.toBeInstanceOf(GmailUnavailable);
    expect(store.accounts.get("acc-1")).toMatchObject({ status: "needs_reconnect" });
    expect(store.accounts.get("acc-1")!.last_error).toMatch(/invalid_grant/);
    const issues = [...host.issues.values()];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      title: `Reconnect Gmail: ${gmail.email}`,
      assigneeUserId: "user-1",
      originKind: "plugin:partnersinbiz.mailbox",
      originId: "reconnect:acc-1",
      priority: "high",
      status: "todo",
    });
    expect(store.accounts.get("acc-1")!.alert_issue_id).toBe(issues[0]!.id);
    // Later calls stop early and open no second issue.
    await expect(accessToken(env, await loaded(), { ...store.accounts.get("acc-1")! })).rejects.toBeInstanceOf(GmailUnavailable);
    expect(host.issues.size).toBe(1);
  });

  it("refreshes once on a 401 and retries the call", async () => {
    const { env, account, gmail, loaded } = setup();
    let first = true;
    gmail.intercept = (call) => {
      if (call.url.pathname.endsWith("/profile") && first) {
        first = false;
        return new Response(JSON.stringify({ error: { code: 401, message: "Invalid Credentials" } }), { status: 401 });
      }
      return null;
    };
    const profile = await withGmail(env, await loaded(), account, (token) => getProfile(env.fetch, token));
    expect(profile.emailAddress).toBe(gmail.email);
    const profiles = gmail.calls.filter((c) => c.url.pathname.endsWith("/profile"));
    expect(profiles.map((c) => c.headers.get("authorization"))).toEqual(["Bearer access-1", "Bearer fresh-token"]);
  });

  it("the sync job keeps going when one account's grant is dead", async () => {
    const { env, store, gmail, host } = setup();
    store.addAccount({ id: "acc-2", company_id: CO, address: "other@partnersinbiz.online", token_sealed: sealedTokens({ expiresAt: Date.now() - 1, refreshToken: "dead" }) });
    gmail.tokenResponse = () => invalidGrant();
    gmail.addMessage({ id: "a1", headers: { From: "a@b.co", Subject: "hi" } });
    const result = await runSyncJob(env);
    expect(result).toEqual({ accounts: 2, synced: 1, failed: 1 });
    expect(store.accounts.get("acc-2")!.status).toBe("needs_reconnect");
    expect(store.accounts.get("acc-1")!.status).toBe("connected");
    expect(host.issues.size).toBe(1);
  });
});

describe("connect Gmail", () => {
  function completeInput(state: string, code = "auth-code"): PluginApiRequestInput {
    return {
      routeKey: "oauth-complete",
      method: "POST",
      path: "/oauth/complete",
      params: {},
      query: {},
      body: { companyId: CO, state, params: { code, state } },
      actor: { actorType: "user", actorId: "user-7", userId: "user-7" },
      companyId: CO,
      headers: {},
    };
  }

  it("starts with the Gmail scopes and the bridge redirect URI, then stores sealed tokens on the account", async () => {
    const { env, store, gmail, host } = setup();
    store.accounts.clear();
    gmail.tokenResponse = () =>
      new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3599, scope: "openid https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send email" }), { status: 200 });
    const start = await connectStart(env, CO, "user-7", { returnTo: "/PIB/mailbox?connected=gmail" });
    const url = new URL(start.authorizeUrl);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send openid email");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(start.redirectUri).toBe("https://paperclip.example.com/_plugins/11111111-2222-3333-4444-555555555555/ui/oauth-callback.html");

    const res = await oauthComplete(env, completeInput(start.state));
    expect(res).toMatchObject({ status: 200, body: { redirectTo: "/PIB/mailbox?connected=gmail", address: gmail.email } });
    const account = [...store.accounts.values()][0]!;
    expect(account).toMatchObject({ address: gmail.email, status: "connected", is_default: true, connected_by_user_id: "user-7" });
    expect(account.token_sealed).not.toContain("new-refresh");
    expect(openJson<StoredTokens>(account.token_sealed!, keyring)).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    expect(new URLSearchParams(gmail.calls.find((c) => c.url.host === "oauth2.googleapis.com")!.body!).get("redirect_uri")).toBe(start.redirectUri);
    // The session is single-use.
    expect(await oauthComplete(env, completeInput(start.state))).toMatchObject({ status: 400 });
    expect(host.issues.size).toBe(0);
  });

  it("reconnects an account in place, keeps its cursor and closes the reconnect issue", async () => {
    const { env, store, gmail, host } = setup();
    const account = store.accounts.get("acc-1")!;
    Object.assign(account, { status: "needs_reconnect", history_id: "777", alert_issue_id: "issue-9" });
    host.issues.set("issue-9", { id: "issue-9", status: "todo" });
    gmail.tokenResponse = () => new Response(JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 3599, scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send" }), { status: 200 });
    const start = await connectStart(env, CO, "user-7", {});
    const res = await oauthComplete(env, completeInput(start.state));
    expect(res.status).toBe(200);
    expect(store.accounts.size).toBe(1);
    expect(store.accounts.get("acc-1")).toMatchObject({ status: "connected", history_id: "777", alert_issue_id: null, last_error: null });
    expect(host.issues.get("issue-9")!.status).toBe("done");
  });

  it("refuses a grant without refresh token or without both Gmail scopes", async () => {
    const { env, gmail } = setup();
    gmail.tokenResponse = () => new Response(JSON.stringify({ access_token: "a", expires_in: 3599, scope: "https://www.googleapis.com/auth/gmail.modify" }), { status: 200 });
    const noRefresh = await oauthComplete(env, completeInput((await connectStart(env, CO, "user-7", {})).state));
    expect(noRefresh).toMatchObject({ status: 400, body: { error: expect.stringMatching(/refresh token/) } });
    gmail.tokenResponse = () => new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3599, scope: "https://www.googleapis.com/auth/gmail.modify" }), { status: 200 });
    const noSend = await oauthComplete(env, completeInput((await connectStart(env, CO, "user-7", {})).state));
    expect(noSend).toMatchObject({ status: 400, body: { error: expect.stringMatching(/read and send/) } });
  });
});
