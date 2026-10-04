/**
 * `mail.domain.health` (0.7.0): the one health event the Mailbox really announces, per sending domain, for a Gmail mailbox's domain and a
 * provider (send-only) account's alike. Campaigns kept only `sender.health`, which the Mailbox never sends, so every sender's health read as
 * "unknown" and a held domain (bounce or complaint rate over the limit) was never a reason to refuse a launch. Now:
 * - a domain only the email provider sends from, reported bad, blocks the approval (the Mailbox would refuse the send anyway);
 * - a domain with a Gmail mailbox on it, reported bad, is a warning to the approver (the Mailbox still sends from it, as before);
 * - the newest report wins; a person lifting a hold announces a healthy domain again and the block goes.
 */
import { describe, expect, it } from "vitest";
import { MAIL_EVENTS, pluginEvent, PIB_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import { DOMAIN_HEALTH_EVENT, rememberDomainHealth, senderHealthFor } from "../src/preflight.js";
import { boot, campaign, CO, seed, step } from "./helpers/harness.js";
import type { Store } from "./helpers/fake-db.js";

const AGENT = { companyId: CO, agentId: "agent-camp" };
const FROM = "hello@updates.acme.test";
const DOMAIN = "updates.acme.test";

function clientStore(): Store {
  const s = seed();
  s.campaigns!.push(campaign("camp-acme", { status: "draft", delivery: "email", client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing", audience_mode: "client_contacts", owner_user_id: "user-peet" }));
  s.campaign_steps!.push(step("camp-acme", 1, "a", "Hello {{first_name}}", "Your boiler service is due."));
  s.sender_identities = [{ company_id: CO, sender_key: "company:acme", from_address: FROM, from_name: "Acme Plumbing", reply_to: "bookings@acme.test", sms_from: null, whatsapp_from: null }];
  return s;
}

/** The event the Mailbox announces for a domain. */
function health(over: Record<string, unknown> = {}) {
  return {
    key: `domain:${DOMAIN}:2026-10-04T08:00:00.000Z`, domain: DOMAIN, status: "healthy", healthy: true, sendReady: true, problems: [], checkedAt: "2026-10-04T08:00:00.000Z", mailboxes: [FROM], provider: "resend",
    ...over,
  };
}

const HELD = { code: "esp_bounce_rate", severity: "bad", message: `${DOMAIN}: 3 of 40 recipients hard bounced in the last 7 days (7.5%; the limit is 2%), so marketing mail from it is held back.` };

async function announce(harness: Awaited<ReturnType<typeof boot>>["harness"], payload: Record<string, unknown>) {
  await harness.emit(pluginEvent(PIB_PLUGINS.mailbox, DOMAIN_HEALTH_EVENT), payload, { companyId: CO });
}

const preflight = async (harness: Awaited<ReturnType<typeof boot>>["harness"]) =>
  (await harness.executeTool<{ data: { ok: boolean; errors: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }> } }>("preflight-campaign", { campaignId: "camp-acme", links: false }, AGENT)).data;

describe("the event is the Mailbox's own", () => {
  it("is named like the kit's mail events and sent by the Mailbox (a name that drifted would be listened to by nobody)", () => {
    expect(DOMAIN_HEALTH_EVENT).toBe("mail.domain.health");
    expect(pluginEvent(PIB_PLUGINS.mailbox, DOMAIN_HEALTH_EVENT)).toBe("plugin.partnersinbiz.mailbox.mail.domain.health");
    expect(Object.values(MAIL_EVENTS)).not.toContain(DOMAIN_HEALTH_EVENT);
  });
});

describe("a domain only the email provider sends from", () => {
  it("reported held (bad) blocks the approval and says why; lifting the hold (healthy again) clears it", async () => {
    const { harness } = await boot({ store: clientStore() });
    await announce(harness, health({ status: "bad", healthy: false, problems: [HELD] }));
    const blocked = await preflight(harness);
    expect(blocked.ok).toBe(false);
    expect(blocked.errors).toEqual([expect.objectContaining({ code: "domain-bad", message: expect.stringContaining("3 of 40 recipients hard bounced") })]);
    const refused = await harness.executeTool<{ error?: string }>("request-campaign-approval", { campaignId: "camp-acme" }, AGENT);
    expect(refused.error).toMatch(/hard bounced/);
    // A person lifted the hold: the Mailbox judges the domain again at once and announces it.
    await announce(harness, health({ key: "domain:later", checkedAt: "2026-10-04T09:00:00.000Z" }));
    const clear = await preflight(harness);
    expect(clear.ok).toBe(true);
    expect(clear.warnings.map((w) => w.code)).not.toContain("domain-unknown");
    expect(clear.warnings.map((w) => w.code)).not.toContain("domain-bad");
  });

  it("a healthy domain that is not send-ready yet (the first month of DMARC) is a warning, not a block", async () => {
    const { harness } = await boot({ store: clientStore() });
    await announce(harness, health({ sendReady: false }));
    const result = await preflight(harness);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "domain-warn", message: expect.stringContaining("first month of DMARC") })]));
  });
});

