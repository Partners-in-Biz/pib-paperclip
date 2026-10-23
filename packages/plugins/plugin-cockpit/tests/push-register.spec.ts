import { describe, it, expect, vi } from "vitest";
import {
  PUSH_SW_FILE,
  buildPushSwUrl,
  resolvePushSwUrl,
  registerPushServiceWorker,
  urlBase64ToUint8Array,
  subscriptionToPayload,
  describePushEnvironment,
  waitForActivated,
} from "../src/ui/push-register.js";

describe("push-register", () => {
  it("PUSH_SW_FILE is correct", () => {
    expect(PUSH_SW_FILE).toBe("push-sw.js");
  });

  it("buildPushSwUrl builds the correct URL from installation ID base", () => {
    const result = buildPushSwUrl("/_plugins/c2a2e51a-a02d-4625-8521-0fcce839ea53/ui/");
    expect(result).toBe("/_plugins/c2a2e51a-a02d-4625-8521-0fcce839ea53/ui/push-sw.js");
  });

  it("buildPushSwUrl throws for plugin key path (not installation ID)", () => {
    expect(() => buildPushSwUrl("/_plugins/partnersinbiz.cockpit/ui/")).toThrow(
      /Invalid plugin UI base/
    );
  });

  it("buildPushSwUrl throws for empty string", () => {
    expect(() => buildPushSwUrl("")).toThrow(/Invalid plugin UI base/);
  });

  it("resolvePushSwUrl extracts UUID from a module URL", async () => {
    const moduleUrl = "https://paperclip.partnersinbiz.online/_plugins/c2a2e51a-a02d-4625-8521-0fcce839ea53/ui/index.js";
    const result = await resolvePushSwUrl(moduleUrl);
    expect(result).toBe("/_plugins/c2a2e51a-a02d-4625-8521-0fcce839ea53/ui/push-sw.js");
    expect(result).not.toContain("partnersinbiz.cockpit");
  });

  it("registerPushServiceWorker registers with updateViaCache none and calls update", async () => {
    const swUrl = "/_plugins/c2a2e51a-a02d-4625-8521-0fcce839ea53/ui/push-sw.js";
    const mockReg = { update: vi.fn().mockResolvedValue(undefined) };
    const mockSw = { register: vi.fn().mockResolvedValue(mockReg) };
    const result = await registerPushServiceWorker(mockSw as any, swUrl);
    expect(mockSw.register).toHaveBeenCalledWith(swUrl, { updateViaCache: "none" });
    expect(mockReg.update).toHaveBeenCalled();
    expect(result).toBe(mockReg);
  });

  it("registerPushServiceWorker swallows update() errors", async () => {
    const swUrl = "/_plugins/c2a2e51a-a02d-4625-8521-0fcce839ea53/ui/push-sw.js";
    const mockReg = { update: vi.fn().mockRejectedValue(new Error("fail")) };
    const mockSw = { register: vi.fn().mockResolvedValue(mockReg) };
    const result = await registerPushServiceWorker(mockSw as any, swUrl);
    expect(result).toBe(mockReg);
  });

  it("urlBase64ToUint8Array decodes correctly", () => {
    expect(urlBase64ToUint8Array("SGVsbG8")).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
  });

  it("subscriptionToPayload encodes payload", () => {
    const sub = {
      endpoint: "https://example.com",
      getKey: (n: "p256dh" | "auth") => new ArrayBuffer(n === "p256dh" ? 32 : 16),
    };
    const result = subscriptionToPayload(sub, "ua");
    expect(result.endpoint).toBe("https://example.com");
    expect(result.p256dh).toBeTruthy();
    expect(result.auth).toBeTruthy();
    expect(result.label).toBe("ua");
  });

  it("subscriptionToPayload throws on missing keys", () => {
    const sub = { endpoint: "https://example.com", getKey: () => null };
    expect(() => subscriptionToPayload(sub, "label")).toThrow(/Missing push subscription keys/);
  });

  it("describePushEnvironment detects frame correctly", () => {
    const obj = {};
    const result1 = describePushEnvironment({ self: obj, top: obj, hasPushManager: true, hasServiceWorker: true, hasNotification: true });
    expect(result1.frame).toBe("host page");
    const result2 = describePushEnvironment({ self: {}, top: {}, hasPushManager: true, hasServiceWorker: true, hasNotification: true });
    expect(result2.frame).toBe("iframe");
  });

  it("waitForActivated resolves if active", async () => {
    const reg = { active: { state: "activated" } };
    expect(await waitForActivated(reg as any)).toBe(reg);
  });

  it("waitForActivated waits for activation", async () => {
    const listeners: Record<string, Function[]> = {};
    const worker = {
      state: "installing",
      addEventListener: vi.fn((e: string, fn: Function) => {
        if (!listeners[e]) listeners[e] = [];
        listeners[e].push(fn);
      }),
    };
    const reg = { installing: worker };
    const promise = waitForActivated(reg as any, 5000);
    setTimeout(() => {
      worker.state = "activated";
      listeners["statechange"]?.forEach((fn) => fn());
    }, 10);
    expect(await promise).toBe(reg);
  });

  it("waitForActivated rejects on redundant", async () => {
    const listeners: Record<string, Function[]> = {};
    const worker = {
      state: "installing",
      addEventListener: vi.fn((e: string, fn: Function) => {
        if (!listeners[e]) listeners[e] = [];
        listeners[e].push(fn);
      }),
    };
    const reg = { installing: worker };
    const promise = waitForActivated(reg as any, 5000);
    setTimeout(() => {
      worker.state = "redundant";
      listeners["statechange"]?.forEach((fn) => fn());
    }, 10);
    await expect(promise).rejects.toThrow(/redundant/);
  });

  it("waitForActivated rejects on timeout", async () => {
    const worker = { state: "installing", addEventListener: vi.fn() };
    await expect(waitForActivated({ installing: worker } as any, 10)).rejects.toThrow(/timeout/);
  });
});
