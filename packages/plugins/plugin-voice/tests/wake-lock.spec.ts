// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWakeLock as realStart, type WakeGuard, type WakeLockOptions } from "../src/ui/wake-lock.js";

function fakeContext(state: string = "running") {
  const listeners = new Map<string, () => void>();
  const ctx = {
    state,
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    fire: (next: string) => {
      ctx.state = next;
      listeners.get("statechange")?.();
    },
  };
  return ctx;
}

function sentinel() {
  let onRelease: (() => void) | null = null;
  return {
    release: vi.fn(async () => undefined),
    addEventListener: (_t: string, fn: () => void) => {
      onRelease = fn;
    },
    drop: () => onRelease?.(),
  };
}

// Guards listen on document, so each test's guards are released afterwards.
const guards: WakeGuard[] = [];
function startWakeLock(opts: WakeLockOptions): WakeGuard {
  const guard = realStart(opts);
  guards.push(guard);
  return guard;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setWakeLock(value: unknown) {
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value });
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("startWakeLock", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setVisibility("visible");
  });
  afterEach(() => {
    guards.splice(0).forEach((g) => g.release());
    vi.restoreAllMocks();
    delete (navigator as { wakeLock?: unknown }).wakeLock;
    document.body.innerHTML = "";
  });

  it("requests the lock synchronously and clears the notice when granted", async () => {
    const lock = sentinel();
    const request = vi.fn(async () => lock);
    setWakeLock({ request });
    const onNotice = vi.fn();
    const guard = startWakeLock({ audioContext: fakeContext() as unknown as AudioContext, onNotice });
    expect(request).toHaveBeenCalledWith("screen"); // before any await
    await flush();
    expect(onNotice).toHaveBeenLastCalledWith(null);
    expect(console.info).toHaveBeenCalledWith("[pib-voice]", "wake lock granted");
    guard.release();
    expect(lock.release).toHaveBeenCalledTimes(1);
    guard.release(); // idempotent
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it("shows a banner but does not throw when the lock is denied", async () => {
    setWakeLock({ request: vi.fn(async () => Promise.reject(new Error("NotAllowedError"))) });
    const onNotice = vi.fn();
    expect(() => startWakeLock({ audioContext: fakeContext() as unknown as AudioContext, onNotice })).not.toThrow();
    await flush();
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Screen may lock"));
    expect(console.warn).toHaveBeenCalledWith("[pib-voice]", "wake lock denied", expect.any(Error));
  });

  it("shows a banner when request throws synchronously", () => {
    setWakeLock({
      request: () => {
        throw new Error("boom");
      },
    });
    const onNotice = vi.fn();
    expect(() => startWakeLock({ audioContext: fakeContext() as unknown as AudioContext, onNotice })).not.toThrow();
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Screen may lock"));
  });

  it("re-acquires after the browser releases the lock and the tab is visible again", async () => {
    const first = sentinel();
    const second = sentinel();
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    setWakeLock({ request });
    const guard = startWakeLock({ audioContext: fakeContext() as unknown as AudioContext, onNotice: vi.fn() });
    await flush();
    setVisibility("hidden");
    first.drop(); // the browser drops it when hidden
    setVisibility("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    guard.release();
    expect(second.release).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(2); // nothing after release
  });

  it("does not request a second lock while one is held", async () => {
    const request = vi.fn(async () => sentinel());
    setWakeLock({ request });
    startWakeLock({ audioContext: fakeContext() as unknown as AudioContext, onNotice: vi.fn() });
    await flush();
    setVisibility("visible");
    expect(request).toHaveBeenCalledTimes(1);
  });

  describe("fallback video", () => {
    beforeEach(() => {
      HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ fillRect: vi.fn(), fillStyle: "" })) as never;
      (HTMLCanvasElement.prototype as unknown as { captureStream: unknown }).captureStream = vi.fn(() => ({
        getTracks: () => [{ stop: vi.fn() }],
      }));
      HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
      HTMLMediaElement.prototype.pause = vi.fn();
    });

    it("starts a muted inline video, with no audio, when the Wake Lock API is missing", () => {
      const onNotice = vi.fn();
      const guard = startWakeLock({ audioContext: fakeContext() as unknown as AudioContext, onNotice });
      const video = document.querySelector("video")!;
      expect(video).toBeTruthy();
      expect(video.muted).toBe(true);
      expect(video.hasAttribute("playsinline")).toBe(true);
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Screen may lock"));
      guard.release();
      expect(document.querySelector("video")).toBeNull();
    });

    it("starts the video when the lock is denied", async () => {
      setWakeLock({ request: vi.fn(async () => Promise.reject(new Error("denied"))) });
      startWakeLock({ audioContext: fakeContext() as unknown as AudioContext, onNotice: vi.fn() });
      await flush();
      expect(document.querySelector("video")).toBeTruthy();
    });

    it("skips the video when the audio context is not running at all", () => {
      startWakeLock({ audioContext: fakeContext("interrupted") as unknown as AudioContext, onNotice: vi.fn() });
      expect(document.querySelector("video")).toBeNull();
    });

    it("stops the video when the audio context leaves running", () => {
      const ctx = fakeContext();
      startWakeLock({ audioContext: ctx as unknown as AudioContext, onNotice: vi.fn() });
      expect(document.querySelector("video")).toBeTruthy();
      ctx.fire("suspended");
      expect(document.querySelector("video")).toBeNull();
    });

    it("keeps the call going with a banner when video playback is refused", async () => {
      HTMLMediaElement.prototype.play = vi.fn(async () => Promise.reject(new Error("NotAllowedError")));
      const onNotice = vi.fn();
      startWakeLock({ audioContext: fakeContext() as unknown as AudioContext, onNotice });
      await flush();
      expect(document.querySelector("video")).toBeNull();
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Screen may lock"));
    });
  });
});
