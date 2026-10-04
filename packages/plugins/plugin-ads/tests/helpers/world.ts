/**
 * A plugin world for tests: the SDK's in-memory host (capabilities enforced from the manifest), the real Postgres behind `ctx.db`, a Reviewer,
 * an Operator and an owner in the roles copy, and an AdsRuntime wired to a mock platform and a fixed clock.
 */
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import manifest from "../../src/manifest.js";
import plugin from "../../src/worker.js";
import { MockAdsProvider } from "../../src/providers/mock.js";
import { clock, providers, runtimeFromRaw, type AdsRuntime } from "../../src/runtime.js";
import { insertConnection, ensureScope, insertAccount, updateScope } from "../../src/db.js";
import type { Pg } from "./pg.js";

export const COMPANY = "11111111-1111-1111-1111-111111111111";
export const OWNER = "user-owner";
export const REVIEWER = "agent-reviewer";
export const OPERATOR = "agent-operator";
export const ADS_AGENT = "agent-ads";
export const AM_AGENT = "agent-am";
export const NOW = new Date("2026-10-15T10:00:00Z");
export const UI_BASE = "/_plugins/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/ui/";

/** Settings a configured company would have. A plain string stands in for a secret reference (the kit accepts both). */
export function settings(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    publicBaseUrl: "https://paperclip.example.test",
    encryptionKey: "k".repeat(24),
    timezone: "UTC",
    writes: { enabled: true },
    platforms: { mock: { enabled: true }, meta: { enabled: true, appId: "app-1", appSecret: "s".repeat(20), requestWrite: true }, google: { enabled: true, clientId: "cid", clientSecret: "g".repeat(20) } },
    ...extra,
  };
}

export interface World {
  /**
   * Runs `work` as the HOST, not the plugin: a person's or an agent's own change to an issue (which the host reports to the plugin as an
   * `issue.updated` event by that actor) must not be echoed back as the plugin's own write.
   */
  asHost: <T>(work: () => Promise<T>) => Promise<T>;
  harness: TestHarness;
  ctx: PluginContext;
  mock: MockAdsProvider;
  /** A runtime on this world's settings, the mock platform and the fixed clock; `now` can move. */
  rt: (raw?: Record<string, unknown>, now?: Date) => AdsRuntime;
  issues: () => Promise<Array<{ id: string; title: string; status: string; assigneeAgentId?: string | null; assigneeUserId?: string | null; originId?: string | null; description?: string }>>;
  /** Every comment the plugin posted on an issue (the plugin has no right to read comments, so the test records what it writes). */
  comments: (issueId: string) => string[];
  /** A connected mock connection, an ad account under `scope` and the scope row. */
  account: (options?: { scope?: string; currency?: string; externalId?: string; name?: string; cap?: number | null; allowWrites?: boolean; signoffs?: "owner" | "owner_client"; platform?: "mock" | "meta" | "google"; canWrite?: boolean }) => Promise<{ accountId: string; connectionId: string; scopeKey: string }>;
}

