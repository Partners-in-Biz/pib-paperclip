import { afterEach, describe, expect, it, vi } from "vitest";
import { knownCompanyIds } from "@partnersinbiz/pib-plugin-kit";
import { messagingHealth, readinessHealth } from "../src/cockpit.js";
import { setMessagingProvider } from "../src/messaging.js";
import plugin from "../src/worker.js";
import { setupStatus } from "../src/setup-status.js";
import { boot, campaign, CO, enrollment, PAST, PUBLIC_URL, seed, step } from "./helpers/harness.js";
import { MockProvider } from "./helpers/mock-provider.js";
import type { Store } from "./helpers/fake-db.js";

afterEach(() => setMessagingProvider(null));

const item = (status: Awaited<ReturnType<typeof setupStatus>>, key: string) => status.items.find((row) => row.key === key)!;

function clientCampaign(extra: Record<string, unknown> = {}) {
  return campaign("camp-acme", { delivery: "email", client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing", ...extra });
}

describe("Setup items that make client email and texts work", () => {
  it("a fresh company: everything is optional and nothing is required beyond the settings", async () => {
    const { harness } = await boot({ config: { timezone: "Africa/Johannesburg" } });
    const status = await setupStatus(harness.ctx, CO);
    expect(status.items.filter((row) => row.required).map((row) => row.key)).toEqual(["settings"]);
    expect(item(status, "public_url")).toMatchObject({ status: "optional", required: false });
    expect(item(status, "one_click")).toMatchObject({ status: "optional", required: false });
    expect(item(status, "client_senders")).toMatchObject({ status: "done" });
    for (const key of ["twilio", "sms_sender", "whatsapp_sender"]) expect(item(status, key), key).toMatchObject({ status: "optional", required: false });
  });

  it("the Twilio items give the exact steps with deep links, never ask for a secret in chat, and say what the agent does next", async () => {
    const { harness } = await boot({ config: { timezone: "Africa/Johannesburg" } });
    const status = await setupStatus(harness.ctx, CO);
    const twilio = item(status, "twilio");
    expect(twilio.href).toBe("https://console.twilio.com/");
    expect(twilio.steps!.join("\n")).toMatch(/Create a Twilio account at https:\/\/www\.twilio\.com\/try-twilio/);
    expect(twilio.steps!.join("\n")).toMatch(/Account SID.*Auth Token/);
    expect(twilio.steps!.join("\n")).toMatch(/create a Paperclip secret for the Auth Token/);
    expect(twilio.steps!.join("\n")).toMatch(/Never paste the token into an issue or chat/);
    expect(twilio.agentNext).toMatch(/SMS and WhatsApp steps can be approved and sent/);
    expect(item(status, "sms_sender").href).toContain("console.twilio.com");
    const whatsapp = item(status, "whatsapp_sender");
    expect(whatsapp.href).toContain("whatsapp-senders");
    expect(whatsapp.steps!.join("\n")).toMatch(/content-template-builder/);
    expect(whatsapp.steps!.join("\n")).toMatch(/templateRef/);
    for (const key of ["public_url", "one_click", "client_senders", "twilio", "sms_sender", "whatsapp_sender"]) expect(item(status, key).agentNext, key).toBeTruthy();
  });

  it("an active email campaign without a public address makes that item missing; with the address and the page opened it is done", async () => {
    const s = seed();
    s.campaigns!.push(campaign("camp-own", { delivery: "email" }));
    const { harness } = await boot({ store: s, config: { timezone: "Africa/Johannesburg" } });
    expect(item(await setupStatus(harness.ctx, CO), "public_url")).toMatchObject({ status: "missing", required: false });
    const withUrl = await boot({ store: seed(), config: { timezone: "Africa/Johannesburg", publicBaseUrl: PUBLIC_URL, oneClickUnsubscribeUrl: "https://paperclip.test/u" } });
    const status = await setupStatus(withUrl.harness.ctx, CO);
    expect(item(status, "public_url").status).toBe("done");
    expect(item(status, "one_click").status).toBe("done");
  });

  it("names the clients whose automatic campaigns have no sender, and is done once each has one", async () => {
    const s = seed();
    s.campaigns!.push(clientCampaign(), clientCampaign({ id: "camp-issue", delivery: "issue", client_ref: "beta", client_name: "Beta Co" }));
    const { harness } = await boot({ store: s });
    const missing = item(await setupStatus(harness.ctx, CO), "client_senders");
    expect(missing).toMatchObject({ status: "missing", required: false, href: "/mailbox?tab=mailboxes&connect=gmail" });
    // Only the client with automatic delivery is named: an agent sending by hand needs no sender.
    expect(missing.detail).toContain("Acme Plumbing");
    expect(missing.detail).not.toContain("Beta Co");
    s.sender_identities = [{ company_id: CO, sender_key: "company:acme", from_address: "hello@acme.test", from_name: null, reply_to: null, sms_from: null, whatsapp_from: null }];
    expect(item(await setupStatus(harness.ctx, CO), "client_senders").status).toBe("done");
  });

  it("texts in use without a provider make the provider and sender items missing; a configured provider makes them done", async () => {
    const s = seed();
    s.campaigns!.push(campaign("camp-sms", { delivery: "auto" }));
    s.campaign_steps!.push({ ...step("camp-sms", 1, "a", "", "Hi"), channel: "sms" });
    const off = await boot({ store: s, config: { timezone: "Africa/Johannesburg" } });
    const missing = await setupStatus(off.harness.ctx, CO);
    expect(item(missing, "twilio").status).toBe("missing");
    expect(item(missing, "sms_sender").status).toBe("missing");
    expect(item(missing, "whatsapp_sender").status).toBe("optional");
    const on = await boot({ store: s, config: { timezone: "Africa/Johannesburg", messaging: { smsFrom: "+14155550100", whatsappFrom: "+14155238886" } } });
    setMessagingProvider(() => new MockProvider());
    const done = await setupStatus(on.harness.ctx, CO);
    expect(["twilio", "sms_sender", "whatsapp_sender"].map((key) => item(done, key).status)).toEqual(["done", "done", "done"]);
  });
});

describe("a Messaging Service without a number", () => {
  it("sends but cannot read replies: the SMS item says so, and a number alone does not", async () => {
    const s = seed();
    const service = await boot({ store: s, config: { timezone: "Africa/Johannesburg", messaging: { accountSid: "AC0123456789abcdef", messagingServiceSid: "MG0123456789abcdef0123456789abcdef" } } });
    setMessagingProvider(() => new MockProvider());
    const only = item(await setupStatus(service.harness.ctx, CO), "sms_sender");
    expect(only.status).toBe("done");
    expect(only.detail).toMatch(/replies \(including STOP\) are read on a number/);
    const number = await boot({ store: s, config: { timezone: "Africa/Johannesburg", messaging: { smsFrom: "+14155550100", messagingServiceSid: "MG0123456789abcdef0123456789abcdef" } } });
    setMessagingProvider(() => new MockProvider());
    expect(item(await setupStatus(number.harness.ctx, CO), "sms_sender").detail).toBeUndefined();
  });
});

describe("what the Cockpit shows", () => {
  const withActive = (store: Store) => boot({ store, config: { timezone: "Africa/Johannesburg", publicBaseUrl: PUBLIC_URL } });

  it("an active automatic client campaign with no sender is red, naming the client and the first problem", async () => {
    const s = seed();
    s.campaigns!.push(clientCampaign({ status: "active" }));
    s.campaign_steps!.push(step("camp-acme", 1, "a", "Hi", "Hello"));
    const { harness } = await withActive(s);
    const [health] = await readinessHealth(harness.ctx, CO);
    expect(health).toMatchObject({ key: "campaigns:cannot-send", status: "bad", href: "/setup" });
    expect(health!.detail).toContain("[Acme Plumbing] camp-acme: No sender is set up for company:acme");
    s.sender_identities = [{ company_id: CO, sender_key: "company:acme", from_address: "hello@acme.test", from_name: "Acme", reply_to: null, sms_from: null, whatsapp_from: null }];
    expect(await readinessHealth(harness.ctx, CO)).toEqual([]);
  });

  it("warns when email is going out with no way to build an unsubscribe link", async () => {
    const s = seed();
    s.campaigns!.push(campaign("camp-own", { status: "active", delivery: "email" }));
    s.campaign_steps!.push(step("camp-own", 1, "a", "Hi", "Hello"));
    const { harness } = await boot({ store: s, config: { timezone: "Africa/Johannesburg" } });
    expect(await readinessHealth(harness.ctx, CO)).toEqual([expect.objectContaining({ key: "campaigns:unsubscribe", status: "warn" })]);
  });

  it("says nothing for campaigns that open issues or are not active", async () => {
    const s = seed();
    s.campaigns!.push(clientCampaign({ status: "active", delivery: "issue" }), clientCampaign({ id: "camp-draft", status: "draft" }));
    const { harness } = await withActive(s);
    expect(await readinessHealth(harness.ctx, CO)).toEqual([]);
  });

  it("reports messages the provider refused, ones with an unknown result, and failures", async () => {
    const s = seed();
    const row = (key: string, status: string, over: Record<string, unknown> = {}) => ({ key, company_id: CO, campaign_id: "c", enrollment_id: "e", step_position: 1, channel: "sms", to_address: "+27821234567", sender_key: "own", body: "x", status, attempts: 1, error_code: null, error: null, updated_at: new Date().toISOString(), ...over });
    s.channel_messages = [row("k1", "pending", { error_code: "20003" }), row("k2", "unknown"), row("k3", "failed"), row("k4", "sent"), row("k5", "failed", { updated_at: "2026-01-01T00:00:00Z" })];
    const { harness } = await withActive(s);
    const out = await messagingHealth(harness.ctx, CO);
    expect(out.map((h) => [h.key, h.status])).toEqual([["campaigns:messaging", "bad"], ["campaigns:messaging-unknown", "bad"], ["campaigns:messaging-failed", "warn"]]);
    expect(out[0]!.detail).toContain("code 20003");
    expect(out[1]!.detail).toMatch(/never sends those again by itself/);
    expect(out[2]!.detail).toContain("1 SMS or WhatsApp message failed");
  });
});

describe("companies and skills", () => {
  it("a new company gets its skills, its Campaigns project and a place in the plugin's memory", async () => {
    const { harness } = await boot();
    const reset = vi.spyOn(harness.ctx.skills.managed, "reset");
    const reconcile = vi.spyOn(harness.ctx.projects.managed, "reconcile");
    await harness.emit("company.created", {}, { companyId: "co-new" });
    expect(reset).toHaveBeenCalledWith("campaigns", "co-new");
    expect(reconcile).toHaveBeenCalledWith("campaigns", "co-new");
    expect(await knownCompanyIds(harness.ctx)).toContain("co-new");
  });

  it("the hourly job brings the skills of every company it knows up to date, and a failing company does not stop the job", async () => {
    const { harness } = await boot();
    await harness.emit("company.created", {}, { companyId: "co-two" });
    const reset = vi.spyOn(harness.ctx.skills.managed, "reset");
    await harness.runJob("setup-status");
    // co-1 was never synced (nobody touched it): the sweep reaches it. co-two already has the current version.
    expect(reset.mock.calls).toEqual([["campaigns", "co-1"]]);
    // A company that fails to sync is reported, and the job still finishes.
    reset.mockClear();
    reset.mockRejectedValue(new Error("company context is required"));
    await harness.performAction("campaigns.sync-skills", {}, { companyId: "co-two" }).catch(() => undefined);
    await expect(harness.runJob("setup-status")).resolves.toBeUndefined();
  });

  it("answers a webhook with a plain error until the plugin is ready, never a crash", async () => {
    // The module-level context is set by setup(); the endpoint list is the manifest's.
    await boot();
    await expect(plugin.definition.onWebhook!({ endpointKey: "unsubscribe", headers: {}, rawBody: "", requestId: "r" })).rejects.toThrow("This unsubscribe link is not valid.");
  });
});

describe("an HTML body is for emails", () => {
  it("is refused on an SMS step", async () => {
    const s = seed();
    s.campaigns!.push(campaign("camp-sms", { status: "draft", delivery: "auto" }));
    s.campaign_steps!.push({ ...step("camp-sms", 1, "a", "", "Hi"), channel: "sms" });
    const { harness } = await boot({ store: s });
    const out = await harness.executeTool<{ error?: string }>("set-step-html", { campaignId: "camp-sms", position: 1, html: "<p>x</p>" }, { companyId: CO, agentId: "agent-camp" });
    expect(out.error).toMatch(/Only an email step has an HTML body/);
  });

  it("a text step needs the campaign's delivery to be auto, and a campaign with one cannot go back to another delivery", async () => {
    const s = seed();
    s.campaigns!.push(campaign("camp-1", { status: "draft", delivery: "email" }));
    const { harness } = await boot({ store: s });
    const agent = { companyId: CO, agentId: "agent-camp" };
    const refused = await harness.executeTool<{ error?: string }>("add-campaign-step", { campaignId: "camp-1", channel: "sms", body: "Hi" }, agent);
    expect(refused.error).toMatch(/needs the campaign's delivery set to auto/);
    await harness.executeTool("update-campaign", { campaignId: "camp-1", delivery: "auto" }, agent);
    const added = await harness.executeTool<{ data?: { step: { channel: string } }; error?: string }>("add-campaign-step", { campaignId: "camp-1", channel: "sms", body: "Hi" }, agent);
    expect(added.data?.step.channel).toBe("sms");
    const back = await harness.executeTool<{ error?: string }>("update-campaign", { campaignId: "camp-1", delivery: "email" }, agent);
    expect(back.error).toMatch(/has a SMS step, so its delivery must be auto/);
    // The checks on a text step.
    expect((await harness.executeTool<{ error?: string }>("add-campaign-step", { campaignId: "camp-1", channel: "sms" }, agent)).error).toMatch(/needs body text/);
    expect((await harness.executeTool<{ error?: string }>("add-campaign-step", { campaignId: "camp-1", channel: "email", body: "x", subject: "s", templateRef: "HX0123456789abcdef0123456789abcdef" }, agent)).error).toMatch(/for WhatsApp steps only/);
    expect((await harness.executeTool<{ error?: string }>("add-campaign-step", { campaignId: "camp-1", channel: "whatsapp", body: "x", templateRef: "nope" }, agent)).error).toMatch(/Content template SID/);
    expect((await harness.executeTool<{ error?: string }>("add-campaign-step", { campaignId: "camp-1", channel: "fax", body: "x" }, agent)).error).toMatch(/email, sms or whatsapp/);
    expect((await harness.executeTool<{ error?: string }>("add-campaign-step", { campaignId: "camp-1", body: "x" }, agent)).error).toMatch(/subject is required/);
    // A B version goes out on its A version's channel.
    const b = await harness.executeTool<{ data?: { step: { channel: string; templateRef: string | null } } }>("create-ab-variant", { campaignId: "camp-1", position: 1, body: "Hey" }, agent);
    expect(b.data?.step).toMatchObject({ channel: "sms", templateRef: null });
  });
});

describe("a due step is not lost to a missing piece", () => {
  it("keeps an enrollment due when the contact has no usable address for its channel, rather than failing the job", async () => {
    const s = seed();
    s.campaigns!.push(campaign("camp-own", { delivery: "email" }));
    s.campaign_steps!.push(step("camp-own", 1, "a", "Hi", "Hello"));
    s.campaign_enrollments!.push(enrollment("e1", "camp-own", "carl", { next_due_at: PAST }));
    const { harness } = await boot({ store: s });
    await expect(harness.runJob("open-due-steps")).resolves.toBeUndefined();
    // Carl has no email: the usual step issue, as before.
    expect((await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" })).map((i) => i.description)).toEqual([expect.stringContaining("no email address")]);
  });
});
