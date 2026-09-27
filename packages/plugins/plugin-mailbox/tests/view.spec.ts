import { describe, expect, it } from "vitest";
import { canSendFrom, connectReadiness, draftRecipients, missingTechnical, moduleName, recentTime, sendBlock, sentBy } from "../src/ui/view.js";
import { draftView, isoTime } from "../src/worker.js";

const READY = { saved: true, publicBaseUrl: "https://paperclip.example.com", encryptionKey: true, googleClientSecret: true };

describe("connecting Gmail from the page", () => {
  it("names the missing technical settings and disables Connect until they are saved", () => {
    expect(missingTechnical({ saved: true, publicBaseUrl: null, encryptionKey: false, googleClientSecret: false })).toEqual(["Public base URL", "Token encryption key", "Google client secret"]);
    expect(missingTechnical(READY)).toEqual([]);
    expect(connectReadiness(READY)).toEqual({ ready: true, reason: null });
    expect(connectReadiness({ ...READY, googleClientSecret: false })).toEqual({ ready: false, reason: "An admin first does the one-time technical setup." });
    expect(connectReadiness({ ...READY, saved: false }).ready).toBe(false);
    expect(connectReadiness(null).ready).toBe(false);
  });
});

describe("sending a draft from the page", () => {
  const gmail = { id: "acc-g", address: "peet@pib.test", status: "connected", has_credential: true };
  const manual = { id: "acc-m", address: "ada@northwind.test", status: "manual", has_credential: false };
  const draft = { status: "draft", account_id: "acc-g", to_addrs: [{ email: "ada@x.test" }], cc_addrs: [], bcc_addrs: [] };

  it("can send from a connected Gmail account (or one that needs reconnecting, as the worker does)", () => {
    expect(canSendFrom(gmail)).toBe(true);
    expect(canSendFrom({ ...gmail, status: "needs_reconnect" })).toBe(true);
    expect(canSendFrom(manual)).toBe(false);
    expect(canSendFrom(null)).toBe(false);
  });

  it("says why Send is off: Gmail not connected, no recipient, or both", () => {
    expect(sendBlock(draft, [gmail])).toBeNull();
    expect(sendBlock({ ...draft, to_addrs: [] }, [gmail])).toBe("Add a recipient first.");
    expect(sendBlock({ ...draft, to_addrs: [], cc_addrs: [{ email: "c@x.test" }] }, [gmail])).toBeNull();
    expect(sendBlock({ ...draft, account_id: "acc-m" }, [gmail, manual])).toBe("Connect Gmail for ada@northwind.test first.");
    // The review's "Hello Northwind": no recipient, on a mailbox without Gmail.
    expect(sendBlock({ ...draft, account_id: "acc-m", to_addrs: [] }, [gmail, manual])).toBe("Connect Gmail for ada@northwind.test first, and add a recipient.");
    expect(sendBlock({ ...draft, account_id: "gone" }, [gmail])).toBe("Connect Gmail first.");
    expect(sendBlock({ ...draft, status: "queued" }, [])).toBeNull();
    expect(draftRecipients({ ...draft, bcc_addrs: [{ email: "b@x.test" }] })).toEqual(["ada@x.test", "b@x.test"]);
  });
});

describe("page wording", () => {
  it("names modules, not plugin ids", () => {
    expect(moduleName("partnersinbiz.billing")).toBe("Billing");
    expect(moduleName("acme.time_sheets")).toBe("Time sheets");
    expect(sentBy({ sourcePlugin: "partnersinbiz.billing", context: { plugin: "partnersinbiz.billing", kind: "invoice" } })).toBe("Billing · invoice");
    expect(sentBy({ sourcePlugin: "partnersinbiz.campaigns", context: null })).toBe("Campaigns · mail");
    expect(sentBy({ sourcePlugin: "x", context: { plugin: "partnersinbiz.campaigns", kind: "campaign_step" } })).toBe("Campaigns · campaign step");
  });

  it("shows the last day relatively; older times are left to the shared date format", () => {
    const now = new Date("2026-09-27T12:00:00Z");
    expect(recentTime("2026-09-27T11:59:40Z", now)).toBe("just now");
    expect(recentTime("2026-09-27T11:15:00Z", now)).toBe("45 min ago");
    expect(recentTime("2026-09-27T07:00:00Z", now)).toBe("5 h ago");
    expect(recentTime("2026-09-20T07:00:00Z", now)).toBeNull();
    expect(recentTime(null, now)).toBeNull();
    expect(recentTime("not a date", now)).toBeNull();
  });
});

describe("draft rows for the page", () => {
  it("carry the body, every recipient, who drafted it and an ISO time", () => {
    const view = draftView({
      id: "d-1", account_id: "acc-m", subject: "Hello Northwind", body: "Hi Ada", status: "draft", direction: "outbound", is_read: false,
      to_addrs: [], cc_addrs: null, bcc_addrs: [{ email: "b@x.test" }], draft: { html: "<p>Hi</p>", replyToMessageId: "m-1", by: { kind: "agent", id: "agent-am" } },
      send_error: null, created_at: "2026-09-25 17:09:53.906307+02",
    });
    expect(view).toMatchObject({
      body: "Hi Ada", to_addrs: [], cc_addrs: [], bcc_addrs: [{ email: "b@x.test" }], created_at: "2026-09-25T15:09:53.906Z",
      drafted_by: { kind: "agent", id: "agent-am" }, is_reply: true, has_html: true,
    });
    expect(draftView({ id: "d-2", account_id: "a", subject: "s", body: null, status: "draft", direction: "outbound", is_read: false, to_addrs: null, cc_addrs: null, bcc_addrs: null, draft: null, send_error: null, created_at: null }))
      .toMatchObject({ body: "", to_addrs: [], drafted_by: null, created_at: null, is_reply: false });
    expect(isoTime(new Date("2026-09-01T00:00:00Z"))).toBe("2026-09-01T00:00:00.000Z");
  });
});
