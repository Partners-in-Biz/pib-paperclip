import { describe, expect, it } from "vitest";
import { batchKeyOf, createRateLimiter, EspBatcher } from "../../src/esp/limiter.js";
import { MockEmailProvider } from "../../src/esp/mock.js";
import type { EspEmail } from "../../src/esp/types.js";

function clock(start = 0) {
  let now = start;
  const slept: number[] = [];
  return { now: () => now, slept, advance: (ms: number) => void (now += ms), sleep: async (ms: number) => void (slept.push(ms), (now += ms)) };
}

describe("rate limiter", () => {
  it("lets a second's worth through at once, then makes callers wait their turn", async () => {
    const c = clock();
    const limiter = createRateLimiter({ perSecond: 4, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 4; i += 1) expect(await limiter.acquire()).toBe(true);
    expect(c.slept).toEqual([]);
    expect(await limiter.acquire()).toBe(true);
    expect(c.slept).toEqual([250]);
  });

  it("refills with time", async () => {
    const c = clock();
    const limiter = createRateLimiter({ perSecond: 2, now: c.now, sleep: c.sleep });
    await limiter.acquire();
    await limiter.acquire();
    c.advance(1000);
    await limiter.acquire();
    await limiter.acquire();
    expect(c.slept).toEqual([]);
  });

  it("tells a caller that would wait too long instead of holding it, and does not use up the turn", async () => {
    const c = clock();
    // Callers that arrive together: the clock does not move while they wait.
    const limiter = createRateLimiter({ perSecond: 1, now: c.now, sleep: async () => undefined, maxWaitMs: 1500 });
    expect(await limiter.acquire()).toBe(true);
    expect(await limiter.acquire()).toBe(true);
    expect(await limiter.acquire()).toBe(false);
    c.advance(1000);
    expect(await limiter.acquire()).toBe(true);
  });

  it("honours a pause the provider asked for (429 retry-after), capped at a minute", async () => {
    const c = clock();
    const limiter = createRateLimiter({ perSecond: 10, now: c.now, sleep: c.sleep, maxWaitMs: 5000 });
    limiter.pause(3);
    expect(await limiter.acquire()).toBe(true);
    expect(c.slept).toEqual([3000]);
    limiter.pause(9999);
    expect(await limiter.acquire()).toBe(false);
  });
});

function email(n: number, from = "Hi <hello@updates.client.co.za>"): EspEmail {
  return { from, to: [`p${n}@x.co`], subject: `s${n}`, text: "t", idempotencyKey: `k${n}` };
}

/** A timer that runs when the test says so: a batcher waits for company until its window ends. */
function manualTimers() {
  const pending: Array<() => void> = [];
  return { setTimer: (fn: () => void) => void pending.push(fn), fire: () => void pending.splice(0).forEach((fn) => fn()) };
}

describe("batching", () => {
  it("sends messages that arrive together as one batch, with one answer each, and a lone message as an ordinary send", async () => {
    const provider = new MockEmailProvider();
    const timers = manualTimers();
    const batcher = new EspBatcher(provider, { setTimer: timers.setTimer });
    const waiting = [batcher.submit(email(1), "d"), batcher.submit(email(2), "d"), batcher.submit(email(3), "d")];
    timers.fire();
    const answers = await Promise.all(waiting);
    expect(answers).toEqual([expect.objectContaining({ ok: true, batched: true }), expect.objectContaining({ ok: true, batched: true }), expect.objectContaining({ ok: true, batched: true })]);
    expect(provider.calls).toEqual(["sendBatch"]);
    expect(provider.batches).toEqual([{ key: batchKeyOf([email(1), email(2), email(3)]), size: 3 }]);
    expect(new Set(answers.map((a) => (a.ok ? a.id : ""))).size).toBe(3);

    const lone = batcher.submit(email(4), "d");
    timers.fire();
    expect(await lone).toMatchObject({ ok: true, batched: false });
    expect(provider.calls).toEqual(["sendBatch", "send"]);
  });

  it("keeps different sending domains in different batches, and flushes at 100", async () => {
    const provider = new MockEmailProvider();
    const timers = manualTimers();
    const batcher = new EspBatcher(provider, { setTimer: timers.setTimer });
    const waiting = [batcher.submit(email(1), "a.co"), batcher.submit(email(2), "a.co"), batcher.submit(email(3), "b.co")];
    timers.fire();
    await Promise.all(waiting);
    expect(provider.calls).toEqual(["sendBatch", "send"]);
    const many = Array.from({ length: 100 }, (_v, i) => batcher.submit(email(100 + i), "a.co"));
    // The hundredth message flushes without waiting for the window.
    const answers = await Promise.all(many);
    expect(answers.every((a) => a.ok)).toBe(true);
    expect(provider.batches.at(-1)!.size).toBe(100);
  });

  it("sends a batch the provider rejected as a whole message by message, so one bad message fails alone", async () => {
    const provider = new MockEmailProvider();
    provider.failNext({ kind: "rejected", status: 422, code: "validation_error", error: "one field is wrong" });
    const timers = manualTimers();
    const batcher = new EspBatcher(provider, { setTimer: timers.setTimer });
    const waiting = [batcher.submit(email(1), "d"), batcher.submit(email(2), "d")];
    timers.fire();
    const answers = await Promise.all(waiting);
    expect(answers).toEqual([expect.objectContaining({ ok: true, batched: false }), expect.objectContaining({ ok: true, batched: false })]);
    expect(provider.calls).toEqual(["sendBatch", "send", "send"]);
  });

  it("asks again ONCE with the same batch key when a batch gets no answer, and gives up with batched unknown rather than sending the messages one by one", async () => {
    const provider = new MockEmailProvider();
    provider.failNext({ kind: "unknown", error: "no answer" }, 2);
    const timers = manualTimers();
    const batcher = new EspBatcher(provider, { setTimer: timers.setTimer });
    const waiting = [batcher.submit(email(1), "d"), batcher.submit(email(2), "d")];
    timers.fire();
    const answers = await Promise.all(waiting);
    expect(answers).toEqual([expect.objectContaining({ ok: false, kind: "unknown", batched: true }), expect.objectContaining({ ok: false, kind: "unknown", batched: true })]);
    expect(provider.calls).toEqual(["sendBatch", "sendBatch"]);
    expect(provider.sent).toEqual([]);
  });

  it("recovers when the second ask of an unanswered batch works (the provider returns its first answer for the same key)", async () => {
    const provider = new MockEmailProvider();
    provider.failNext({ kind: "unknown", error: "no answer" });
    const timers = manualTimers();
    const batcher = new EspBatcher(provider, { setTimer: timers.setTimer });
    const waiting = [batcher.submit(email(1), "d"), batcher.submit(email(2), "d")];
    timers.fire();
    expect((await Promise.all(waiting)).every((a) => a.ok)).toBe(true);
    expect(provider.sent).toHaveLength(2);
  });

  it("the batch key does not depend on the order messages arrived in", () => {
    expect(batchKeyOf([email(1), email(2)])).toBe(batchKeyOf([email(2), email(1)]));
    expect(batchKeyOf([email(1), email(2)])).not.toBe(batchKeyOf([email(1), email(3)]));
  });
});