describe("a domain with a Gmail mailbox on it", () => {
  it("reported bad is a warning to the approver and blocks nothing: the Mailbox still sends from it, as before this event was read", async () => {
    const { harness } = await boot({ store: clientStore() });
    await announce(harness, health({ status: "bad", healthy: false, provider: null, problems: [{ code: "spf_missing", severity: "bad", message: `No SPF record for ${DOMAIN}.` }] }));
    const result = await preflight(harness);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "domain-warn", message: expect.stringContaining("No SPF record") })]));
  });
});

describe("what is kept", () => {
  it("the newest report wins even when an older one arrives late (events are at-most-once and re-sent hourly)", async () => {
    const { harness } = await boot({ store: clientStore() });
    await announce(harness, health({ status: "bad", healthy: false, problems: [HELD], checkedAt: "2026-10-04T10:00:00.000Z" }));
    await announce(harness, health({ key: "domain:older", checkedAt: "2026-10-04T08:00:00.000Z" }));
    expect((await preflight(harness)).errors.map((e) => e.code)).toEqual(["domain-bad"]);
    expect(await senderHealthFor(harness.ctx, CO, FROM)).toMatchObject({ status: "bad", checkedAt: "2026-10-04T10:00:00.000Z" });
  });

  it("is read for the domain of the address a campaign sends from, per company, and a sender.health report for that address still wins", async () => {
    const { harness } = await boot({ store: clientStore() });
    await announce(harness, health({ status: "bad", healthy: false, problems: [HELD] }));
    expect(await senderHealthFor(harness.ctx, CO, "someone@UPDATES.acme.test")).toMatchObject({ status: "bad" });
    expect(await senderHealthFor(harness.ctx, "co-2", FROM)).toBeNull();
    expect(await senderHealthFor(harness.ctx, CO, "someone@other.test")).toBeNull();
    expect(await senderHealthFor(harness.ctx, CO, null)).toBeNull();
    await harness.emit("plugin.partnersinbiz.mailbox.sender.health" as `plugin.${string}`, { accountAddress: FROM, status: "ok", checkedAt: "2026-10-04T11:00:00.000Z" }, { companyId: CO });
    expect(await senderHealthFor(harness.ctx, CO, FROM)).toMatchObject({ status: "ok" });
  });

  it("ignores what it cannot read, and a domain the Mailbox could not judge stays unknown (a warning, not a pass)", async () => {
    const { harness } = await boot({ store: clientStore() });
    for (const junk of [{}, { domain: "localhost", checkedAt: "2026-10-04T08:00:00Z", status: "bad" }, { domain: DOMAIN, status: "bad" }, { domain: DOMAIN, checkedAt: "never", status: "bad" }, { domain: DOMAIN, checkedAt: "2026-10-04T08:00:00Z", status: "great" }]) {
      expect(await rememberDomainHealth(harness.ctx, CO, junk), JSON.stringify(junk)).toBe(false);
    }
    expect(await rememberDomainHealth(harness.ctx, CO, null)).toBe(false);
    await announce(harness, health({ status: "unknown", healthy: false }));
    const result = await preflight(harness);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toContain("domain-unknown");
  });

  it("a problem marked bad makes the domain bad even when the status field says healthy (the problems are what the Mailbox judged)", async () => {
    const { harness } = await boot({ store: clientStore() });
    await announce(harness, health({ status: "healthy", healthy: true, problems: [HELD] }));
    expect((await preflight(harness)).errors.map((e) => e.code)).toEqual(["domain-bad"]);
  });
});
