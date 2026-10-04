import { describe, expect, it, vi } from "vitest";
import type { PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { HANDOFF_EVENTS, signUnsubscribeToken } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import { claimedCompany, handleUnsubscribeWebhook, oneClickReady, oneClickUrl, probeCompanies, probeUnsubscribeProxy, PROBE_EMAIL, PROBE_SENDER_PREFIX, proofIsFresh, PROXY_PROOF_MAX_AGE_MS, readProxyProof, TOKEN_HEADER, tokenFromDelivery, tokenFromWebhook } from "../src/unsubscribe.js";
import plugin from "../src/worker.js";
import { CO } from "./helpers/memory.js";
import { fakeSelfFetch, openGate } from "./helpers/proxy.js";
import { setup } from "./helpers/setup.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

const SECRET = "unsubscribe-secret-0123456789";

function delivery(over: Partial<PluginWebhookInput> = {}): PluginWebhookInput {
  return { endpointKey: "unsubscribe", headers: { "content-type": "application/x-www-form-urlencoded" }, rawBody: "", parsedBody: {}, requestId: "req-1", ...over };
}

const token = (over: Partial<{ companyId: string; email: string; senderKey: string }> = {}, secret = SECRET) => signUnsubscribeToken({ companyId: CO, email: "Ann@Lead.co.za", senderKey: "own", ...over }, secret);

describe("where the token comes from", () => {
  const t = token();

  it("reads the header the reverse proxy sets, then the query of the original address, then the body", () => {
    expect(tokenFromWebhook(delivery({ headers: { [TOKEN_HEADER]: t } }))).toBe(t);
    expect(tokenFromWebhook(delivery({ headers: { "x-original-uri": `/api/plugins/partnersinbiz.mailbox/webhooks/unsubscribe?token=${encodeURIComponent(t)}` } }))).toBe(t);
    expect(tokenFromWebhook(delivery({ headers: { "x-forwarded-uri": `/x?other=1&token=${encodeURIComponent(t)}` } }))).toBe(t);
    expect(tokenFromWebhook(delivery({ parsedBody: { token: t } }))).toBe(t);
    expect(tokenFromWebhook(delivery({ rawBody: `List-Unsubscribe=One-Click&token=${encodeURIComponent(t)}`, parsedBody: {} }))).toBe(t);
    expect(tokenFromWebhook(delivery({ headers: { [TOKEN_HEADER]: "from-header", "x-original-uri": `/x?token=other` } }))).toBe("from-header");
  });

  it("says where it found the token: only a header the proxy set proves the proxy passes the address on", () => {
    expect(tokenFromDelivery(delivery({ headers: { [TOKEN_HEADER]: t } }))).toEqual({ token: t, via: "header" });
    expect(tokenFromDelivery(delivery({ headers: { "x-original-uri": `/x?token=${encodeURIComponent(t)}` } }))).toEqual({ token: t, via: "uri" });
    expect(tokenFromDelivery(delivery({ parsedBody: { token: t } }))).toEqual({ token: t, via: "body" });
    expect(tokenFromDelivery(delivery({ rawBody: `token=${encodeURIComponent(t)}` }))).toEqual({ token: t, via: "body" });
    expect(tokenFromDelivery(delivery())).toBeNull();
  });

  it("finds nothing in what the host gives a webhook today: the address it was posted to never reaches the plugin", () => {
    // The host passes the headers and the body, not the URL: a mail client's one-click POST (form body, token in the query) carries no token here.
    expect(tokenFromWebhook(delivery({ rawBody: "List-Unsubscribe=One-Click", headers: { host: "paperclip.partnersinbiz.online", "user-agent": "Gmail", "content-type": "application/x-www-form-urlencoded" } }))).toBeNull();
    expect(tokenFromWebhook(delivery({ headers: { "x-original-uri": "/api/plugins/partnersinbiz.mailbox/webhooks/unsubscribe" } }))).toBeNull();
  });

  it("builds the address from the public base URL and the claimed company from the token", () => {
    expect(oneClickUrl("https://paperclip.example.com/", "a.b")).toBe("https://paperclip.example.com/api/plugins/partnersinbiz.mailbox/webhooks/unsubscribe?token=a.b");
    expect(claimedCompany(t)).toBe(CO);
    expect(claimedCompany("garbage")).toBeNull();
    expect(claimedCompany(".sig")).toBeNull();
  });
});

describe("a one-click unsubscribe", () => {
  it("puts the address on that sender's marketing list and announces it, once", async () => {
    const { env, store, host } = setup({ unsubscribe: { secret: SECRET } });
    expect(await handleUnsubscribeWebhook(env, delivery({ headers: { [TOKEN_HEADER]: token({ senderKey: "company:crm-ahs" }) } }))).toBe("suppressed");
    expect(store.suppressions.get(`${CO}:ann@lead.co.za:company:crm-ahs`)).toMatchObject({ scope: "marketing", reason: "unsubscribed", source: "partnersinbiz.mailbox", detail: "One-click unsubscribe link", sender_key: "company:crm-ahs" });
    const suppressed = host.emitted.filter((e) => e.name === HANDOFF_EVENTS.contactSuppressed).map((e) => e.payload);
    expect(suppressed).toEqual([expect.objectContaining({ key: "suppress:ann@lead.co.za:unsubscribed:company:crm-ahs", email: "ann@lead.co.za", scope: "marketing", senderKey: "company:crm-ahs", source: "partnersinbiz.mailbox" })]);
    const consent = host.emitted.filter((e) => e.name === HANDOFF_EVENTS.consentRecorded).map((e) => e.payload);
    expect(consent).toEqual([expect.objectContaining({ purpose: "marketing_email", granted: false, source: "unsubscribe_link", subject: { email: "ann@lead.co.za", clientKind: "company", clientRef: "crm-ahs" } })]);
    // A mail client may post twice: the second is a no-op, nothing announced again.
    host.emitted.length = 0;
    expect(await handleUnsubscribeWebhook(env, delivery({ headers: { [TOKEN_HEADER]: token({ senderKey: "company:crm-ahs" }) } }))).toBe("already");
    expect(host.emitted).toEqual([]);
    expect(store.suppressions.size).toBe(1);
  });

  it("the company's own list is `own`, and the other senders' lists are untouched", async () => {
    const { env, store } = setup({ unsubscribe: { secret: SECRET } });
    await handleUnsubscribeWebhook(env, delivery({ headers: { [TOKEN_HEADER]: token() } }));
    expect([...store.suppressions.keys()]).toEqual([`${CO}:ann@lead.co.za:own`]);
  });

  it("changes nothing and says nothing for a token that is missing, tampered, signed with another secret, for another company, or for the wrong endpoint", async () => {
    const { env, store, host } = setup({ unsubscribe: { secret: SECRET } });
    const t = token();
    const outcomes = [
      await handleUnsubscribeWebhook(env, delivery()),
      await handleUnsubscribeWebhook(env, delivery({ headers: { [TOKEN_HEADER]: `${t.slice(0, -2)}xx` } })),
      await handleUnsubscribeWebhook(env, delivery({ headers: { [TOKEN_HEADER]: token({}, "a-different-secret-0123456789") } })),
      await handleUnsubscribeWebhook(env, delivery({ headers: { [TOKEN_HEADER]: "not.a-token" } })),
      await handleUnsubscribeWebhook(env, delivery({ endpointKey: "other", headers: { [TOKEN_HEADER]: t } })),
    ];
    expect(outcomes).toEqual(["no_token", "invalid", "invalid", "invalid", "invalid"]);
    // A token for company B verified against company A's secret is refused: the secret is looked up by the claimed company.
    const b = token({ companyId: "co-2" });
    host.ctx.config.get = (async (companyId: string) => ({ ...host.config, unsubscribe: { secret: companyId === "co-2" ? "company-two-secret-0123456789" : SECRET } })) as never;
    expect(await handleUnsubscribeWebhook(env, delivery({ headers: { [TOKEN_HEADER]: b } }))).toBe("invalid");
    expect(store.suppressions.size).toBe(0);
    expect(host.emitted).toEqual([]);
  });

  it("does nothing until the company set an unsubscribe secret", async () => {
    const { env, store } = setup();
    expect(await handleUnsubscribeWebhook(env, delivery({ headers: { [TOKEN_HEADER]: token() } }))).toBe("unconfigured");
    expect(store.suppressions.size).toBe(0);
  });
});

describe("the webhook in the worker", () => {
  it("is declared with its capability, answers a delivery without a token with nothing, and a good token through the host SQL guard", async () => {
    expect(manifest.capabilities).toContain("webhooks.receive");
    expect(manifest.webhooks!.map((w) => w.endpointKey)).toEqual(["resend", "unsubscribe"]);
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20), unsubscribe: { secret: SECRET } } });
    const executed: string[] = [];
    const db = {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE);
        validateParams(sql, params);
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        executed.push(sql);
        return { rowCount: 1 };
      },
    };
    (harness.ctx as unknown as { db: typeof db }).db = db;
    await plugin.definition.setup(harness.ctx);
    const emit = vi.spyOn(harness.ctx.events, "emit");
    await plugin.definition.onWebhook!(delivery());
    expect(executed).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    await plugin.definition.onWebhook!(delivery({ headers: { [TOKEN_HEADER]: token() } }));
    expect(executed.some((sql) => sql.includes(`INSERT INTO ${NAMESPACE}.suppressions`) && sql.includes("ON CONFLICT (company_id, email, sender_key) DO NOTHING"))).toBe(true);
    expect(emit.mock.calls.map(([name]) => name)).toEqual([HANDOFF_EVENTS.contactSuppressed, HANDOFF_EVENTS.consentRecorded]);
  });
});


