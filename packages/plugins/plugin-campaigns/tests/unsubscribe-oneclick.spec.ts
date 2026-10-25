/**
 * The one-click round trip (RFC 8058) without a front door, a provider or any keys: a step is sent, the address the mail
 * carries is taken apart the way the front-door rule does (token from `?t=` into `X-Unsubscribe-Token`), posted to the
 * `unsubscribe` webhook, and the next step to that person is skipped.
 *
 * The Campaigns payload carries `unsubscribeUrl`; the Mailbox turns it into the `List-Unsubscribe` and
 * `List-Unsubscribe-Post` headers (`plugin-mailbox/src/esp/send.ts`), so the headers themselves are pinned there.
 */
import { describe, expect, it } from "vitest";
import plugin from "../src/worker.js";
import { boot, campaign, CO, enrollment, PAST, PUBLIC_URL, seed, step } from "./helpers/harness.js";

const ONE_CLICK = "https://unsub.paperclip.test/u";
const config = { timezone: "Africa/Johannesburg", publicBaseUrl: PUBLIC_URL, oneClickUnsubscribeUrl: ONE_CLICK };

async function sentStep() {
  const s = seed();
  s.campaigns!.push(campaign("camp-a"), campaign("camp-b"));
  s.campaign_steps!.push(step("camp-a", 1, "a", "Hi {{first_name}}", "Hello"), step("camp-a", 2, "a", "Following up", "Any thoughts?", 3), step("camp-b", 1, "a", "Other", "Other body"));
  s.campaign_enrollments!.push(enrollment("e-a", "camp-a", "ada", { next_due_at: PAST }), enrollment("e-b", "camp-b", "ada"));
  const booted = await boot({ store: s, config });
  await booted.harness.runJob("open-due-steps");
  const mail = s.outbox!.find((row) => row.key === "campaigns:step:e-a:1")!;
  const url = new URL((mail.payload as { unsubscribeUrl: string }).unsubscribeUrl);
  // What the front-door rule does: the token moves from the query into the header and the body is the one-click form.
  const token = url.searchParams.get("t")!;
  const post = (value: string | undefined = token) =>
    plugin.definition.onWebhook!({ endpointKey: "unsubscribe", headers: value ? { "x-unsubscribe-token": value } : {}, rawBody: "List-Unsubscribe=One-Click", parsedBody: undefined, requestId: "r1" });
  return { ...booted, s, mail, url, token, post };
}

describe("one-click unsubscribe round trip", () => {
  it("the send request carries an https address with a signed token for the one-click header", async () => {
    const { mail, url, emit } = await sentStep();
    expect(emit).toHaveBeenCalledWith("mail.send.requested", CO, expect.objectContaining({ key: mail.key, marketing: true }));
    expect(url.protocol).toBe("https:");
    expect(`${url.origin}${url.pathname}`).toBe(ONE_CLICK);
    expect(url.searchParams.get("t")).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  it("posting the token returns without error and writes one suppression", async () => {
    const { s, post } = await sentStep();
    await expect(post()).resolves.toBeUndefined();
    expect(s.suppressions).toEqual([expect.objectContaining({ email: "ada@acme.test", sender_key: "own", reason: "unsubscribe", scope: "marketing" })]);
  });

  it("a second post is harmless", async () => {
    const { s, post } = await sentStep();
    await post();
    await expect(post()).resolves.toBeUndefined();
    expect(s.suppressions).toHaveLength(1);
  });

  it("a tampered token returns normally (PAR-4200) and changes nothing", async () => {
    const { s, token, post } = await sentStep();
    const [body, signature] = token.split(".");
    for (const bad of [`${body}x.${signature}`, `${body}.${signature}x`, `${body}.`, "garbage", ""]) await expect(post(bad), bad).resolves.toBeUndefined();
    expect(s.suppressions).toHaveLength(0);
    expect(s.campaign_enrollments!.find((r) => r.id === "e-b")!.status).toBe("running");
  });

  it("the next step to that person is skipped", async () => {
    const { s, harness, post } = await sentStep();
    await post();
    const sent = s.outbox!.length;
    // Even a campaign still marked running (the opt-out arrived after it was due) sends nothing to the address.
    Object.assign(s.campaign_enrollments!.find((r) => r.id === "e-b")!, { status: "running", next_due_at: PAST });
    await harness.runJob("open-due-steps");
    expect(s.outbox).toHaveLength(sent);
    expect(s.campaign_enrollments!.find((r) => r.id === "e-b")).toMatchObject({ status: "stopped", sending_key: null });
  });
});
