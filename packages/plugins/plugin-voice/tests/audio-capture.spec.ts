// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { MicCapture } from "../src/ui/audio.js";

describe("MicCapture", () => {
  it("releases the mic when stopped before the permission prompt resolves", async () => {
    const track = { stop: vi.fn() };
    let resolve!: (s: unknown) => void;
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => new Promise((r) => (resolve = r)) },
    });
    const mic = new MicCapture({} as AudioContext, () => undefined);
    const started = mic.start();
    mic.stop();
    resolve({ getTracks: () => [track] });
    await started;
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
});
