import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MEMBER_PREFIX, recipientKind, resolveRecipient } from "../src/recipient.js";
import { setMessagingProvider } from "../src/messaging.js";
import { boot, campaign, CO, contact, enrollment, PAST, PUBLIC_URL, seed, step } from "./helpers/harness.js";
import { MockProvider } from "./helpers/mock-provider.js";

/** Loads a CRM source file without making it part of this package's typecheck. */
async function crmModule<T>(file: string): Promise<T> {
  return (await import(/* @vite-ignore */ fileURLToPath(new URL(`../../plugin-crm/src/${file}`, import.meta.url)))) as T;
}

afterEach(() => setMessagingProvider(null));

describe("resolveRecipient", () => {
  it("returns the CRM copy of a contact: name, emails, phones, account ids and kind", async () => {
    const store = seed();
    store.crm_contacts = [contact("ada", "Ada Lovelace", ["ada@acme.test"], { phones: ["082 123 4567"], account_ids: ["acme"] })];
    const { harness } = await boot({ store });
    expect(await resolveRecipient(harness.ctx, CO, "ada")).toEqual({
      id: "ada",
      kind: "contact",
      name: "Ada Lovelace",
      emails: ["ada@acme.test"],
      phones: ["082 123 4567"],
      account_ids: ["acme"],
    });
  });

  it("returns nothing for an unknown contact, a deleted one, or one in another company", async () => {
    const store = seed();
    store.crm_contacts = [
      contact("gone", "Gone", ["gone@x.test"], { deleted: true }),
      contact("other", "Other Co", ["o@x.test"], { company_id: "co-2" }),
    ];
    const { harness } = await boot({ store });
    expect(await resolveRecipient(harness.ctx, CO, "nobody")).toBeNull();
    expect(await resolveRecipient(harness.ctx, CO, "gone")).toBeNull();
    expect(await resolveRecipient(harness.ctx, CO, "other")).toBeNull();
  });

  it("resolves a member: id to nothing yet, even if a CRM row somehow carried that id", async () => {
    const store = seed();
    store.crm_contacts = [contact("member:m1", "Not A Contact", ["m1@x.test"], { phones: ["082 123 4567"] })];
    const { harness } = await boot({ store });
    expect(recipientKind("member:m1")).toBe("member");
    expect(recipientKind("ada")).toBe("contact");
    expect(await resolveRecipient(harness.ctx, CO, "member:m1")).toBeNull();
  });

  it("no CRM contact id starts with member: (the CRM makes UUIDs, and canary-... for its canary)", async () => {
    const domain = await crmModule<{ createContact: (input: { companyId: string; name: string }) => { id: string } }>("domain.ts");
    const canary = await crmModule<{ canaryContactId: (companyId: string) => string }>("canary-flag.ts");
    const ids = Array.from({ length: 50 }, () => domain.createContact({ companyId: CO, name: "Someone" }).id);
    ids.push(canary.canaryContactId(CO), canary.canaryContactId("member:co"));
    for (const id of ids) {
      expect(id.startsWith(MEMBER_PREFIX)).toBe(false);
      expect(recipientKind(id)).toBe("contact");
    }
  });
});

describe("a member: enrollment on the send paths (not resolved yet)", () => {
  it("email: nothing is sent; the step goes to a person as for a contact with no address", async () => {
    const store = seed();
    store.crm_contacts = [contact("member:m1", "Not A Contact", ["m1@x.test"])];
    store.campaigns!.push(campaign("camp-1", { delivery: "auto" }));
    store.campaign_steps!.push(step("camp-1", 1, "a", "Hello", "Hi {{first_name}}"));
    store.campaign_enrollments!.push(enrollment("e1", "camp-1", "member:m1", { next_due_at: PAST }));
    const { harness } = await boot({ store });
    await harness.runJob("open-due-steps");
    expect((store.outbox ?? []).filter((row) => String(row.key ?? "").startsWith("campaigns:mail:"))).toHaveLength(0);
    const issues = await harness.ctx.issues.list({ companyId: CO, originKind: "plugin:partnersinbiz.campaigns" });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.description).toContain("no email address in the CRM");
  });

  it("SMS: nothing is sent; the step is skipped as for a contact with no mobile number", async () => {
    const store = seed();
    store.crm_contacts = [contact("member:m1", "Not A Contact", [], { phones: ["082 123 4567"] })];
    store.campaigns!.push(campaign("camp-sms", { delivery: "auto" }));
    store.campaign_steps!.push({ ...step("camp-sms", 1, "a", "", "Hi {{first_name}}."), channel: "sms" });
    store.campaign_enrollments!.push(enrollment("e1", "camp-sms", "member:m1", { next_due_at: PAST }));
    store.channel_consents = [{ company_id: CO, channel: "sms", address: "+27821234567", sender_key: "own", granted: true, basis: "consent", source: "form", evidence: "form", contact_id: null, recorded_at: PAST, recorded_by: null }];
    store.channel_suppressions = [];
    store.channel_messages = [];
    const mock = new MockProvider();
    const open = { weekdays: "00:00-24:00", saturday: "00:00-24:00", sunday: "00:00-24:00" };
    const { harness } = await boot({ store, config: { timezone: "Africa/Johannesburg", publicBaseUrl: PUBLIC_URL, messaging: { smsFrom: "+14155550100", ...open } } });
    setMessagingProvider(() => mock);
    await harness.runJob("open-due-steps");
    expect(mock.sent).toHaveLength(0);
    expect(store.channel_messages).toHaveLength(0);
    expect(store.campaign_step_events).toEqual([expect.objectContaining({ event_type: "skipped", meta: expect.objectContaining({ why: "no mobile number on the contact" }) })]);
  });
});