export async function world(pg: Pg, options: { config?: Record<string, unknown>; roles?: { reviewer?: boolean; operator?: boolean; reviewOutward?: boolean; owner?: boolean } } = {}): Promise<World> {
  const config = options.config ?? settings();
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    companies: [{ id: COMPANY, name: "Partners in Biz", issuePrefix: "PIB", defaultResponsibleUserId: options.roles?.owner === false ? null : OWNER } as never],
    agents: [
      { id: REVIEWER, companyId: COMPANY, name: "Reviewer", status: "idle", role: "general" } as never,
      { id: OPERATOR, companyId: COMPANY, name: "Operator", status: "idle", role: "general" } as never,
      { id: ADS_AGENT, companyId: COMPANY, name: "Paid Ads Manager", status: "idle", role: "general", adapterConfig: { paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-ads/ads", "pib-company-os"] } } } as never,
      { id: AM_AGENT, companyId: COMPANY, name: "Account Manager", status: "idle", role: "general" } as never,
    ],
  });
  (harness.ctx as unknown as { db: unknown }).db = pg.db;
  const commentLog = new Map<string, string[]>();
  const issuesClient = harness.ctx.issues as unknown as { createComment: (issueId: string, body: string, companyId: string, ...rest: unknown[]) => Promise<unknown> };
  const originalComment = issuesClient.createComment.bind(issuesClient);
  issuesClient.createComment = async (issueId, body, companyId, ...rest) => {
    commentLog.set(issueId, [...(commentLog.get(issueId) ?? []), body]);
    return originalComment(issueId, body, companyId, ...rest);
  };
  // The live host logs every update a plugin makes to an issue as `issue.updated` by actor `plugin` and delivers it to subscribers, the plugin that
  // made it included (host plugin-host-services logPluginActivity, plugin-event-bus: no self-origin filter). The SDK's in-memory host does not, so a
  // plugin that mistakes its own close for somebody else's passes every test and misbehaves live. Echo the same way here, for every plugin update.
  const echo = { on: true, depth: 0 };
  const issuesApi = harness.ctx.issues as unknown as { update: (issueId: string, patch: unknown, companyId: string, ...rest: unknown[]) => Promise<unknown> };
  const originalUpdate = issuesApi.update.bind(issuesApi);
  issuesApi.update = async (issueId, patch, companyId, ...rest) => {
    const updated = await originalUpdate(issueId, patch, companyId, ...rest);
    if (echo.on && echo.depth < 3) {
      echo.depth += 1;
      try {
        await harness.emit("issue.updated", patch as Record<string, unknown>, { companyId, entityId: issueId, entityType: "issue", actorType: "plugin", actorId: "plugin-installation-id" });
      } finally {
        echo.depth -= 1;
      }
    }
    return updated;
  };
  const asHost: World["asHost"] = async (work) => {
    const before = echo.on;
    echo.on = false;
    try {
      return await work();
    } finally {
      echo.on = before;
    }
  };
  await plugin.definition.setup(harness.ctx);
  const roles = options.roles ?? {};
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, namespace: "pib-cockpit", stateKey: "roles" },
    {
      companyId: COMPANY,
      operatorAgentId: roles.operator === false ? null : OPERATOR,
      reviewerAgentId: roles.reviewer === false ? null : REVIEWER,
      ownerUserId: roles.owner === false ? null : OWNER,
      reviewOutward: roles.reviewOutward ?? roles.reviewer !== false,
      team: { "ads-manager": { agentId: ADS_AGENT }, "account-manager": { agentId: AM_AGENT } },
      updatedAt: "2026-10-15T09:00:00Z",
      receivedAt: "2026-10-15T09:00:00Z",
    },
  );
  // The linked ads agent (what Setup -> Team writes when an agent is hired or picked).
  await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, namespace: "pib-hire", stateKey: "role:ads-manager" }, { agentId: ADS_AGENT, linkedAt: "2026-10-01T00:00:00Z", linkedBy: "manual", hire: null });
  clock.now = () => NOW;
  const mock = new MockAdsProvider("mock");
  mock.clock = () => NOW;
  providers.resolve = () => mock;
  const rt = (raw: Record<string, unknown> = config, now: Date = NOW) => runtimeFromRaw(harness.ctx, COMPANY, raw, { provider: () => mock, now: () => now }, UI_BASE);
  const account: World["account"] = async (o = {}) => {
    const scopeKey = o.scope ?? "own";
    const currency = o.currency ?? "ZAR";
    const platform = o.platform ?? "mock";
    await ensureScope(harness.ctx, COMPANY, scopeKey, currency);
    await updateScope(harness.ctx, COMPANY, scopeKey, { ...(o.cap !== undefined ? { monthlyCapMinor: o.cap } : { monthlyCapMinor: 500_000 }), ...(o.allowWrites ? { allowWrites: true, allowWritesBy: `user:${OWNER}` } : {}), ...(o.signoffs ? { signoffs: o.signoffs } : {}) });
    const connectionId = await insertConnection(harness.ctx, { companyId: COMPANY, platform, label: `${platform} test`, mode: "token", tokenEnc: null, keyVersion: null, expiresAt: null, scopes: ["x"], canWrite: o.canWrite ?? true, externalUserId: "u1", createdBy: OWNER });
    const accountId = await insertAccount(harness.ctx, { companyId: COMPANY, platform, externalId: o.externalId ?? `acct-${scopeKey}`, name: o.name ?? "Test account", currency, timezone: "UTC", scopeKey, connectionId, loginCustomerId: null, createdBy: "test" });
    return { accountId, connectionId, scopeKey };
  };
  return {
    asHost,
    harness,
    ctx: harness.ctx,
    mock,
    rt,
    issues: async () => (await harness.ctx.issues.list({ companyId: COMPANY, limit: 500 })) as never,
    comments: (issueId) => commentLog.get(issueId) ?? [],
    account,
  };
}
