/**
 * Keeping to the provider's request rate, and sending several messages in one request.
 *
 * Resend allows a team a fixed number of API requests per second (10 by default, counted across every key) and answers
 * 429 above it. `createRateLimiter` is a token bucket for one company's requests: a caller that would have to wait longer
 * than `maxWaitMs` is told so instead of being held, and the sender then defers the message (the plugin that asked retries
 * it later). A 429 with a `retry-after` pauses the bucket for that long.
 *
 * `EspBatcher` turns messages that arrive within a few milliseconds of each other into one `POST /emails/batch` (up to 100,
 * no attachments), grouped by sending domain so one unverified domain cannot fail another's messages. Batching is OFF
 * unless the owner switches it on, because a batch has one idempotency key for all its messages:
 * - a batch the provider rejected as a whole (a bad field in one message) is sent again message by message, each with its own
 *   key, so one bad message cannot hold the others back;
 * - a batch whose outcome is unknown (no answer, a 5xx) is sent again ONCE as the same batch with the same key, which the
 *   provider answers with the first result if it had it. If that also gets no answer, each message is reported `unknown`
 *   with `batched: true`: the Mailbox never sends those again by itself, because a message-by-message retry could deliver
 *   it twice.
 */
import { createHash } from "node:crypto";
import { MAX_BATCH, type EmailProvider, type EspEmail, type SendOutcome } from "./types.js";

export interface RateLimiter {
  /** True when the request may go (after waiting for its turn); false when the turn is further away than `maxWaitMs`. */
  acquire(): Promise<boolean>;
  /** The provider asked for a pause (429 `retry-after`). */
  pause(seconds: number): void;
}

export interface LimiterOptions {
  perSecond: number;
  /** Longest a request waits for its turn. */
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MAX_WAIT_MS = 5_000;
const MAX_PAUSE_SECONDS = 60;

export function createRateLimiter(options: LimiterOptions): RateLimiter {
  const rate = Math.max(1, options.perSecond);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxWait = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  let tokens = rate;
  let last = now();
  let pausedUntil = 0;
  return {
    async acquire() {
      const at = now();
      tokens = Math.min(rate, tokens + ((at - last) / 1000) * rate);
      last = at;
      const paused = Math.max(0, pausedUntil - at);
      // Take the turn now (the balance may go negative) so callers that arrive together queue behind each other.
      tokens -= 1;
      const wait = Math.max(paused, tokens < 0 ? (-tokens / rate) * 1000 : 0);
      if (wait > maxWait) {
        tokens += 1;
        return false;
      }
      if (wait > 0) await sleep(wait);
      return true;
    },
    pause(seconds) {
      const bounded = Math.min(Math.max(0, seconds), MAX_PAUSE_SECONDS);
      pausedUntil = Math.max(pausedUntil, now() + bounded * 1000);
    },
  };
}

const limiters = new Map<string, { perSecond: number; limiter: RateLimiter }>();

/** One limiter per company (the provider counts a team's requests together), rebuilt when the setting changes. */
export function limiterFor(companyId: string, perSecond: number, overrides: Pick<LimiterOptions, "now" | "sleep" | "maxWaitMs"> = {}): RateLimiter {
  const have = limiters.get(companyId);
  if (have && have.perSecond === perSecond) return have.limiter;
  const limiter = createRateLimiter({ perSecond, ...overrides });
  limiters.set(companyId, { perSecond, limiter });
  return limiter;
}

/** The rate the company's limiter runs at now (null: none built yet). */
export function limiterRateFor(companyId: string): number | null {
  return limiters.get(companyId)?.perSecond ?? null;
}

export function forgetLimiters(): void {
  limiters.clear();
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

export type BatchedOutcome = SendOutcome & { batched: boolean };

interface Pending {
  email: EspEmail;
  resolve: (outcome: BatchedOutcome) => void;
}

export interface BatcherOptions {
  /** How long a message waits for company. */
  windowMs?: number;
  maxBatch?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

/** The idempotency key of a whole batch: the same messages in any order give the same key. */
export function batchKeyOf(emails: Array<Pick<EspEmail, "idempotencyKey">>): string {
  return `pib-batch-${createHash("sha256").update(emails.map((email) => email.idempotencyKey).sort().join("\n")).digest("hex").slice(0, 40)}`;
}

export class EspBatcher {
  private readonly groups = new Map<string, { items: Pending[]; timer: unknown }>();
  private readonly windowMs: number;
  private readonly maxBatch: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;

  constructor(private readonly provider: EmailProvider, options: BatcherOptions = {}) {
    this.windowMs = options.windowMs ?? 40;
    this.maxBatch = Math.min(options.maxBatch ?? MAX_BATCH, MAX_BATCH);
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  /** Queues a message (no attachments) and answers when its batch has been sent. `group` is the sending domain. */
  submit(email: EspEmail, group: string): Promise<BatchedOutcome> {
    return new Promise((resolve) => {
      let entry = this.groups.get(group);
      if (!entry) {
        entry = { items: [], timer: null };
        this.groups.set(group, entry);
      }
      entry.items.push({ email, resolve });
      if (entry.items.length >= this.maxBatch) {
        void this.flush(group);
        return;
      }
      if (entry.timer == null) entry.timer = this.setTimer(() => void this.flush(group), this.windowMs);
    });
  }

  /** Sends what is waiting for a group. Never throws: every waiting message gets an answer. */
  async flush(group: string): Promise<void> {
    const entry = this.groups.get(group);
    if (!entry || entry.items.length === 0) return;
    this.groups.delete(group);
    const items = entry.items;
    try {
      await this.sendGroup(items);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const item of items) item.resolve({ ok: false, kind: "unknown", status: null, code: null, error: message.slice(0, 300), batched: items.length > 1 });
    }
  }

  private async sendGroup(items: Pending[]): Promise<void> {
    if (items.length === 1) {
      // Nobody else came: an ordinary send, with its own key.
      const outcome = await this.provider.send(items[0]!.email);
      items[0]!.resolve({ ...outcome, batched: false });
      return;
    }
    const emails = items.map((item) => item.email);
    const key = batchKeyOf(emails);
    let outcome = await this.provider.sendBatch(emails, key);
    if (!outcome.ok && outcome.kind === "unknown") outcome = await this.provider.sendBatch(emails, key);
    if (outcome.ok) {
      items.forEach((item, index) => {
        const id = outcome.ids[index];
        item.resolve(id ? { ok: true, id, batched: true } : { ok: false, kind: "unknown", status: null, code: null, error: "The provider answered the batch without an id for this message", batched: true });
      });
      return;
    }
    if (outcome.kind === "rejected") {
      // One bad message fails the whole request: send them one by one so only that one fails.
      for (const item of items) item.resolve({ ...(await this.provider.send(item.email)), batched: false });
      return;
    }
    for (const item of items) item.resolve({ ...outcome, batched: true });
  }
}
