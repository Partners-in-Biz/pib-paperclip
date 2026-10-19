/**
 * Tests for pure push registration helpers.
 * Node environment (no browser APIs needed directly).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PUSH_SW_URL,
  registerPushServiceWorker,
  urlBase64ToUint8Array,
  subscriptionToPayload,
  describePushEnvironment,
  waitForActivated,
} from "../src/ui/push-register.js";

describe("push-register", () => {
  it("PUSH_SW_URL equals the plugin key URL without UUID", () => {
    expect(PUSH_SW_URL).toBe("/_plugins/partnersinbiz.cockpit/ui/push-sw.js");
  });

  it("registerPushServiceWorker calls register with updateViaCache none", async () => {
    const mockReg = { update: vi.fn().mockResolvedValue(undefined) };
    const mockSw = { register: vi.fn().mockResolvedValue(mockReg) };
    const result = await registerPushServiceWorker(mockSw as any);
    expect(mockSw.register).toHaveBeenCalledWith("/_plugins/partnersinbiz.cockpit/ui/push-sw.js", { updateViaCache: "none" });
    expect(result).toBe(mockReg);
  });

  it("registerPushServiceWorker calls update() on the registration", async () => {
    const mockReg = { update: vi.fn().mockResolvedValue(undefined) };
    const mockSw = { register: vi.fn().mockResolvedValue(mockReg) };
    await registerPushServiceWorker(mockSw as any);
    expect(mockReg.update).toHaveBeenCalled();
  });

  it("registerPushServiceWorker returns registration if update() fails", async () => {
    const mockReg = { update: vi.fn().mockRejectedValue(new Error("update failed")) };
    const mockSw = { register: vi.fn().mockResolvedValue(mockReg) };
    const result = await registerPushServiceWorker(mockSw as any);
    expect(result).toBe(mockReg);
  });

  it("registerPushServiceWorker calls register and update on successive loads", async () => {
    const mockReg1 = { update: vi.fn().mockResolvedValue(undefined) };
    const mockReg2 = { update: vi.fn().mockResolvedValue(undefined) };
    const mockSw = {
      register: vi.fn().mockResolvedValueOnce(mockReg1).mockResolvedValueOnce(mockReg2),
    };
    await registerPushServiceWorker(mockSw as any);
    await registerPushServiceWorker(mockSw as any);
    expect(mockSw.register).toHaveBeenCalledTimes(2);
    expect(mockReg1.update).toHaveBeenCalled();
    expect(mockReg2.update).toHaveBeenCalled();
  });

  it("urlBase64ToUint8Array decodes base64url without padding", () => {
    const b64url = "SGVsbG8";
    const result = urlBase64ToUint8Array(b64url);
    const expected = new Uint8Array([72, 101, 108, 108, 111]);
    expect(result).toEqual(expected);
  });

  it("subscriptionToPayload encodes keys base64url without padding", () => {
    const p256dh = new ArrayBuffer(32);
    const auth = new ArrayBuffer(16);
    const sub = {
      endpoint: "https://push.example.com/endpoint/abc",
      getKey: (name: "p256dh" | "auth") =>
        name === "p256dh" ? p256dh : name === "auth" ? auth : null,
    };
    const result = subscriptionToPayload(sub, "user-agent-string");
    expect(result.endpoint).toBe("https://push.example.com/endpoint/abc");
    expect(result.p256dh).toBeTruthy();
    expect(result.auth).toBeTruthy();
    expect(result.label).toBe("user-agent-string");
  });

  it("subscriptionToPayload throws if p256dh key is missing", () => {
    const sub = {
      endpoint: "https://example.com",
      getKey: (name: "p256dh" | "auth") =>
        name === "auth" ? new ArrayBuffer(16) : null,
    };
    expect(() => subscriptionToPayload(sub, "label")).toThrow(/Missing push subscription keys/);
  });

  it("describePushEnvironment returns 'host page' when self === top", () => {
    const sharedObj = {};
    const env = { self: sharedObj, top: sharedObj, hasPushManager: true, hasServiceWorker: true, hasNotification: true, permission: "granted" };
    const result = describePushEnvironment(env);
    expect(result.frame).toBe("host page");
    expect(result.lines.join("\n")).toMatch(/ServiceWorker.*available/);
    expect(result.lines.join("\n")).toMatch(/PushManager.*available/);
  });

  it("describePushEnvironment returns 'iframe' when self !== top", () => {
    const env = { self: {}, top: {}, hasPushManager: true, hasServiceWorker: true, hasNotification: true };
    const result = describePushEnvironment(env);
    expect(result.frame).toBe("iframe");
  });

  it("waitForActivated resolves immediately if registration.active exists", async () => {
    const reg = { active: { state: "activated" } };
    const result = await waitForActivated(reg as any);
    expect(result).toBe(reg);
  });

  it("waitForActivated waits for installing worker to activate via statechange", async () => {
    const listeners: Record<string, Function[]> = {};
    const worker = {
      state: "installing",
      addEventListener: vi.fn((event: string, listener: Function) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(listener);
      }),
    };
    const reg = { installing: worker };

    const promise = waitForActivated(reg as any, 5000);
    // Simulate state change to activated
    setTimeout(() => {
      worker.state = "activated";
      listeners["statechange"]?.forEach((fn) => fn());
    }, 10);

    const result = await promise;
    expect(result).toBe(reg);
  });

  it("waitForActivated rejects if worker becomes redundant", async () => {
    const listeners: Record<string, Function[]> = {};
    const worker = {
      state: "installing",
      addEventListener: vi.fn((event: string, listener: Function) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(listener);
      }),
    };
    const reg = { installing: worker };

    const promise = waitForActivated(reg as any, 5000);
    // Simulate state change to redundant
    setTimeout(() => {
      worker.state = "redundant";
      listeners["statechange"]?.forEach((fn) => fn());
    }, 10);

    await expect(promise).rejects.toThrow(/redundant/);
  });

  it("waitForActivated rejects on timeout", async () => {
    const worker = {
      state: "installing",
      addEventListener: vi.fn(),
    };
    const reg = { installing: worker };
    await expect(waitForActivated(reg as any, 10)).rejects.toThrow(/timeout/);
  });
});
