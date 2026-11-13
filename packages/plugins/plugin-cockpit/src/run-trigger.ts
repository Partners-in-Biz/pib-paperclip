/**
 * What started a run of the Cockpit's own checks, for the one log line each
 * run writes (own.ts, PAR-11071 rule 1): a job, the brief, or a call (a page
 * load, a route, an action). Only that log line reads the label; nothing the
 * Cockpit does depends on it.
 *
 * `boot` is made once per worker start, so lines from one worker can be told
 * from the next one's after a restart.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export type RunTrigger = "job" | "brief" | "call";

const store = new AsyncLocalStorage<RunTrigger>();

/** One id per worker start. */
export const BOOT_ID = randomBytes(6).toString("hex");

/** The label of the current run; `call` when nothing set one. */
export function currentTrigger(): RunTrigger {
  return store.getStore() ?? "call";
}

/** Runs `fn` under `label`, replacing any label already set. */
export function withTrigger<T>(label: RunTrigger, fn: () => T): T {
  return store.run(label, fn);
}

/** Runs `fn` under `label` only when no label is set yet (a brief inside a job stays `job`). */
export function withTriggerIfUnset<T>(label: RunTrigger, fn: () => T): T {
  return store.getStore() === undefined ? store.run(label, fn) : fn();
}

const jobHandlers = new WeakSet<object>();

/** `handler` run under the `job` label; every `ctx.jobs.register` handler goes through it (register.ts). */
export function jobHandler(handler: () => Promise<void>): () => Promise<void> {
  const wrapped = () => withTrigger("job", handler);
  jobHandlers.add(wrapped);
  return wrapped;
}

/** Whether `fn` came from `jobHandler` (the test that every job is labelled). */
export function isJobHandler(fn: unknown): boolean {
  return typeof fn === "function" && jobHandlers.has(fn);
}
