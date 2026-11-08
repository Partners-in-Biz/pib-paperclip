import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderController, previewUrl, type RenderApi } from "../src/ui/editor/render-controller.js";

const job = (status: string, extra: Record<string, unknown> = {}) => ({ id: "r1", status, ...extra });

function make(statuses: unknown[], over: Partial<RenderApi> = {}) {
  const seq = [...statuses];
  const api = {
    render: vi.fn(async () => job("queued")),
    status: vi.fn(async () => seq.shift() ?? job("rendering")),
    cancel: vi.fn(async () => ({ render: job("cancelled"), cancelled: true })),
    ...over,
  } as RenderApi & { render: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  return { api, ctl: createRenderController(api) };
}

describe("render panel controller (PAR-8316)", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("queued -> rendering -> succeeded, polling every 3 s then stopping", async () => {
    const { api, ctl } = make([job("rendering"), job("succeeded", { assetId: "a1", preview: { url: "https://x/p.mp4" } })]);
    await ctl.start("e1", 4);
    expect(api.render).toHaveBeenCalledWith({ editId: "e1", baseRevision: 4 });
    expect(ctl.getState().job?.status).toBe("queued");
    await vi.advanceTimersByTimeAsync(2999);
    expect(api.status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ctl.getState().job?.status).toBe("rendering");
    await vi.advanceTimersByTimeAsync(3000);
    expect(ctl.getState().job).toMatchObject({ status: "succeeded", assetId: "a1" });
    expect(previewUrl(ctl.getState().job)).toBe("https://x/p.mp4");
    await vi.advanceTimersByTimeAsync(30000);
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  it("queued -> rendering -> failed shows the stored error and stops", async () => {
    const { api, ctl } = make([job("rendering"), job("failed", { error: "ffmpeg exited 1: no such font" })]);
    await ctl.start("e1", 1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(ctl.getState().job).toMatchObject({ status: "failed", error: "ffmpeg exited 1: no such font" });
    await vi.advanceTimersByTimeAsync(30000);
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  it("stops polling on dispose (unmount)", async () => {
    const { api, ctl } = make([]);
    await ctl.start("e1", 1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.status).toHaveBeenCalledTimes(1);
    ctl.dispose();
    await vi.advanceTimersByTimeAsync(30000);
    expect(api.status).toHaveBeenCalledTimes(1);
  });

  it("ignores a status answer that lands after dispose", async () => {
    let release: (v: unknown) => void = () => {};
    const { api, ctl } = make([], { status: vi.fn(() => new Promise((r) => (release = r))) as never });
    await ctl.start("e1", 1);
    await vi.advanceTimersByTimeAsync(3000);
    ctl.dispose();
    release(job("rendering"));
    await vi.advanceTimersByTimeAsync(30000);
    expect(api.status).toHaveBeenCalledTimes(1);
  });

  it("cancel calls the action and stops polling", async () => {
    const { api, ctl } = make([]);
    await ctl.start("e1", 1);
    await ctl.cancel();
    expect(api.cancel).toHaveBeenCalledWith({ renderId: "r1" });
    expect(ctl.getState().job?.status).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(30000);
    expect(api.status).not.toHaveBeenCalled();
  });

  it("shows a start refusal and keeps polling through a failed status check", async () => {
    const { ctl } = make([], { render: vi.fn(async () => { throw new Error("2 renders are already waiting."); }) as never });
    await ctl.start("e1", 1);
    expect(ctl.getState()).toMatchObject({ job: null, starting: false, error: "2 renders are already waiting." });
    const m = make([], { status: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(job("succeeded", { assetId: "a" })) as never });
    await m.ctl.start("e1", 1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(m.ctl.getState().error).toBe("offline");
    await vi.advanceTimersByTimeAsync(3000);
    expect(m.ctl.getState()).toMatchObject({ error: null, job: { status: "succeeded" } });
  });

  it("refuses a second start while one is active", async () => {
    const { api, ctl } = make([]);
    await ctl.start("e1", 1);
    await ctl.start("e1", 1);
    expect(api.render).toHaveBeenCalledTimes(1);
    ctl.dispose();
  });
});
