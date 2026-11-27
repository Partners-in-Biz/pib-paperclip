/**
 * The Campaigns page load (PAR-9258): "Do not email" and "Do not contact" count only the page's own sender. Driven through the
 * real `campaigns.load` action so dropping the sender key at the call site fails here.
 */
import { describe, expect, it } from "vitest";
import { boot, CO, seed } from "./helpers/harness.js";

const MEMBER = { type: "user" as const, userId: "user-member" };
const sup = (email: string, sender_key: string | null, scope = "marketing") => ({ company_id: CO, email, scope, sender_key });
const chan = (channel: string, address: string, sender_key: string | null, scope = "marketing") => ({ company_id: CO, channel, address, scope, sender_key });

describe("campaigns.load counts for the page's sender", () => {
  it("own and a client page show different, matching counts", async () => {
    const store = seed();
    store.suppressions = [sup("a@x.test", "own"), sup("b@x.test", "own"), sup("c@x.test", "company:acme"), sup("legacy@x.test", ""), sup("bounce@x.test", "", "all"), sup("hard@x.test", "company:acme", "all")];
    store.channel_suppressions = [chan("sms", "+1", "own"), chan("sms", "+2", "own"), chan("whatsapp", "+3", "company:acme"), chan("sms", "+4", "company:acme"), chan("whatsapp", "+5", "company:acme", "all")];
    const { harness } = await boot({ store });
    const load = (params: Record<string, unknown>) => harness.performAction<Record<string, any>>("campaigns.load", params, { companyId: CO, actor: MEMBER as never });
    const own = await load({});
    const client = await load({ client: "company:acme" });
    // own: a, b, legacy, bounce, hard (scope all stops every sender); acme: c, legacy, bounce, hard.
    expect(own.suppressed).toBe(5);
    expect(client.suppressed).toBe(4);
    expect(own.doNotContact).toEqual({ sms: 2, whatsapp: 1 });
    expect(client.doNotContact).toEqual({ sms: 1, whatsapp: 2 });
  });
});
