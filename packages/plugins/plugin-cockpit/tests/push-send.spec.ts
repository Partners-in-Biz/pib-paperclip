import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateVapidKeyPair } from "../src/push/vapid.js";
import type { PushSubscription } from "../src/push/store.js";
import { decryptPayload, generateP256Keys } from "./push-test-helpers.js";

const store = vi.hoisted(() => ({
  appendPushLog: vi.fn(),
  createKeyIfAbsent: vi.fn(),
  deleteSubscription: vi.fn(),
  getKey: vi.fn(),
  markSubscriptionOk: vi.fn(),
  setSubscriptionState: vi.fn(),
  takeRateSlot: vi.fn(),
}));
vi.mock("../src/push/store.js", () => store);

import { sendPush, type PushPayload } from "../src/push/send.js";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-one";
const ENDPOINT_2 = "https://updates.push.services.mozilla.com/wpush/v2/device-two";
const NOW = new Date("2026-10-20T10:30:00Z");

const payload = (over: Partial<PushPayload> = {}): PushPayload => ({
  title: "Needs you",
  body: "Approve the invoice",
  url: "/PAR/issues/PAR-1",
  tag: "PAR-1",
  class: "needs_you",
  ...over,
});

describe("sendPush", () => {
  const vapid = generateVapidKeyPair();
  let subscriber: ReturnType<typeof generateP256Keys>;
  let sub: PushSubscription;
  let config: Record<string, unknown> | undefined;
  let ctx: any;
  let post: ReturnType<typeof vi.fn>;
  let used: Map<string, number>;

  const makeSub = (over: Partial<PushSubscription> = {}): PushSubscription => ({
    id: "sub-1",
    companyId: "co-1",
    userId: "user-1",
    endpoint: ENDPOINT,
    p256dh: subscriber.p256dh,
    auth: subscriber.auth,
    deviceLabel: "Phone",
    createdAt: NOW.toISOString(),
    lastOkAt: null,
    lastError: null,
    state: "ok",
    ...over,
  } as PushSubscription);

  const send = (subs: PushSubscription[], p = payload(), cls = p.class) =>
    sendPush(ctx, "co-1", subs, p, { class: cls, deps: { postPush: post as any, now: () => NOW } });

  beforeEach(() => {
    vi.clearAllMocks();
    subscriber = generateP256Keys();
    sub = makeSub();
    config = { pushEnabled: true };
    ctx = { config: { get: vi.fn(async () => config) } };
    post = vi.fn(async () => ({ status: 201, headers: {}, body: "", bodyTruncated: false }));
    used = new Map();
    store.getKey.mockResolvedValue({ ...vapid, created: false });
    store.takeRateSlot.mockImplementation(async (_c: unknown, key: string, _w: Date, cap: number) => {
      const n = used.get(key) ?? 0;
      if (n >= cap) return false;
      used.set(key, n + 1);
      return true;
    });
    store.deleteSubscription.mockResolvedValue(true);
    store.setSubscriptionState.mockResolvedValue(true);
    store.markSubscriptionOk.mockResolvedValue(true);
  });

  it("sends encrypted body with VAPID, TTL and urgency headers (needs_you)", async () => {
    const res = await send([sub]);
    expect(res.devices).toEqual([{ endpoint: ENDPOINT, label: "Phone", outcome: "sent", status: 201 }]);
    const [url, headers, body] = post.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(headers.Authorization.endsWith(`k=${vapid.publicKey}`)).toBe(true);
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.TTL).toBe("14400");
    expect(headers.Urgency).toBe("normal");
    expect(headers.Topic).toBe("PAR-1");
    const plain = JSON.parse(decryptPayload(body, subscriber.privateKey, subscriber.auth));
    expect(plain).toEqual({ title: "Needs you", body: "Approve the invoice", url: "/PAR/issues/PAR-1", tag: "PAR-1", class: "needs_you" });
  });

  it("uses 24 h TTL and high urgency for critical", async () => {
    await send([sub], payload({ class: "critical" }));
    const headers = post.mock.calls[0][1];
    expect(headers.TTL).toBe("86400");
    expect(headers.Urgency).toBe("high");
  });

  it("marks the device ok and logs a sent row on 201", async () => {
    await send([sub]);
    expect(store.markSubscriptionOk).toHaveBeenCalledWith(ctx, ENDPOINT);
    expect(store.appendPushLog).toHaveBeenCalledWith(ctx, expect.objectContaining({ status: "sent", class: "needs_you" }));
  });

  it.each([404, 410])("deletes the row on %i", async (status) => {
    post.mockResolvedValue({ status, headers: {}, body: "", bodyTruncated: false });
    const res = await send([sub]);
    expect(res.devices[0].outcome).toBe("deleted");
    expect(store.deleteSubscription).toHaveBeenCalledWith(ctx, "co-1", "user-1", ENDPOINT);
  });

  it.each([401, 403])("flags needs_resubscribe and keeps the row on %i", async (status) => {
    post.mockResolvedValue({ status, headers: {}, body: "", bodyTruncated: false });
    const res = await send([sub]);
    expect(res.devices[0].outcome).toBe("needs_resubscribe");
    expect(store.setSubscriptionState).toHaveBeenCalledWith(ctx, ENDPOINT, "needs_resubscribe", `http_${status}`);
    expect(store.deleteSubscription).not.toHaveBeenCalled();
  });

  it("records last_error on 500 and keeps going with the next device", async () => {
    const second = makeSub({ id: "sub-2", endpoint: ENDPOINT_2 });
    post.mockResolvedValueOnce({ status: 500, headers: {}, body: "", bodyTruncated: false });
    const res = await send([sub, second]);
    expect(res.devices.map((d) => d.outcome)).toEqual(["error", "sent"]);
    expect(store.setSubscriptionState).toHaveBeenCalledWith(ctx, ENDPOINT, "ok", "http_500");
    expect(store.deleteSubscription).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("refuses a non-allowlisted stored endpoint and flags it", async () => {
    const bad = makeSub({ endpoint: "https://evil.example.com/push" });
    const res = await send([bad]);
    expect(res.devices[0].outcome).toBe("refused");
    expect(store.setSubscriptionState).toHaveBeenCalledWith(ctx, bad.endpoint, "needs_resubscribe", "endpoint_not_allowed");
    expect(post).not.toHaveBeenCalled();
    expect(store.takeRateSlot).not.toHaveBeenCalled();
  });

  it("skips muted devices without a slot or a network call", async () => {
    const res = await send([makeSub({ state: "muted" })]);
    expect(res.devices[0].outcome).toBe("skipped_muted");
    expect(post).not.toHaveBeenCalled();
    expect(store.takeRateSlot).not.toHaveBeenCalled();
  });

  it.each([false, undefined])("sends nothing when pushEnabled=%s", async (value) => {
    config = value === undefined ? {} : { pushEnabled: value };
    const res = await send([sub]);
    expect(res).toEqual({ disabled: true, capped: false, devices: [] });
    expect(post).not.toHaveBeenCalled();
    expect(store.takeRateSlot).not.toHaveBeenCalled();
  });

  it("logs capped and sends nothing when the non-critical budget is spent", async () => {
    used.set("non_critical", 30);
    const res = await send([sub]);
    expect(res.capped).toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(store.appendPushLog).toHaveBeenCalledWith(ctx, expect.objectContaining({ status: "capped" }));
  });

  it("lets critical through after non-critical sends used their 30", async () => {
    used.set("non_critical", 30);
    used.set("all", 30);
    const res = await send([sub], payload({ class: "critical" }));
    expect(res.capped).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("caps critical too once the global 60 is used", async () => {
    used.set("all", 60);
    const res = await send([sub], payload({ class: "critical" }));
    expect(res.capped).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("throws before any network call when the payload is 2 KB or more", async () => {
    await expect(send([sub], payload({ body: "x".repeat(2100) }))).rejects.toThrow(/under 2048 bytes/);
    expect(post).not.toHaveBeenCalled();
  });

  it("creates the VAPID key when none is stored", async () => {
    store.getKey.mockResolvedValue(null);
    store.createKeyIfAbsent.mockImplementation(async (_c: unknown, k: { publicKey: string; privateKey: string }) => ({ ...k, created: true }));
    await send([sub]);
    expect(store.createKeyIfAbsent).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
