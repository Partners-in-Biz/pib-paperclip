import { afterEach, describe, expect, it, vi } from "vitest";
import { HANDOFF_EVENTS, signUnsubscribeToken } from "@partnersinbiz/pib-plugin-kit";
import plugin from "../src/worker.js";
import { addressHash, addSuppression, isSuppressed, suppressedEmails } from "../src/db.js";
import { checkUnsubscribeToken, claimedCompany, linkSecret, unsubscribeLinks } from "../src/links.js";
import { suppressionPayload } from "../src/suppress.js";
import { apiUrlFrom, maskEmail, readToken, tokenEmail } from "../src/unsubscribe-page/logic.js";
import { boot, campaign, CO, enrollment, PAST, seed, seedIssue, step, UI_BASE } from "./helpers/harness.js";
import type { Store } from "./helpers/fake-db.js";

afterEach(() => vi.unstubAllGlobals());

const row = (over: Record<string, unknown>) => ({ company_id: CO, email: "ada@acme.test", reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.campaigns", contact_id: null, campaign_id: null, sender_key: "own", ...over });

describe("one do-not-email list per sender", () => {
  async function ctxWith(rows: Array<Record<string, unknown>>) {
    const s = seed();
    s.suppressions!.push(...rows);
    return (await boot({ store: s })).harness.ctx;
  }

  it("an unsubscribe from one client's list does not stop PiB's own mail or another client's", async () => {
    const ctx = await ctxWith([row({ sender_key: "company:acme" })]);
    expect(await isSuppressed(ctx, CO, "ada@acme.test", "company:acme")).toBe(true);
    expect(await isSuppressed(ctx, CO, "ada@acme.test", "own")).toBe(false);
    expect(await isSuppressed(ctx, CO, "ada@acme.test", "company:beta")).toBe(false);
    expect(await isSuppressed(ctx, CO, "ada@acme.test", "contact:ada")).toBe(false);
  });

  it("a hard bounce is about the address, so it stops every sender", async () => {
    const ctx = await ctxWith([row({ sender_key: "company:acme", scope: "all", reason: "bounce" })]);
    for (const sender of ["own", "company:acme", "company:beta"]) expect(await isSuppressed(ctx, CO, "ada@acme.test", sender), sender).toBe(true);
  });

  it("an opt-out recorded before senders existed (empty sender) still stops everyone's marketing", async () => {
    const ctx = await ctxWith([row({ sender_key: "" })]);
    for (const sender of ["own", "company:acme"]) expect(await isSuppressed(ctx, CO, "ada@acme.test", sender), sender).toBe(true);
  });

  it("finds an address erased on request by its hash, and never confuses addresses", async () => {
    const ctx = await ctxWith([row({ email: addressHash("Ada@Acme.test"), sender_key: "own" })]);
    expect(await isSuppressed(ctx, CO, "ada@acme.test", "own")).toBe(true);
    expect(await isSuppressed(ctx, CO, "bob@beta.test", "own")).toBe(false);
    expect(addressHash("Ada@Acme.test")).toBe(addressHash(" ada@acme.test "));
    expect(addressHash("ada@acme.test")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("answers for many addresses at once, case-insensitively, scoped to one company", async () => {
    const ctx = await ctxWith([row({ sender_key: "own" }), row({ email: "bob@beta.test", sender_key: "company:acme" }), row({ email: "uma@x.test", company_id: "co-other", sender_key: "own" })]);
    const blocked = await suppressedEmails(ctx, CO, ["ADA@acme.test", "bob@beta.test", "uma@x.test", ""], "own");
    expect([...blocked].sort()).toEqual(["ada@acme.test"]);
    expect((await suppressedEmails(ctx, CO, [], "own")).size).toBe(0);
  });

  it("stores one row per address and sender, and a later hard bounce widens a marketing row", async () => {
    const s = seed();
    const { harness } = await boot({ store: s });
    const input = { companyId: CO, email: "Ada@acme.test", reason: "unsubscribe" as const, scope: "marketing" as const, source: "partnersinbiz.campaigns", contactId: null, campaignId: null };
    expect(await addSuppression(harness.ctx, { ...input, senderKey: "company:acme" })).toBe(true);
    expect(await addSuppression(harness.ctx, { ...input, senderKey: "company:acme" })).toBe(false);
    expect(await addSuppression(harness.ctx, { ...input, senderKey: "own" })).toBe(true);
    expect(s.suppressions).toHaveLength(2);
    await addSuppression(harness.ctx, { ...input, reason: "bounce", scope: "all", senderKey: "company:beta" });
    expect(s.suppressions!.map((r) => r.scope)).toEqual(["all", "all", "all"]);
  });
});

describe("unsubscribing in a client's campaign", () => {
  function twoSenders(): Store {
    const s = seed();
    s.campaigns!.push(
      campaign("camp-own", { delivery: "email" }),
      campaign("camp-acme", { delivery: "email", client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing" }),
      campaign("camp-beta", { delivery: "email", client_kind: "company", client_ref: "beta", client_name: "Beta Co" }),
    );
    s.campaign_steps!.push(...["camp-own", "camp-acme", "camp-beta"].map((id) => step(id, 1, "a", "Hi", "Hello")));
    s.campaign_enrollments!.push(
      enrollment("e-own", "camp-own", "ada", { open_issue_id: "iss-own" }),
      enrollment("e-acme", "camp-acme", "ada", { open_issue_id: "iss-acme" }),
      enrollment("e-beta", "camp-beta", "ada"),
    );
    return s;
  }

  it("a reply that unsubscribes stops that client's campaigns for the person and leaves PiB's and the others running", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: { reply_kind: { type: "choice", choice: "unsubscribe", probabilities: { unsubscribe: 0.98 }, confidence: 0.98 } } }), { status: 200 })));
    const s = twoSenders();
    s.campaign_step_events!.push({ id: "sent-1", company_id: CO, campaign_id: "camp-acme", enrollment_id: "e-acme", step_position: 1, event_type: "sent", variant: "a", source_key: "sent:x", meta: { to: "ada@acme.test" }, occurred_at: new Date().toISOString() });
    const { harness, emit } = await boot({ store: s, jev: true });
    seedIssue(harness, s, { id: "iss-acme", status: "todo", assigneeAgentId: "agent-camp" });
    seedIssue(harness, s, { id: "iss-own", status: "todo", assigneeAgentId: "agent-camp" });
    await harness.emit("plugin.partnersinbiz.mailbox.mail.received" as `plugin.${string}`, {
      key: "mail:m-1", accountAddress: "hello@acme.test", messageId: "m-1", threadId: "t-1", from: { email: "ada@acme.test", name: "Ada" }, to: [], subject: "Re: Hello", snippet: "Please stop emailing me", receivedAt: new Date().toISOString(),
      attachments: [], triage: { category: "reply", urgency: null, needsReply: null, phishing: null, confidence: null }, replyTo: { plugin: "partnersinbiz.campaigns", kind: "campaign_step", id: "e-acme" },
    }, { companyId: CO });
    expect(s.suppressions).toEqual([expect.objectContaining({ email: "ada@acme.test", sender_key: "company:acme", scope: "marketing", reason: "unsubscribe" })]);
    expect(s.campaign_enrollments!.map((r) => [r.id, r.status])).toEqual([["e-own", "running"], ["e-acme", "stopped"], ["e-beta", "running"]]);
    expect(await harness.ctx.issues.get("iss-acme", CO)).toMatchObject({ status: "cancelled" });
    expect(await harness.ctx.issues.get("iss-own", CO)).toMatchObject({ status: "todo" });
    const announced = emit.mock.calls.filter(([name]) => name === HANDOFF_EVENTS.contactSuppressed).map((c) => c[2]);
    expect(announced).toEqual([expect.objectContaining({ key: "suppress:ada@acme.test:unsubscribed:company:acme", senderKey: "company:acme", clientKind: "company", clientRef: "acme", scope: "marketing" })]);
  });

  it("a person's own hard bounce (every sender) stops all of their campaigns", async () => {
    const s = twoSenders();
    const { harness } = await boot({ store: s });
    await harness.emit("plugin.partnersinbiz.mailbox.contact.suppressed" as `plugin.${string}`, { email: "ada@acme.test", reason: "bounced", scope: "all", source: "partnersinbiz.mailbox" }, { companyId: CO });
    expect(s.campaign_enrollments!.every((r) => r.status === "stopped")).toBe(true);
  });

  it("a CRM or Mailbox unsubscribe that names its sender stops only that sender; one that does not name it stops everyone", async () => {
    const s = twoSenders();
    const { harness } = await boot({ store: s });
    await harness.emit("plugin.partnersinbiz.crm.contact.suppressed" as `plugin.${string}`, { email: "ada@acme.test", reason: "unsubscribed", scope: "marketing", source: "partnersinbiz.crm", senderKey: "company:beta" }, { companyId: CO });
    expect(s.suppressions).toEqual([expect.objectContaining({ sender_key: "company:beta" })]);
    expect(s.campaign_enrollments!.map((r) => [r.id, r.status])).toEqual([["e-own", "running"], ["e-acme", "running"], ["e-beta", "stopped"]]);
    await harness.emit("plugin.partnersinbiz.crm.contact.suppressed" as `plugin.${string}`, { email: "ada@acme.test", reason: "unsubscribed", scope: "marketing", source: "partnersinbiz.crm" }, { companyId: CO });
    expect(s.suppressions!.map((r) => r.sender_key)).toEqual(["company:beta", ""]);
    expect(s.campaign_enrollments!.every((r) => r.status === "stopped")).toBe(true);
  });

  it("suppress-address takes the sender it was recorded for, or every sender without one", async () => {
    const s = twoSenders();
    const { harness, emit } = await boot({ store: s });
    const agent = { companyId: CO, agentId: "agent-camp" };
    const one = await harness.executeTool<{ data: Record<string, unknown> }>("suppress-address", { email: "Ada@acme.test", client: "company:acme" }, agent);
    expect(one.data).toMatchObject({ sender: "company:acme", added: true });
    expect(s.campaign_enrollments!.map((r) => r.status)).toEqual(["running", "stopped", "running"]);
    const own = await harness.executeTool<{ data: Record<string, unknown> }>("suppress-address", { email: "ada@acme.test", client: "own" }, agent);
    expect(own.data).toMatchObject({ sender: "own" });
    expect(s.campaign_enrollments!.map((r) => r.status)).toEqual(["stopped", "stopped", "running"]);
    const every = await harness.executeTool<{ data: Record<string, unknown> }>("suppress-address", { email: "ada@acme.test" }, agent);
    expect(every.data).toMatchObject({ sender: "every sender" });
    expect(s.campaign_enrollments!.every((r) => r.status === "stopped")).toBe(true);
    const keys = emit.mock.calls.filter(([name]) => name === HANDOFF_EVENTS.contactSuppressed).map((c) => (c[2] as { key: string }).key);
    expect(keys).toEqual(["suppress:ada@acme.test:unsubscribed:company:acme", "suppress:ada@acme.test:unsubscribed", "suppress:ada@acme.test:unsubscribed"]);
    expect((await harness.executeTool<{ error?: string }>("suppress-address", { email: "ada@acme.test", client: "acme" }, agent)).error).toMatch(/client must be/);
  });

  it("the hourly re-announcement keeps each row's sender", async () => {
    const s = seed();
    s.suppressions!.push(row({ sender_key: "company:acme", created_at: new Date().toISOString() }), row({ email: "bob@beta.test", sender_key: "", created_at: new Date().toISOString() }));
    const { harness, emit } = await boot({ store: s });
    await harness.runJob("setup-status");
    const payloads = emit.mock.calls.filter(([name]) => name === HANDOFF_EVENTS.contactSuppressed).map((c) => c[2] as Record<string, unknown>);
    expect(payloads.map((p) => [p.email, p.senderKey ?? null])).toEqual([["ada@acme.test", "company:acme"], ["bob@beta.test", null]]);
    expect(suppressionPayload({ email: "x@y.co", reason: "unsubscribe", scope: "marketing" })).not.toHaveProperty("senderKey");
  });
});

describe("the unsubscribe webhook", () => {
  const post = (input: { headers?: Record<string, string>; parsedBody?: unknown }) =>
    plugin.definition.onWebhook!({ endpointKey: "unsubscribe", headers: input.headers ?? {}, rawBody: "", parsedBody: input.parsedBody, requestId: "r1" });

  async function bootWithToken(senderKey = "company:acme", email = "ada@acme.test") {
    const s = seed();
    s.campaigns!.push(campaign("camp-own", { delivery: "email" }), campaign("camp-acme", { delivery: "email", client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing" }));
    s.campaign_steps!.push(step("camp-own", 1, "a", "Hi", "Hello"), step("camp-acme", 1, "a", "Hi", "Hello"));
    s.campaign_enrollments!.push(enrollment("e-own", "camp-own", "ada"), enrollment("e-acme", "camp-acme", "ada", { open_issue_id: "iss-acme" }));
    const booted = await boot({ store: s });
    seedIssue(booted.harness, s, { id: "iss-acme", status: "todo", assigneeAgentId: "agent-camp" });
    const links = await unsubscribeLinks(booted.harness.ctx, CO, { email, senderKey });
    const token = decodeURIComponent(new URL(links.landing!).searchParams.get("t")!);
    return { ...booted, s, token, links };
  }

  it("builds the landing page address on the public URL and the plugin's UI path, and makes the secret once", async () => {
    const { harness, links } = await bootWithToken();
    expect(links.landing!.startsWith(`https://paperclip.test${UI_BASE}unsubscribe.html?t=`)).toBe(true);
    expect(links.oneClick).toBeNull();
    const secret = await linkSecret(harness.ctx, CO, { create: false });
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await linkSecret(harness.ctx, CO, { create: true })).toBe(secret);
  });

  it("records the opt-out for that sender from a JSON body, stops only that sender's campaigns, cancels their step issue and tells the CRM and Mailbox", async () => {
    const { s, token, emit, harness } = await bootWithToken();
    await post({ parsedBody: { token } });
    expect(s.suppressions).toEqual([expect.objectContaining({ email: "ada@acme.test", sender_key: "company:acme", reason: "unsubscribe", scope: "marketing", source: "partnersinbiz.campaigns" })]);
    expect(s.campaign_enrollments!.map((r) => [r.id, r.status])).toEqual([["e-own", "running"], ["e-acme", "stopped"]]);
    expect(await harness.ctx.issues.get("iss-acme", CO)).toMatchObject({ status: "cancelled" });
    const announced = emit.mock.calls.filter(([name]) => name === HANDOFF_EVENTS.contactSuppressed).map((c) => c[2]);
    expect(announced).toEqual([expect.objectContaining({ email: "ada@acme.test", senderKey: "company:acme", clientKind: "company", clientRef: "acme", reason: "unsubscribed" })]);
    // The address is never written to the logs.
    expect(JSON.stringify(harness.logs)).not.toContain("ada@acme.test");
  });

  it("takes the token from the x-unsubscribe-token header, which is how a one-click POST arrives", async () => {
    const { s, token } = await bootWithToken("own");
    await post({ headers: { "x-unsubscribe-token": token }, parsedBody: undefined });
    expect(s.suppressions).toEqual([expect.objectContaining({ sender_key: "own" })]);
    expect(s.campaign_enrollments!.map((r) => [r.id, r.status])).toEqual([["e-own", "stopped"], ["e-acme", "running"]]);
  });

  it("is harmless to repeat", async () => {
    const { s, token } = await bootWithToken();
    await post({ parsedBody: { token } });
    await post({ parsedBody: { token } });
    expect(s.suppressions).toHaveLength(1);
  });

  it("refuses a token that is missing, garbled, altered, signed by another secret or for another company, with one message and no change", async () => {
    const { s, token, harness } = await bootWithToken();
    const [body, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ c: CO, e: "bob@beta.test", s: "own" })).toString("base64url");
    const bad = [
      undefined,
      {},
      { token: "" },
      { token: "garbage" },
      { token: `${body}x.${signature}` },
      { token: `${forged}.${signature}` },
      { token: `${body}.` },
      { token: signUnsubscribeToken({ companyId: CO, email: "bob@beta.test", senderKey: "own" }, "another-secret-with-enough-length") },
      { token: signUnsubscribeToken({ companyId: "co-other", email: "ada@acme.test", senderKey: "company:acme" }, "another-secret-with-enough-length") },
      { token: 42 },
    ];
    for (const parsedBody of bad) await expect(post({ parsedBody }), JSON.stringify(parsedBody)).rejects.toThrow("This unsubscribe link is not valid.");
    expect(s.suppressions).toHaveLength(0);
    expect(s.campaign_enrollments!.every((r) => r.status === "running")).toBe(true);
    // A token for a company that has no secret yet never starts one.
    expect(await linkSecret(harness.ctx, "co-other", { create: false })).toBeNull();
    expect(await checkUnsubscribeToken(harness.ctx, signUnsubscribeToken({ companyId: "co-other", email: "a@b.co", senderKey: "own" }, "x".repeat(32)))).toBeNull();
    expect(claimedCompany(token)).toBe(CO);
    expect(claimedCompany("x".repeat(3000) + ".y")).toBeNull();
  });

  it("refuses an endpoint it does not have", async () => {
    await bootWithToken();
    await expect(plugin.definition.onWebhook!({ endpointKey: "nope", headers: {}, rawBody: "", requestId: "r" })).rejects.toThrow("Unknown endpoint.");
  });
});

describe("the landing page", () => {
  it("finds the webhook from the page's own address, with or without a path prefix", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(apiUrlFrom(`/_plugins/${uuid}/ui/unsubscribe.html`)).toBe(`/api/plugins/${uuid}/webhooks/unsubscribe`);
    expect(apiUrlFrom(`/paperclip/_plugins/${uuid}/ui/unsubscribe.html`)).toBe(`/paperclip/api/plugins/${uuid}/webhooks/unsubscribe`);
    expect(apiUrlFrom("/unsubscribe.html")).toBeNull();
    expect(apiUrlFrom("/_plugins/partnersinbiz.campaigns/ui/unsubscribe.html")).toBeNull();
  });

  it("reads the token from ?t= and shows the address masked", () => {
    const token = signUnsubscribeToken({ companyId: CO, email: "ada@acme.test", senderKey: "own" }, "s".repeat(32));
    expect(readToken(`?t=${encodeURIComponent(token)}`)).toBe(token);
    expect(readToken("?t=nodots")).toBeNull();
    expect(readToken("")).toBeNull();
    expect(readToken(`?t=${"a.".repeat(2000)}`)).toBeNull();
    expect(tokenEmail(token)).toBe("a***@acme.test");
    expect(tokenEmail("garbage.sig")).toBeNull();
    expect(maskEmail("ada@acme.test")).toBe("a***@acme.test");
  });
});
