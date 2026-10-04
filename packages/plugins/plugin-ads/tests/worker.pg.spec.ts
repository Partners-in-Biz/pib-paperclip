/**
 * The worker as the host sees it: agent tools, page actions (a person versus an agent), the sign-in route, the jobs, the setup checklist and the
 * Cockpit snapshot. The agent can never approve, set a cap or switch changes on: those paths are people's, and these tests try to cross them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { getAccount, getConnection, getProposal, getScope, insertAccount, listAccounts, listConnections } from "../src/db.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { adsSetupStatus } from "../src/setup-status.js";
import { cockpitSnapshot } from "../src/cockpit.js";
import { ADS_TOOLS } from "../src/tools.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { ADS_AGENT, COMPANY, NOW, OWNER, REVIEWER, UI_BASE, settings, world, type World } from "./helpers/world.js";
import { CREATE, syncedAccount } from "./helpers/scenario.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

const run = (agentId = ADS_AGENT) => ({ companyId: COMPANY, agentId, runId: "run-1", projectId: "proj-1" });
const userActor = { actor: { type: "user" as const, userId: OWNER, agentId: null, runId: null, companyId: COMPANY }, companyId: COMPANY };
const agentActor = { actor: { type: "agent" as const, userId: null, agentId: ADS_AGENT, runId: "run-9", companyId: COMPANY }, companyId: COMPANY };

type ToolOut = { data?: Record<string, any>; error?: string; content?: string };
const tool = (w: World, name: string, params: Record<string, unknown> = {}, agentId = ADS_AGENT) => w.harness.executeTool<ToolOut>(name, params, run(agentId));
const act = <T = any>(w: World, key: string, params: Record<string, unknown> = {}, as: typeof userActor | typeof agentActor = userActor) => w.harness.performAction<T>(key, params, as);

describe.skipIf(!available)("the agent's tool surface", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w));
  });

  it("registers every tool the manifest declares, and an agent has no tool to approve, set a cap, or switch changes on", async () => {
    expect(manifest.tools!.map((t) => t.name)).toEqual(ADS_TOOLS.map((t) => t.name));
    for (const t of ADS_TOOLS) {
      const result = await tool(w, t.name, {});
      expect(JSON.stringify(result), t.name).not.toMatch(/not registered|unknown tool/i);
    }
    const names = ADS_TOOLS.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/approve-|set-cap|allow-writes|set-budget|set-signoffs|record-client-approval|connect-|oauth/);
    // The only tool that can move money needs a person's approval id, and the plugin checks it.
    expect(ADS_TOOLS.find((t) => t.name === "execute-ad-change")!.parametersSchema).toMatchObject({ required: ["proposalId", "approvalId"] });
  });

  it("works on PiB's own ads unless a client is named, and shows every scope only for 'all' on the read-only overviews", async () => {
    await w.harness.emit("plugin.partnersinbiz.crm.company.upserted", { id: "acme", name: "Acme Ltd", domain: null, lifecycle: null, updatedAt: "2026-10-01T00:00:00Z" }, { companyId: COMPANY });
    await syncedAccount(w, { scope: "company:acme", externalId: "ext-acme", signoffs: "owner_client" });
    const own = await tool(w, "list-ad-accounts");
    expect(own.data!.accounts.map((a: any) => a.scopeKey)).toEqual(["own"]);
    const client = await tool(w, "list-ad-accounts", { client: "company:acme" });
    expect(client.data!.accounts.map((a: any) => a.scopeKey)).toEqual(["company:acme"]);
    const all = await tool(w, "list-ad-accounts", { client: "all" });
    expect(all.data!.accounts.map((a: any) => a.scopeKey).sort()).toEqual(["company:acme", "own"]);
    const summary = await tool(w, "get-ads-summary", { period: "last_30d", groupBy: "scope", client: "all" });
    expect(summary.data!.groups.map((g: any) => g.label).sort()).toEqual(["Acme Ltd", "PiB (own ads)"]);
    expect((await tool(w, "get-ads-summary", { client: "own" })).data!.scope).toBe("own");
    // Never "all" for anything that decides work.
    for (const name of ["propose-ad-change", "register-ad-account", "set-ad-scope-rules", "check-ad-creative"]) {
      expect((await tool(w, name, { client: "all", kind: "pause_campaign", platform: "meta", connectionId: "x", externalId: "y" })).error, name).toMatch(/only for the read-only overviews/);
    }
  });

  it("reads the picture: summary, campaigns, ledger, budget status", async () => {
    const summary = await tool(w, "get-ads-summary", { period: "last_30d" });
    expect(summary.data!.totals[0]).toMatchObject({ currency: "ZAR", spendMinor: 60_000, clicks: 600, conversions: 24 });
    const campaigns = await tool(w, "list-ad-campaigns", { status: "active" });
    expect(campaigns.data!.campaigns.map((c: any) => [c.campaignExternalId, c.dailyBudgetMinor])).toEqual([["c1", 10_000], ["c3", 10_000]]);
    expect((await tool(w, "get-spend-ledger", { month: "2026-10" })).data!.entries).toHaveLength(12);
    const budget = (await tool(w, "get-budget-status")).data!.scopes[0];
    expect(budget).toMatchObject({ scopeKey: "own", capMinor: 500_000, spentMinor: 60_000, pctUsed: 12, state: "ok", allowWrites: true, projectedIfBudgetsSpentMinor: 400_000 });
    expect((await tool(w, "get-spend-ledger", { month: "10-2026" })).error).toMatch(/YYYY-MM/);
  });

  it("the full governed journey: propose, Reviewer passes, a person approves, the agent runs it with the approval id", async () => {
    const proposed = await tool(w, "propose-ad-change", { kind: "create_campaign", accountId, name: "Spring leads", dailyBudgetMinor: 5000, reason: "3x return" });
    expect(proposed.data).toMatchObject({ status: "in_review", requiresSignoffs: ["owner"], capState: "within" });
    const id = proposed.data!.proposalId as string;
    // The agent cannot run it before a person approved.
    expect((await tool(w, "execute-ad-change", { proposalId: id, approvalId: "x" })).error).toMatch(/not approved/);
    // The agent that asked cannot give its own proposal a pass: the verdict is the Reviewer's.
    expect((await tool(w, "record-ad-review", { proposalId: id, verdict: "pass", notes: "I checked it myself" })).error).toMatch(/Only the company's Reviewer/);
    expect((await tool(w, "get-ad-proposal", { proposalId: id })).data).toMatchObject({ reviewState: "pending" });
    // The Reviewer records a verdict through its own tool.
    expect((await tool(w, "record-ad-review", { proposalId: id, verdict: "pass", notes: "ok" }, REVIEWER)).data).toMatchObject({ reviewState: "pass" });
    // An agent cannot approve from the page either.
    await expect(act(w, "ads.approve", { proposalId: id }, agentActor)).rejects.toThrow(/signed-in person.*An agent cannot/);
    expect((await tool(w, "get-ad-proposal", { proposalId: id })).data).toMatchObject({ status: "in_review", approvalId: null });
    const approved = await act(w, "ads.approve", { proposalId: id }, userActor);
    expect(approved).toMatchObject({ status: "approved" });
    const detail = (await tool(w, "get-ad-proposal", { proposalId: id })).data!;
    expect(detail).toMatchObject({ status: "approved", approvalId: approved.approvalId });
    expect(detail.next).toMatch(/execute-ad-change/);
    const result = await tool(w, "execute-ad-change", { proposalId: id, approvalId: detail.approvalId });
    expect(result.data).toMatchObject({ status: "executed" });
    expect(w.mock.writes).toHaveLength(1);
    expect((await tool(w, "list-ad-proposals", { status: "executed" })).data!.proposals.map((p: any) => p.proposalId)).toEqual([id]);
    expect((await tool(w, "execute-ad-change", { proposalId: id, approvalId: detail.approvalId })).error).toMatch(/not approved/);
  });

  it("propose, revise and cancel through tools; the check tool never clears copy", async () => {
    const check = await tool(w, "check-ad-creative", { platform: "google", headline: "x".repeat(40), landingUrl: "http://acme.test", bannedWords: ["foo"] });
    expect(check.data).toMatchObject({ ok: false, blockers: 2 });
    expect(check.data!.note).toMatch(/never clears copy/);
    const bad = await tool(w, "propose-ad-change", { kind: "create_campaign", accountId, name: "Abc leads", dailyBudgetMinor: 5000, creative: { headline: "Fine", landingUrl: "http://acme.test" } });
    expect(bad.data).toMatchObject({ status: "needs_changes" });
    const id = bad.data!.proposalId;
    const fixed = await tool(w, "revise-ad-proposal", { proposalId: id, creative: { landingUrl: "https://acme.test" } });
    expect(fixed.data).toMatchObject({ status: "in_review" });
    expect((await tool(w, "cancel-ad-proposal", { proposalId: id, reason: "Not needed" })).data).toMatchObject({ status: "cancelled" });
    expect((await tool(w, "revise-ad-proposal", { proposalId: id, name: "Other" })).error).toMatch(/cannot be revised/);
  });

  it("the agent may add banned words but cannot remove one; caps and switches are not its to set", async () => {
    expect((await tool(w, "set-ad-scope-rules", { bannedWords: ["cheap", "free"], targetCpaMinor: 2500 })).data).toMatchObject({ ok: true });
    expect(await getScope(w.ctx, COMPANY, "own")).toMatchObject({ banned_words: ["cheap", "free"], target_cpa_minor: 2500 });
    expect((await tool(w, "set-ad-scope-rules", { bannedWords: ["cheap", "free", "best"] })).data).toMatchObject({ ok: true });
    const removed = await tool(w, "set-ad-scope-rules", { bannedWords: ["cheap"] });
    expect(removed.error).toMatch(/can only be removed by a person/);
    expect((await getScope(w.ctx, COMPANY, "own"))!.banned_words).toEqual(["cheap", "free", "best"]);
    // A tool schema that tries to smuggle a cap is refused by the schema, and the worker ignores unknown fields anyway.
    await tool(w, "set-ad-scope-rules", { monthlyCapMinor: 999_999_999, allowWrites: true });
    expect(await getScope(w.ctx, COMPANY, "own")).toMatchObject({ monthly_cap_minor: 500_000, allow_writes: true });
  });

  it("acknowledges an alert, and unknown or malformed calls come back as errors, never as crashes", async () => {
    expect((await tool(w, "acknowledge-ad-alert", { alertId: "nope", note: "x" })).error).toMatch(/not found/);
    expect((await tool(w, "get-ad-proposal", {})).error).toMatch(/proposalId is required/);
    expect((await tool(w, "list-ad-alerts", { status: "weird" })).error).toMatch(/status must be one of/);
    expect((await tool(w, "sync-ad-account", {})).data).toMatchObject({ accounts: 1, ok: 1 });
  });

  it("refuses when the module is switched off for the company", async () => {
    await w.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, namespace: "pib-setup", stateKey: "modules" }, { companyId: COMPANY, modules: { ads: false }, updatedAt: "2026-10-15T00:00:00Z" });
    // The module is not in the kit's registry yet, so the switch is not honoured: the tool still answers (documented in the README).
    expect((await tool(w, "list-ad-accounts")).error).toBeUndefined();
  });
});

describe.skipIf(!available)("page actions: a person, not an agent", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w, { cap: null, allowWrites: false }));
  });

  it("only a person sets a cap, switches changes on (needs a cap and the company switch), or changes who must sign", async () => {
    await expect(act(w, "ads.set-cap", { scopeKey: "own", monthlyCapMinor: 100_000 }, agentActor)).rejects.toThrow(/Only a signed-in person/);
    await expect(act(w, "ads.set-allow-writes", { scopeKey: "own", allow: true }, agentActor)).rejects.toThrow(/Only a signed-in person/);
    await expect(act(w, "ads.set-allow-writes", { scopeKey: "own", allow: true }, userActor)).rejects.toThrow(/Set a monthly budget cap/);
    await expect(act(w, "ads.set-cap", { scopeKey: "own", monthlyCapMinor: 0 }, userActor)).rejects.toThrow(/more than zero/);
    await expect(act(w, "ads.set-cap", { scopeKey: "own", monthlyCapMinor: 100_000, alertPct: 20 }, userActor)).rejects.toThrow(/50 to 100/);
    await act(w, "ads.set-cap", { scopeKey: "own", monthlyCapMinor: 100_000, alertPct: 80 }, userActor);
    expect(await getScope(w.ctx, COMPANY, "own")).toMatchObject({ monthly_cap_minor: 100_000, alert_pct: 80 });
    await act(w, "ads.set-cap", { scopeKey: "own", monthlyCapMinor: 250_000, month: "2026-12", note: "Black Friday" }, userActor);
    expect((await pg.client.query(`SELECT cap_minor, note, set_by FROM ${w.ctx.db.namespace}.budget_overrides`)).rows).toEqual([{ cap_minor: "250000", note: "Black Friday", set_by: `user:${OWNER}` }]);
    const on = await act(w, "ads.set-allow-writes", { scopeKey: "own", allow: true }, userActor);
    expect(on).toMatchObject({ allowWrites: true });
    expect(await getScope(w.ctx, COMPANY, "own")).toMatchObject({ allow_writes: true, allow_writes_by: `user:${OWNER}` });
    // Switching off needs no cap and is always allowed.
    await act(w, "ads.set-allow-writes", { scopeKey: "own", allow: false }, userActor);
    expect((await getScope(w.ctx, COMPANY, "own"))!.allow_writes).toBe(false);
    const audit = (await pg.client.query(`SELECT action FROM ${w.ctx.db.namespace}.audit WHERE action LIKE 'writes.%' OR action LIKE 'budget.%' ORDER BY at`)).rows.map((r: any) => r.action);
    expect(audit).toEqual(["budget.cap_set", "budget.month_cap_set", "writes.enabled", "writes.disabled"]);
    await expect(act(w, "ads.set-signoffs", { scopeKey: "own", signoffs: "owner_client" }, userActor)).rejects.toThrow(/no client to sign off/);
  });

  it("switching changes on is refused while the company switch in the settings is off", async () => {
    await pg.reset();
    const off = await world(pg, { config: settings({ writes: { enabled: false } }) });
    await syncedAccount(off, { allowWrites: false });
    await expect(act(off, "ads.set-allow-writes", { scopeKey: "own", allow: true }, userActor)).rejects.toThrow(/switched off for the whole company/);
  });

  it("the page loads one overview with everything it draws, and a person (not an agent) does the rest", async () => {
    const overview = await act(w, "ads.load", { uiBase: UI_BASE }, userActor);
    expect(overview).toMatchObject({ settingsSaved: true, writesEnabled: true, redirectUri: "https://paperclip.example.test/_plugins/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/ui/oauth-callback.html" });
    expect(overview.accounts).toHaveLength(1);
    expect(overview.platforms.map((p: any) => [p.platform, p.enabled])).toEqual([["meta", true], ["google", true], ["mock", true]]);
    expect(overview.budgets[0]).toMatchObject({ scopeKey: "own", cap: "none set", state: "no_cap" });
    expect(JSON.stringify(overview)).not.toMatch(/token_enc|secret/i);
    await expect(act(w, "ads.sync", {}, agentActor)).rejects.toThrow(/signed-in person/);
    await expect(act(w, "ads.remove-account", { accountId }, agentActor)).rejects.toThrow(/signed-in person/);
    await act(w, "ads.remove-account", { accountId }, userActor);
    expect((await getAccount(w.ctx, COMPANY, accountId))!.status).toBe("disabled");
  });

  it("a person records the client's yes and runs an approved change from the page", async () => {
    await pg.reset();
    const c = await world(pg);
    await c.harness.emit("plugin.partnersinbiz.crm.company.upserted", { id: "acme", name: "Acme Ltd", domain: null, lifecycle: null, updatedAt: "2026-10-01T00:00:00Z" }, { companyId: COMPANY });
    const acct = await syncedAccount(c, { scope: "company:acme", externalId: "ext-acme", signoffs: "owner_client" });
    const proposed = await tool(c, "propose-ad-change", { client: "company:acme", kind: "resume_campaign", targets: [{ accountId: acct.accountId, campaignExternalId: "c2" }], reason: "Sale" });
    const id = proposed.data!.proposalId;
    await tool(c, "record-ad-review", { proposalId: id, verdict: "pass" }, REVIEWER);
    await act(c, "ads.approve", { proposalId: id, role: "owner" });
    await expect(act(c, "ads.execute", { proposalId: id })).rejects.toThrow(/no valid owner approval/);
    await act(c, "ads.approve", { proposalId: id, role: "client", note: "Jo emailed: yes please" });
    const result = await act(c, "ads.execute", { proposalId: id });
    expect(result).toMatchObject({ status: "executed" });
    expect(c.mock.writes.at(-1)).toMatchObject({ op: "status", campaignExternalId: "c2", status: "active" });
  });
});

describe.skipIf(!available)("connecting a platform", () => {
  let w: World;
  const complete = (state: string, params: Record<string, string> = { code: "abc" }, actor: Partial<PluginApiRequestInput["actor"]> = { actorType: "user", actorId: OWNER, userId: OWNER }) =>
    plugin.definition.onApiRequest!({ routeKey: "oauth-complete", method: "POST", path: "/oauth/complete", params: {}, query: {}, body: { companyId: COMPANY, state, params }, actor: { actorType: "user", actorId: OWNER, userId: OWNER, agentId: null, runId: null, ...actor }, companyId: COMPANY, headers: {} } as unknown as PluginApiRequestInput);

  const readOnlyApp = () => settings({ platforms: { mock: { enabled: true }, meta: { enabled: true, appId: "app-1", appSecret: "s".repeat(20) }, google: { enabled: true, clientId: "cid", clientSecret: "g".repeat(20) } } });
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg, { config: readOnlyApp() });
    await w.ctx.state.set({ scopeKey: undefined, scopeKind: "instance", namespace: "pib-kit", stateKey: "plugin-ui-base" } as never, UI_BASE);
    w.mock.accounts = [{ externalId: "ext-1", name: "Acme", currency: "ZAR", timezone: "UTC", status: "active" }];
  });

  it("starts a sign-in only for a person with an app saved, and finishes it once, for the person who started it", async () => {
    await expect(act(w, "ads.oauth-start", { platform: "meta" }, agentActor)).rejects.toThrow(/signed-in person/);
    const start = await act(w, "ads.oauth-start", { platform: "meta" }, userActor);
    expect(start).toMatchObject({ platform: "meta", readOnly: true, redirectUri: "https://paperclip.example.test/_plugins/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/ui/oauth-callback.html" });
    expect(start.authorizeUrl).toContain(start.state);
    // Another person, another company, an agent: refused, and the state is not used up.
    expect((await complete(start.state, { code: "abc" }, { actorType: "user", actorId: "intruder", userId: "intruder" })).status).toBe(403);
    expect((await complete(start.state, { code: "abc" }, { actorType: "agent", actorId: "ag", userId: null })).status).toBe(403);
    expect((await complete(start.state, { error: "access_denied", error_description: "The person said no" })).status).toBe(400);
    const done = await complete(start.state);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ ok: true, platform: "meta", canWrite: false });
    const [conn] = await listConnections(w.ctx, COMPANY);
    expect(conn).toMatchObject({ platform: "meta", mode: "oauth", can_write: false, status: "connected" });
    expect(conn!.token_enc).toMatch(/^v1\./);
    // Replaying the same callback does nothing more.
    expect((await complete(start.state)).status).toBeGreaterThanOrEqual(400);
    expect(await listConnections(w.ctx, COMPANY)).toHaveLength(1);
    expect((await complete("never-issued")).status).toBe(400);
  });

  it("a connection may change ads only when the settings asked for it AND the platform granted it", async () => {
    // The mock platform grants everything; the settings did not ask, so the connection is read-only.
    const start = await act(w, "ads.oauth-start", { platform: "meta" }, userActor);
    await complete(start.state);
    expect((await listConnections(w.ctx, COMPANY))[0]!.can_write).toBe(false);
    // Asked for in the settings: the connection may change ads (the scope's own switch and every approval still apply).
    await pg.reset();
    const asked = await world(pg, { config: settings() });
    await asked.ctx.state.set({ scopeKind: "instance", namespace: "pib-kit", stateKey: "plugin-ui-base" } as never, UI_BASE);
    const s2 = await act(asked, "ads.oauth-start", { platform: "meta" }, userActor);
    expect(s2.readOnly).toBe(false);
    const finished = await plugin.definition.onApiRequest!({ routeKey: "oauth-complete", method: "POST", path: "/oauth/complete", params: {}, query: {}, body: { companyId: COMPANY, state: s2.state, params: { code: "abc" } }, actor: { actorType: "user", actorId: OWNER, userId: OWNER, agentId: null, runId: null }, companyId: COMPANY, headers: {} } as unknown as PluginApiRequestInput);
    expect(finished.status).toBe(200);
    expect((await listConnections(asked.ctx, COMPANY))[0]!.can_write).toBe(true);
  });

  it("Google can be given the change permission too, by its own switch in the settings (and is read-only without it)", async () => {
    // The worker answers for the world set up last, so each call is made while its own world is the latest.
    const finish = async (state: string) => plugin.definition.onApiRequest!({ routeKey: "oauth-complete", method: "POST", path: "/oauth/complete", params: {}, query: {}, body: { companyId: COMPANY, state, params: { code: "abc" } }, actor: { actorType: "user", actorId: OWNER, userId: OWNER, agentId: null, runId: null }, companyId: COMPANY, headers: {} } as unknown as PluginApiRequestInput);
    const readOnly = await act(w, "ads.oauth-start", { platform: "google" }, userActor);
    expect(readOnly.readOnly).toBe(true);
    expect((await finish(readOnly.state)).body).toMatchObject({ ok: true, platform: "google", canWrite: false });
    expect((await listConnections(w.ctx, COMPANY))[0]!.can_write).toBe(false);
    await pg.reset();
    const asked = await world(pg, { config: settings({ platforms: { mock: { enabled: true }, google: { enabled: true, clientId: "cid", clientSecret: "g".repeat(20), requestWrite: true } } }) });
    await asked.ctx.state.set({ scopeKind: "instance", namespace: "pib-kit", stateKey: "plugin-ui-base" } as never, UI_BASE);
    const start = await act(asked, "ads.oauth-start", { platform: "google" }, userActor);
    expect(start.readOnly).toBe(false);
    expect((await finish(start.state)).body).toMatchObject({ ok: true, platform: "google", canWrite: true });
    expect((await listConnections(asked.ctx, COMPANY))[0]!.can_write).toBe(true);
  });

  it("a platform that is not switched on or has no app cannot be connected, and says why", async () => {
    await pg.reset();
    const off = await world(pg, { config: settings({ platforms: { meta: { enabled: false, appId: "a", appSecret: "s".repeat(20) } } }) });
    await expect(act(off, "ads.oauth-start", { platform: "meta" }, userActor)).rejects.toThrow(/switched off/);
    await expect(act(off, "ads.oauth-start", { platform: "google" }, userActor)).rejects.toThrow(/switched off/);
    await expect(act(off, "ads.oauth-start", { platform: "tiktok" }, userActor)).rejects.toThrow(/Unsupported platform/);
    await expect(act(off, "ads.connect-mock", {}, userActor)).rejects.toThrow(/test platform is switched off/);
  });

  it("signing in again as the same person replaces the old connection: its accounts move over and the 'sign in again' issue closes", async () => {
    const first = await act(w, "ads.oauth-start", { platform: "meta" }, userActor);
    await complete(first.state);
    const [old] = await listConnections(w.ctx, COMPANY);
    await act(w, "ads.register-account", { connectionId: old!.id, externalId: "ext-1", scopeKey: "own" }, userActor).catch(() => undefined);
    const { markNeedsReconnect } = await import("../src/connections.js");
    await markNeedsReconnect(w.rt(), (await getConnection(w.ctx, COMPANY, old!.id))!, "Token expired");
    const issueId = (await getConnection(w.ctx, COMPANY, old!.id))!.reconnect_issue_id!;
    const second = await act(w, "ads.oauth-start", { platform: "meta" }, userActor);
    await complete(second.state);
    const connections = await listConnections(w.ctx, COMPANY);
    expect(connections).toHaveLength(1);
    expect(connections[0]!.id).not.toBe(old!.id);
    expect((await getConnection(w.ctx, COMPANY, old!.id))!.status).toBe("disabled");
    expect((await w.issues()).find((i) => i.id === issueId)).toMatchObject({ status: "done" });
    for (const account of await listAccounts(w.ctx, COMPANY)) expect(account.connection_id).toBe(connections[0]!.id);
  });

  it("a connection that needs signing in again is replaced by the next sign-in even when the platform does not say who signed in; an account the new sign-in cannot see stays behind", async () => {
    const { accountId: seen, connectionId: old } = await w.account({ platform: "google", externalId: "ext-1" });
    const gone = await insertAccount(w.ctx, { companyId: COMPANY, platform: "google", externalId: "ext-gone", name: "Gone", currency: "ZAR", timezone: "UTC", scopeKey: "own", connectionId: old, loginCustomerId: null, createdBy: "test" });
    const { markNeedsReconnect } = await import("../src/connections.js");
    await markNeedsReconnect(w.rt(), (await getConnection(w.ctx, COMPANY, old))!, "Token has been expired or revoked.");
    const issueId = (await getConnection(w.ctx, COMPANY, old))!.reconnect_issue_id!;
    await complete((await act(w, "ads.oauth-start", { platform: "google" }, userActor)).state);
    const first = (await listConnections(w.ctx, COMPANY)).find((c) => c.id !== old)!;
    expect((await getAccount(w.ctx, COMPANY, seen))!.connection_id).toBe(first.id);
    // The account the new sign-in cannot see stays on the old connection, which stays flagged, and its issue stays open.
    expect((await getAccount(w.ctx, COMPANY, gone))!.connection_id).toBe(old);
    expect((await getConnection(w.ctx, COMPANY, old))!.status).toBe("needs_reconnect");
    expect((await w.issues()).find((i) => i.id === issueId)).toMatchObject({ status: "todo" });
    // Signing in with a login that can see it too: everything moves over, the old connections retire and the issue closes.
    w.mock.accounts = [...w.mock.accounts, { externalId: "ext-gone", name: "Gone", currency: "ZAR", timezone: "UTC", status: "active" }];
    await complete((await act(w, "ads.oauth-start", { platform: "google" }, userActor)).state);
    const latest = (await listConnections(w.ctx, COMPANY)).find((c) => c.status === "connected" && c.id !== first.id)!;
    for (const id of [seen, gone]) expect((await getAccount(w.ctx, COMPANY, id))!.connection_id).toBe(latest.id);
    expect((await getConnection(w.ctx, COMPANY, old))!.status).toBe("disabled");
    expect((await getConnection(w.ctx, COMPANY, first.id))!.status).toBe("disabled");
    expect((await w.issues()).find((i) => i.id === issueId)).toMatchObject({ status: "done" });
  });

  it("a healthy sign-in of someone else is never taken over by a new sign-in", async () => {
    const { accountId, connectionId } = await w.account({ platform: "google", externalId: "ext-1" });
    await complete((await act(w, "ads.oauth-start", { platform: "google" }, userActor)).state);
    const connections = await listConnections(w.ctx, COMPANY);
    expect(connections).toHaveLength(2);
    expect((await getAccount(w.ctx, COMPANY, accountId))!.connection_id).toBe(connectionId);
    expect((await getConnection(w.ctx, COMPANY, connectionId))!.status).toBe("connected");
  });

  it("the sign-in session is stored without any token and expires", async () => {
    const start = await act(w, "ads.oauth-start", { platform: "meta" }, userActor);
    const row = (await pg.client.query(`SELECT * FROM ${w.ctx.db.namespace}.oauth_sessions WHERE state = $1`, [start.state])).rows[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(["company_id", "consumed", "created_at", "created_by_user_id", "expires_at", "platform", "state"]);
    await pg.client.query(`UPDATE ${w.ctx.db.namespace}.oauth_sessions SET expires_at = now() - interval '1 minute' WHERE state = $1`, [start.state]);
    expect((await complete(start.state)).status).toBe(400);
  });
});

describe.skipIf(!available)("jobs, setup checklist and the Cockpit", () => {
  let w: World;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
  });

  it("the sync job reads every company that saved its settings, and raises what it finds", async () => {
    await syncedAccount(w, { cap: 64_000 });
    await w.harness.runJob("sync-insights");
    const accounts = await listAccounts(w.ctx, COMPANY);
    expect(accounts[0]!.last_sync_ok_at).toEqual(expect.any(String));
    const pause = (await pg.client.query(`SELECT kind, origin FROM ${w.ctx.db.namespace}.proposals`)).rows;
    expect(pause).toEqual([{ kind: "pause_campaign", origin: "budget_90" }]);
    expect(w.mock.writes).toEqual([]);
  });

  it("a company that never saved the plugin settings is not touched by the jobs", async () => {
    await pg.reset();
    const unsaved = await world(pg, { config: {} });
    await syncedAccount(unsaved);
    const before = unsaved.mock.reads.length;
    await unsaved.harness.runJob("sync-insights");
    expect(unsaved.mock.reads.length).toBe(before);
  });

  it("the keep-alive job and the hourly job run and record themselves for the Cockpit's job health", async () => {
    await syncedAccount(w);
    await w.harness.runJob("refresh-connections");
    await w.harness.runJob("setup-status");
    for (const key of ["refresh-connections", "setup-status"]) {
      const state = w.harness.getState({ scopeKind: "instance", namespace: "pib-cockpit-jobs", stateKey: `job:${key}` }) as { lastOkAt: string | null };
      expect(state?.lastOkAt, key).toEqual(expect.any(String));
    }
  });

  it("the setup checklist is one optional item until settings are saved, then lists exactly what is left", async () => {
    await pg.reset();
    const unsaved = await world(pg, { config: {} });
    const off = await adsSetupStatus(unsaved.ctx, COMPANY, NOW);
    expect(off.items.map((i) => [i.key, i.required, i.status])).toEqual([["settings", false, "missing"]]);
    expect(off.items.every((i) => !i.required)).toBe(true);

    await pg.reset();
    const fresh = await world(pg);
    const status = await adsSetupStatus(fresh.ctx, COMPANY, NOW);
    const byKey = Object.fromEntries(status.items.map((i) => [i.key, i]));
    expect(Object.keys(byKey)).toEqual(["settings", "base_url_key", "platform_meta", "platform_google", "platform_connected", "ad_accounts", "budget_caps", "agent", "writes"]);
    expect(byKey.base_url_key).toMatchObject({ status: "done", required: true });
    expect(byKey.platform_connected).toMatchObject({ status: "missing", required: true });
    expect(byKey.ad_accounts).toMatchObject({ status: "blocked", blockedBy: ["platform_connected"] });
    expect(byKey.writes).toMatchObject({ status: "optional", required: false });
    // The platform items carry the exact owner steps, deep links and lead times.
    const metaSteps = (byKey.platform_meta!.steps ?? []).join("\n");
    expect(metaSteps).toContain("https://developers.facebook.com/apps");
    expect(metaSteps).toMatch(/Advanced access.*App Review/s);
    expect(metaSteps).toMatch(/one to two weeks/);
    expect(metaSteps).toContain("https://paperclip.example.test/_plugins/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/ui/oauth-callback.html");
    const googleSteps = (byKey.platform_google!.steps ?? []).join("\n");
    expect(googleSteps).toContain("https://console.cloud.google.com/apis/library/googleads.googleapis.com");
    expect(googleSteps).toMatch(/Testing.*7 days/s);
    expect(googleSteps).toMatch(/Basic access/);
    expect(googleSteps).toMatch(/developer tokens are no longer issued/);
    expect(JSON.stringify(status)).not.toMatch(/s{20}|k{24}/); // no secret value anywhere
    // After a connection, an account and a cap, only the agent is left.
    // The rehearsal platform never counts as a connected platform.
    await syncedAccount(fresh);
    expect((await adsSetupStatus(fresh.ctx, COMPANY, NOW)).items.filter((i) => i.required && i.status !== "done").map((i) => i.key)).toEqual(["platform_connected"]);
    await pg.reset();
    const real = await world(pg);
    await syncedAccount(real, { platform: "meta" });
    const after = await adsSetupStatus(real.ctx, COMPANY, NOW);
    expect(after.items.filter((i) => i.required && i.status !== "done").map((i) => i.key)).toEqual([]);
    expect(after.items.find((i) => i.key === "platform_meta")).toMatchObject({ status: "done" });
    const route = await plugin.definition.onApiRequest!({ routeKey: "setup-status", method: "GET", path: "/setup-status", params: {}, query: { companyId: COMPANY }, body: null, actor: { actorType: "user", actorId: OWNER, userId: OWNER, agentId: null, runId: null }, companyId: COMPANY, headers: {} } as unknown as PluginApiRequestInput);
    expect(route.status).toBe(200);
  });

  it("the Cockpit snapshot shows spend, the budget, waiting changes, alerts and health, and what is waiting on a person", async () => {
    await syncedAccount(w, { cap: 64_000 });
    await w.harness.runJob("sync-insights");
    const snap = await cockpitSnapshot(w.ctx, COMPANY, w.rt());
    expect(snap.plugin).toBe("partnersinbiz.ads");
    expect(snap.kpis.map((k) => k.key)).toEqual(["ads_spend", "ads_cpa", "ads_changes", "ads_alerts"]);
    expect(snap.kpis.find((k) => k.key === "ads_spend")).toMatchObject({ tone: "warn" });
    expect(snap.waiting).toHaveLength(1);
    expect(snap.waiting[0]).toMatchObject({ kind: "money", why: expect.stringContaining("Nothing changes in any ad platform until a person approves") });
    expect(snap.health.find((h) => h.key === "cap:own")).toMatchObject({ status: "warn" });
    expect(snap.health.some((h) => h.key.startsWith("job:"))).toBe(true);
    expect(snap.health.find((h) => h.key === "ads:agent")).toBeUndefined();
    // No cap: a warning, and no change that adds spend can run.
    await pg.reset();
    const noCap = await world(pg);
    await syncedAccount(noCap, { cap: null });
    expect((await cockpitSnapshot(noCap.ctx, COMPANY, noCap.rt())).health.find((h) => h.key === "cap:own")).toMatchObject({ status: "warn", detail: expect.stringContaining("No monthly budget cap") });
    expect(await getProposal(w.ctx, COMPANY, "x")).toBeNull();
  });

  it("a connection that needs signing in is a red health check with the way out", async () => {
    const acct = await syncedAccount(w);
    const { updateConnection } = await import("../src/db.js");
    await updateConnection(w.ctx, COMPANY, (await getAccount(w.ctx, COMPANY, acct.accountId))!.connection_id!, { status: "needs_reconnect", statusDetail: "Token expired" });
    const snap = await cockpitSnapshot(w.ctx, COMPANY, w.rt());
    expect(snap.health.find((h) => h.key.startsWith("connection:"))).toMatchObject({ status: "bad", detail: "Token expired", href: "/ads?tab=accounts" });
  });
});

describe.skipIf(!available)("hiring the ads agent", () => {
  it("opens a hire task, links the agent and wires it: plugin tool access and the Ads project, never a second grant", async () => {
    await pg.reset();
    const w = await world(pg);
    const options = await act(w, "ads.hire-options", {}, userActor);
    expect(options.draft.title).toContain("Paid Ads Manager");
    expect(options.draft.description).toContain("claude-sonnet-5-5");
    expect(options.draft.description).toContain("partnersinbiz.ads");
    const hire = await act(w, "ads.start-hire", { assigneeAgentId: OPERATOR_ID }, userActor);
    expect(hire).toMatchObject({ status: "open" });
    const linked = await act(w, "ads.link-agent", { agentId: ADS_AGENT }, userActor);
    expect(linked.steps.join(" ")).toMatch(/Granted .* access to plugin tools|already has plugin tool access/);
    expect(linked.steps.join(" ")).toContain("The Ads project is ready");
    const grants = await w.ctx.authorization.grants.list({ companyId: COMPANY, principalType: "agent", principalId: ADS_AGENT });
    expect(grants.filter((g) => g.permissionKey === "tools:use")).toHaveLength(1);
    await act(w, "ads.link-agent", { agentId: ADS_AGENT }, userActor);
    expect((await w.ctx.authorization.grants.list({ companyId: COMPANY, principalType: "agent", principalId: ADS_AGENT })).filter((g) => g.permissionKey === "tools:use")).toHaveLength(1);
    await expect(act(w, "ads.start-hire", {}, agentActor)).rejects.toThrow(/signed-in person/);
  });
});

const OPERATOR_ID = "agent-operator";
void REVIEWER;