describe("the gate: the Mailbox makes its own https link only after it has proved the proxy rule works", () => {
  const CONFIG = { unsubscribe: { secret: SECRET } };
  const NOW = Date.parse("2026-10-03T10:00:00.000Z");

  it("posts a probe to its own public address like a mail client would, and a proxy that passes the address on opens the gate", async () => {
    const { env, store, host } = setup(CONFIG);
    const calls = fakeSelfFetch(env, { proxy: true });
    expect(await oneClickReady(env, CO)).toBe(false);
    const proof = await probeUnsubscribeProxy(env, CO);
    expect(proof).toMatchObject({ ok: true, detail: null });
    expect(await oneClickReady(env, CO)).toBe(true);
    // One POST to the public webhook address, form-encoded like Gmail's, with no header of ours that could fake the proxy.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.startsWith("https://paperclip.example.com/api/plugins/partnersinbiz.mailbox/webhooks/unsubscribe?token=")).toBe(true);
    expect(calls[0]!.init).toEqual({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    // The probe unsubscribes nobody and announces nothing.
    expect(store.suppressions.size).toBe(0);
    expect(host.emitted).toEqual([]);
  });

  it("the live box today (no proxy rule): the token never arrives, the check fails and says why, and the gate stays shut", async () => {
    const { env } = setup(CONFIG);
    fakeSelfFetch(env, { proxy: false });
    const proof = await probeUnsubscribeProxy(env, CO);
    expect(proof).toMatchObject({ ok: false, detail: expect.stringMatching(/does not pass the request address on.*README/) });
    expect(await oneClickReady(env, CO)).toBe(false);
    expect(await readProxyProof(env.ctx, CO)).toMatchObject({ ok: false });
  });

  it("a failed check closes an open gate at once", async () => {
    const { env } = setup(CONFIG);
    await openGate(env);
    expect(await oneClickReady(env, CO)).toBe(true);
    fakeSelfFetch(env, { proxy: false });
    await probeUnsubscribeProxy(env, CO);
    expect(await oneClickReady(env, CO)).toBe(false);
  });

  it("an address it cannot reach, or a host that answers an error, is a failed check with the reason, never an open gate", async () => {
    const down = setup(CONFIG);
    fakeSelfFetch(down.env, { fail: "connect ECONNREFUSED" });
    expect(await probeUnsubscribeProxy(down.env, CO)).toMatchObject({ ok: false, detail: expect.stringMatching(/could not reach its own public address \(connect ECONNREFUSED\)/) });
    const bad = setup(CONFIG);
    fakeSelfFetch(bad.env, { status: 502 });
    expect(await probeUnsubscribeProxy(bad.env, CO)).toMatchObject({ ok: false, detail: expect.stringMatching(/answered HTTP 502/) });
    expect(await oneClickReady(down.env, CO)).toBe(false);
    expect(await oneClickReady(bad.env, CO)).toBe(false);
  });

  it("nothing to check without the unsubscribe secret (16+ characters) or the public base URL: no request is made", async () => {
    for (const config of [{}, { unsubscribe: { secret: "short" } }, { ...CONFIG, publicBaseUrl: "" }]) {
      const { env } = setup(config);
      const calls = fakeSelfFetch(env, { proxy: true });
      expect(await probeUnsubscribeProxy(env, CO)).toBeNull();
      expect(calls).toEqual([]);
      expect(await oneClickReady(env, CO)).toBe(false);
    }
  });

  it("a probe token that arrives only in the body, or was signed with another secret, proves nothing", async () => {
    const { env } = setup(CONFIG);
    const probe = signUnsubscribeToken({ companyId: CO, email: PROBE_EMAIL, senderKey: `${PROBE_SENDER_PREFIX}test-1` }, SECRET);
    // Whoever posts a body can put a token in it whether or not the proxy works.
    expect(await handleUnsubscribeWebhook(env, delivery({ parsedBody: { token: probe } }))).toBe("probe_unproven");
    expect(await handleUnsubscribeWebhook(env, delivery({ rawBody: `token=${encodeURIComponent(probe)}` }))).toBe("probe_unproven");
    // A header carrying a token nobody with the secret signed.
    const forged = signUnsubscribeToken({ companyId: CO, email: PROBE_EMAIL, senderKey: `${PROBE_SENDER_PREFIX}test-2` }, "another-secret-0123456789");
    expect(await handleUnsubscribeWebhook(env, delivery({ headers: { "x-original-uri": `/x?token=${encodeURIComponent(forged)}` } }))).toBe("invalid");
    expect(await oneClickReady(env, CO)).toBe(false);
    // Through a header the proxy set, the same real probe does open it.
    expect(await handleUnsubscribeWebhook(env, delivery({ headers: { "x-original-uri": `/x?token=${encodeURIComponent(probe)}` } }))).toBe("probe_ok");
    expect(await oneClickReady(env, CO)).toBe(true);
    expect(await readProxyProof(env.ctx, CO)).toMatchObject({ ok: true, probe: "test-1" });
  });

  it("a passed check counts for six hours; never checked, failed, stale or dated in the future do not", () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(proofIsFresh(null, NOW)).toBe(false);
    expect(proofIsFresh({ ok: true, at: at(0), detail: null }, NOW)).toBe(true);
    expect(proofIsFresh({ ok: true, at: at(-PROXY_PROOF_MAX_AGE_MS), detail: null }, NOW)).toBe(true);
    expect(proofIsFresh({ ok: true, at: at(-PROXY_PROOF_MAX_AGE_MS - 1), detail: null }, NOW)).toBe(false);
    expect(proofIsFresh({ ok: false, at: at(0), detail: "x" }, NOW)).toBe(false);
    expect(proofIsFresh({ ok: true, at: at(120_000), detail: null }, NOW)).toBe(false);
    expect(proofIsFresh({ ok: true, at: "not a date", detail: null }, NOW)).toBe(false);
  });

  it("the gate closes by itself when the hourly check stops running", async () => {
    const { env } = setup(CONFIG);
    let now = NOW;
    (env as { now: () => number }).now = () => now;
    await openGate(env);
    expect(await oneClickReady(env, CO)).toBe(true);
    now += PROXY_PROOF_MAX_AGE_MS + 60_000;
    expect(await oneClickReady(env, CO)).toBe(false);
  });

  it("sweeps the companies it is given, skips those with nothing to check, and one failure does not stop the rest", async () => {
    const { env } = setup(CONFIG);
    const calls = fakeSelfFetch(env, { proxy: true });
    const real = env.ctx.config.get.bind(env.ctx.config);
    (env.ctx.config as unknown as { get: (companyId?: string) => Promise<unknown> }).get = async (companyId?: string) => {
      if (companyId === "co-broken") throw new Error("settings unreadable");
      return real(companyId);
    };
    expect(await probeCompanies(env, ["co-broken", CO])).toBe(1);
    expect(calls).toHaveLength(1);
  });
});
